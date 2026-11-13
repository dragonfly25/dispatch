/**
 * Minimal newline-delimited JSON-RPC client over a long-lived child's stdio (used by the codex
 * `app-server` quota reader). Responses are correlated by id; notifications and unparsable lines
 * are ignored; requests from the server are answered with "method not found". The child's process
 * tree (POSIX: its own process group; Windows: `taskkill /T`) is terminated when the session ends,
 * times out or is aborted.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { OsPlatform } from "../platform/os.js";
import { spawnCommandFor, type ToSpawn } from "./spawn.js";
import { type ProcessTree, processTree, spawnDetachedFor } from "./tree.js";

/** Options of {@link runRpcSession}. */
export interface RpcSessionOptions {
  binary: string;
  argv: readonly string[];
  /** Full environment of the child (no inheritance). */
  env: Readonly<Record<string, string>>;
  cwd: string;
  /** Budget for the whole session, in ms. */
  timeoutMs: number;
  /** Aborting ends the session like a timeout. */
  signal?: AbortSignal;
  /** Time a child gets to exit after stdin closes before SIGTERM (default 300 ms). */
  politeMs?: number;
  /** Time between SIGTERM and SIGKILL (default 1 000 ms). */
  killGraceMs?: number;
  /** OS whose spawn shape and tree termination are used (tests). Default `process.platform`. */
  platform?: OsPlatform;
  /** Builds the {@link ProcessTree} of the child's pid (tests). Default {@link processTree}. */
  tree?: (pid: number) => ProcessTree;
  /** Spawn-shape conversion (tests). Default `toSpawnCommand`. */
  toSpawn?: ToSpawn;
}

/** The server answered a request with a JSON-RPC error object. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** The session did not finish within its budget. */
export class RpcTimeoutError extends Error {
  override readonly name = "RpcTimeoutError";
}

/** Handle given to the session body. */
export interface RpcSession {
  /** Sends a request and resolves with its `result` (rejects with {@link RpcError}). */
  request(method: string, params?: unknown): Promise<unknown>;
  /** Sends a notification (no response expected). */
  notify(method: string, params?: unknown): void;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref());

/**
 * Spawns the child, runs `body` against it and always tears the child's process group down
 * afterwards. Rejects when the child cannot start, exits early, the budget runs out, or `body`
 * throws.
 */
export async function runRpcSession<T>(
  opts: RpcSessionOptions,
  body: (session: RpcSession) => Promise<T>,
): Promise<T> {
  const platform = opts.platform ?? process.platform;
  const cmd = spawnCommandFor(opts.binary, opts.argv, platform, opts.toSpawn);
  const child = spawn(cmd.command, cmd.args, {
    cwd: opts.cwd,
    env: { ...opts.env },
    detached: spawnDetachedFor(platform),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let hasExited = false;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      hasExited = true;
      resolve();
    }),
  );
  let fail!: (err: Error) => void;
  const dead = new Promise<never>((_, reject) => {
    fail = reject;
  });
  dead.catch(() => {});
  child.once("error", (err) => fail(new Error(`failed to start ${opts.binary}: ${err.message}`)));
  child.once("exit", (code, sig) =>
    fail(new Error(`${opts.binary} exited (${sig ?? code}) before the exchange finished`)),
  );
  child.stdin.on("error", () => {});
  child.stderr.resume();

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const write = (msg: Json): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // not JSON: ignore
    }
    if (!isObject(msg)) return;
    const { id } = msg;
    if (typeof msg.method === "string") {
      if (id !== undefined && id !== null) {
        write({ id, error: { code: -32601, message: `Method not found: ${msg.method}` } });
      }
      return; // notification
    }
    if (typeof id !== "number") return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (isObject(msg.error)) {
      const { code, message, data } = msg.error;
      waiter.reject(
        new RpcError(
          typeof message === "string" ? message : "rpc error",
          typeof code === "number" ? code : 0,
          data,
        ),
      );
    } else {
      waiter.resolve(msg.result);
    }
  });

  let nextId = 1;
  const session: RpcSession = {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, ...(params === undefined ? {} : { params }) });
      });
    },
    notify(method, params) {
      write({ method, ...(params === undefined ? {} : { params }) });
    },
  };

  const timer = setTimeout(
    () => fail(new RpcTimeoutError(`${opts.binary} timed out after ${opts.timeoutMs} ms`)),
    opts.timeoutMs,
  );
  const onAbort = (): void => fail(new Error("aborted"));
  if (opts.signal?.aborted) onAbort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  let ok = false;
  const run = body(session);
  run.catch(() => {});
  try {
    const value = await Promise.race([run, dead]);
    ok = true;
    return value;
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    const pid = child.pid;
    const tree =
      pid === undefined ? undefined : (opts.tree ?? ((p) => processTree(p, { platform })))(pid);
    await terminate(tree, exited, () => hasExited, child.stdin, ok, opts);
  }
}

/**
 * Ends the session: stdin EOF (when healthy), then a polite request to the whole tree, then a
 * forced kill. A tree that cannot outlive its root (Windows) is left alone once the root exited.
 */
async function terminate(
  tree: ProcessTree | undefined,
  exited: Promise<void>,
  hasExited: () => boolean,
  stdin: NodeJS.WritableStream,
  polite: boolean,
  opts: RpcSessionOptions,
): Promise<void> {
  if (tree === undefined) return;
  const gone = () => hasExited() && !tree.outlivesRoot;
  if (polite) {
    stdin.end();
    await Promise.race([exited, delay(opts.politeMs ?? 300)]);
  }
  if (gone()) return;
  if (tree.terminate()) await Promise.race([exited, delay(opts.killGraceMs ?? 1_000)]);
  if (gone()) return;
  tree.kill();
}
