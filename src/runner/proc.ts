import { type ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { systemClock } from "../core/clock.js";
import type { Clock, Spawner, SpawnRequest, SpawnResult } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Longest line (in UTF-16 code units) handed to `onLine`; the rest of the line is dropped. */
export const MAX_LINE_LENGTH = 1024 * 1024;
/** Appended to a line that was cut at {@link MAX_LINE_LENGTH}. */
export const TRUNCATION_MARKER = " …[truncated]";

const DEFAULT_KILL_GRACE_MS = 10_000;
const POLL_MS = 25;
/** Longest single timer for the timeout; the monotonic clock is re-read after each one. */
const MAX_TIMER_MS = 250;
/** How long to wait for the pipes to close after the group is gone (a detached escapee may hold them). */
const CLOSE_WAIT_MS = 250;

/** Constructor options of {@link ProcessSpawner}; both exist for tests. */
export interface ProcessSpawnerOptions {
  /** Monotonic time source for timeouts and kill grace. Defaults to `performance.now()`. */
  clock?: Pick<Clock, "monotonicMs">;
  /** Overrides {@link MAX_LINE_LENGTH}. */
  maxLineLength?: number;
}

/** Splits a text stream into lines: handles partial chunks, CRLF and over-long lines. */
class LineSplitter {
  private buf = "";
  private truncated = false;

  constructor(
    private readonly max: number,
    private readonly emit: (line: string) => void,
  ) {}

  push(text: string): void {
    let start = 0;
    for (;;) {
      const nl = text.indexOf("\n", start);
      if (nl < 0) {
        this.append(text.slice(start));
        return;
      }
      this.append(text.slice(start, nl));
      this.endLine();
      start = nl + 1;
    }
  }

  /** Emits a final line that has no trailing newline. */
  flush(): void {
    if (this.buf.length > 0 || this.truncated) this.endLine();
  }

  private append(s: string): void {
    if (this.truncated) return;
    this.buf += s;
    if (this.buf.length > this.max) {
      this.buf = this.buf.slice(0, this.max);
      this.truncated = true;
    }
  }

  private endLine(): void {
    let line = this.buf;
    if (!this.truncated && line.endsWith("\r")) line = line.slice(0, -1);
    this.emit(this.truncated ? line + TRUNCATION_MARKER : line);
    this.buf = "";
    this.truncated = false;
  }
}

/** A running child's process group, as seen by the parent-signal handlers. */
interface ActiveGroup {
  /** SIGTERM now, SIGKILL after the grace period; resolves when the group is gone. */
  reap(): Promise<void>;
  /** SIGKILL immediately and synchronously. */
  killNow(): void;
}

const active = new Set<ActiveGroup>();
const PARENT_SIGNALS = ["SIGINT", "SIGTERM"] as const;
let handlersInstalled = false;
let shuttingDown = false;

function onParentSignal(sig: NodeJS.Signals): void {
  if (shuttingDown) {
    for (const group of active) group.killNow(); // second Ctrl-C: no more patience
    return;
  }
  shuttingDown = true;
  void Promise.all([...active].map((g) => g.reap())).then(() => {
    shuttingDown = false;
    // Only re-raise when nobody else handles the signal, so the default action still happens.
    if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
  });
}

function onParentExit(): void {
  for (const group of active) group.killNow();
}

const signalListeners = PARENT_SIGNALS.map((sig) => [sig, () => onParentSignal(sig)] as const);

function register(group: ActiveGroup): void {
  active.add(group);
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [sig, fn] of signalListeners) process.on(sig, fn);
  process.on("exit", onParentExit);
}

function unregister(group: ActiveGroup): void {
  active.delete(group);
  if (active.size > 0 || !handlersInstalled) return;
  handlersInstalled = false;
  for (const [sig, fn] of signalListeners) process.off(sig, fn);
  process.off("exit", onParentExit);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Sends `sig` to the whole process group of `pgid`; false when the group no longer exists. */
function signalGroup(pgid: number, sig: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real {@link Spawner}: runs the child as the leader of a new process group (`setsid` semantics via
 * `detached: true`), without a shell and with exactly `req.env`. On timeout, abort, parent SIGINT or
 * SIGTERM the whole group gets SIGTERM, and SIGKILL after `killGraceMs`. Strays left behind by a
 * child that exited on its own are reaped the same way, so no orphans survive a finished spawn.
 */
export class ProcessSpawner implements Spawner {
  private readonly clock: Pick<Clock, "monotonicMs">;
  private readonly maxLineLength: number;

  constructor(opts: ProcessSpawnerOptions = {}) {
    this.clock = opts.clock ?? systemClock;
    this.maxLineLength = opts.maxLineLength ?? MAX_LINE_LENGTH;
  }

  spawn(req: SpawnRequest): Promise<SpawnResult> {
    if (req.signal?.aborted) {
      return Promise.resolve({ exitCode: null, signal: null, timedOut: false });
    }
    return new Promise<SpawnResult>((resolve, reject) => this.run(req, resolve, reject));
  }

  private run(
    req: SpawnRequest,
    resolve: (r: SpawnResult) => void,
    reject: (e: unknown) => void,
  ): void {
    const { clock } = this;
    const graceMs = req.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const startedAt = clock.monotonicMs();

    const child: ChildProcess = spawn(req.binary, [...req.argv], {
      cwd: req.cwd,
      env: { ...req.env },
      detached: true,
      shell: false,
      windowsHide: true,
      stdio: [req.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });

    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let terminating: Promise<void> | undefined;

    const pgid = child.pid;
    /** SIGTERM the group, wait for it to vanish, SIGKILL after the grace. Idempotent. */
    const reap = (): Promise<void> => {
      if (pgid === undefined) return Promise.resolve();
      terminating ??= (async () => {
        if (!signalGroup(pgid, 0)) return;
        signalGroup(pgid, "SIGTERM");
        const deadline = clock.monotonicMs() + graceMs;
        while (signalGroup(pgid, 0) && clock.monotonicMs() < deadline) await sleep(POLL_MS);
        if (signalGroup(pgid, "SIGKILL")) {
          for (let i = 0; i < 80 && signalGroup(pgid, 0); i++) await sleep(POLL_MS);
        }
      })();
      return terminating;
    };
    const group: ActiveGroup = {
      reap,
      killNow: () => {
        if (pgid !== undefined) signalGroup(pgid, "SIGKILL");
      },
    };

    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const emit = (stream: "stdout" | "stderr") => (line: string) => {
      try {
        req.onLine?.(stream, line);
      } catch {
        // A faulty consumer must not crash the supervisor or leave the child unattended.
      }
    };
    const splitters = {
      stdout: new LineSplitter(this.maxLineLength, emit("stdout")),
      stderr: new LineSplitter(this.maxLineLength, emit("stderr")),
    };
    for (const stream of ["stdout", "stderr"] as const) {
      child[stream]?.on("data", (chunk: Buffer) => {
        splitters[stream].push(decoders[stream].write(chunk));
      });
    }

    const onAbort = (): void => {
      void reap();
    };
    const armTimeout = (): void => {
      const remaining = (req.timeoutMs ?? 0) - (clock.monotonicMs() - startedAt);
      if (remaining <= 0) {
        timedOut = true;
        void reap();
        return;
      }
      // Never trust one long timer: re-check the monotonic clock regularly (and when it fires early).
      timer = setTimeout(
        armTimeout,
        Math.min(MAX_TIMER_MS, Math.max(POLL_MS, Math.ceil(remaining))),
      );
    };

    let closed = false;
    let onClosed: (() => void) | undefined;
    child.on("close", () => {
      closed = true;
      onClosed?.();
    });

    /** Waits for the pipes to close, but not forever: a detached escapee may still hold them. */
    const waitClosed = (): Promise<void> =>
      new Promise<void>((done) => {
        const t = setTimeout(done, CLOSE_WAIT_MS);
        onClosed = () => {
          clearTimeout(t);
          done();
        };
      });

    child.on("error", (err) => {
      // 'error' without a pid means the spawn itself failed (missing binary, bad cwd).
      cleanup();
      reject(
        new DispatchError(
          `failed to spawn ${req.binary}: ${err.message}`,
          undefined,
          "spawn.failed",
          { cause: err },
        ),
      );
    });

    child.on("exit", (exitCode, signal) => {
      if (timer) clearTimeout(timer);
      void (async () => {
        await reap(); // strays in the group
        if (!closed) await waitClosed();
        child.stdout?.destroy();
        child.stderr?.destroy();
        for (const stream of ["stdout", "stderr"] as const) {
          splitters[stream].push(decoders[stream].end());
          splitters[stream].flush();
        }
        cleanup();
        resolve({ exitCode, signal, timedOut });
      })();
    });

    function cleanup(): void {
      if (timer) clearTimeout(timer);
      req.signal?.removeEventListener("abort", onAbort);
      unregister(group);
    }

    if (child.pid === undefined) return; // spawn failed: 'error' is emitted on the next tick
    register(group);
    if (req.signal) req.signal.addEventListener("abort", onAbort, { once: true });
    if (req.timeoutMs !== undefined) armTimeout();
    if (req.stdin !== undefined && child.stdin) {
      child.stdin.on("error", () => {}); // EPIPE: the child did not want its input
      child.stdin.end(req.stdin);
    }
  }
}
