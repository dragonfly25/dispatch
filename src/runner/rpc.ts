/**
 * Minimal newline-delimited JSON-RPC client over a long-lived child's stdio (used by the codex
 * `app-server` quota reader). Responses are correlated by id; notifications and unparsable lines
 * are ignored; requests from the server are answered with "method not found". The child runs in
 * its own process group and the whole group is terminated when the session ends, times out or is
 * aborted.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

/** Sends `signal` to the child's process group; ignores groups that are already gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: nothing left in the group.
  }
}

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
  const child = spawn(opts.binary, [...opts.argv], {
    cwd: opts.cwd,
    env: { ...opts.env },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
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
    await terminate(child.pid, exited, child.stdin, ok, opts);
  }
}

/** Ends the session: stdin EOF (when healthy), then SIGTERM, then SIGKILL of the whole group. */
async function terminate(
  pid: number | undefined,
  exited: Promise<void>,
  stdin: NodeJS.WritableStream,
  polite: boolean,
  opts: RpcSessionOptions,
): Promise<void> {
  if (pid === undefined) return;
  if (polite) {
    stdin.end();
    await Promise.race([exited, delay(opts.politeMs ?? 300)]);
  }
  signalGroup(pid, "SIGTERM");
  await Promise.race([exited, delay(opts.killGraceMs ?? 1_000)]);
  signalGroup(pid, "SIGKILL");
}
