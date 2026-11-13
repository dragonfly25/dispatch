/**
 * Terminating a child together with everything it started (the "process tree"), per OS.
 *
 * - POSIX: the child leads its own process group (`detached: true`), so the whole group is
 *   signalled with `kill(-pgid, sig)`: SIGTERM first, SIGKILL after a grace. The group can still
 *   be signalled after its leader exited (strays keep it alive).
 * - Windows: there are no process groups or POSIX signals. The tree is ended with
 *   `%SystemRoot%\System32\taskkill.exe /PID <pid> /T` (polite) and `/T /F` (forced), started by
 *   absolute path (never a PATH lookup) and without a shell. `taskkill /T` walks the tree from a
 *   live root, so once the root has exited its descendants can no longer be found; pids are also
 *   recycled, so nothing is sent to a root that is known to have exited.
 *
 * Every OS decision takes an explicit `platform` so the Windows branch is unit-testable.
 */
import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { envGet, isWindows, type OsPlatform } from "../platform/os.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Runs a helper executable synchronously and returns its exit status (null: did not run). */
export type SyncRun = (command: string, args: readonly string[]) => number | null;

/** Sends a signal to a pid (POSIX: negative for a group); `process.kill` semantics. */
export type SignalFn = (pid: number, signal: NodeJS.Signals | 0) => unknown;

/** Default {@link SyncRun}: no shell, hidden window, bounded time, output discarded. */
export const runSync: SyncRun = (command, args) => {
  const r = spawnSync(command, [...args], {
    shell: false,
    windowsHide: true,
    stdio: "ignore",
    timeout: 10_000,
  });
  return r.error ? null : r.status;
};

/** `%SystemRoot%` (Windows directory), defaulting to `C:\Windows`. */
export function systemRoot(
  env: Env = process.env,
  platform: OsPlatform = process.platform,
): string {
  return envGet(env, "SystemRoot", platform) ?? envGet(env, "windir", platform) ?? "C:\\Windows";
}

/** Absolute path of `taskkill.exe` from `%SystemRoot%`. */
export function taskkillPath(env: Env = process.env, platform: OsPlatform = process.platform) {
  return win32.join(systemRoot(env, platform), "System32", "taskkill.exe");
}

/** Arguments of `taskkill` for the tree rooted at `pid`. */
export function taskkillArgs(pid: number, force: boolean): string[] {
  return ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])];
}

/** Options of {@link killTree} and {@link processTree}. */
export interface TreeOptions {
  platform?: OsPlatform;
  /** Environment that locates `%SystemRoot%` (Windows). Default `process.env`. */
  env?: Env;
  /** Helper runner (Windows `taskkill`). Default {@link runSync}. */
  run?: SyncRun;
  /** Signal sender. Default `process.kill`. */
  kill?: SignalFn;
}

/** Options of {@link killTree}. */
export interface KillTreeOptions extends TreeOptions {
  /** SIGKILL / `taskkill /F` instead of SIGTERM / polite `taskkill`. */
  force: boolean;
}

const defaultKill: SignalFn = (pid, sig) => process.kill(pid, sig);

/**
 * Ends the tree (POSIX: process group) rooted at `pid`. True when the request was delivered:
 * on POSIX the group existed; on Windows `taskkill` exited 0. A polite `taskkill` fails for
 * console programs ("can only be terminated forcefully"), which callers treat as a reason to
 * force at once. Synchronous, so it is usable from an `exit` handler.
 */
export function killTree(pid: number, opts: KillTreeOptions): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const platform = opts.platform ?? process.platform;
  if (isWindows(platform)) {
    const run = opts.run ?? runSync;
    return run(taskkillPath(opts.env, platform), taskkillArgs(pid, opts.force)) === 0;
  }
  try {
    (opts.kill ?? defaultKill)(-pid, opts.force ? "SIGKILL" : "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `pid` (a single process) exists: signal 0 succeeds, or fails with EPERM (it exists but
 * belongs to someone else). Works on Windows too, where Node maps signal 0 to an existence check.
 */
export function pidExists(pid: number, kill: SignalFn = defaultKill): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A spawned child and its descendants, as one unit to watch and terminate. */
export interface ProcessTree {
  /**
   * True when the tree can still be addressed after its root exited (POSIX process groups).
   * False on Windows: after the root's exit nothing is sent (the pid may be recycled).
   */
  readonly outlivesRoot: boolean;
  /** True while the tree (POSIX: any group member; Windows: the root) is alive. */
  alive(): boolean;
  /** Polite request (SIGTERM / `taskkill /T`); false when it could not be delivered. */
  terminate(): boolean;
  /** Forced, synchronous (SIGKILL / `taskkill /T /F`); false when nothing was killed. */
  kill(): boolean;
}

/** The {@link ProcessTree} of a child spawned with {@link spawnDetachedFor}`(platform)`. */
export function processTree(pid: number, opts: TreeOptions = {}): ProcessTree {
  const platform = opts.platform ?? process.platform;
  const kill = opts.kill ?? defaultKill;
  const win = isWindows(platform);
  return {
    outlivesRoot: !win,
    alive: () => {
      if (win) return pidExists(pid, kill);
      try {
        kill(-pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    terminate: () => killTree(pid, { ...opts, force: false }),
    kill: () => killTree(pid, { ...opts, force: true }),
  };
}

/**
 * Value of spawn's `detached` for a child that must die with Dispatch. POSIX: true, so the child
 * leads a new process group that can be signalled as a whole. Windows: false; `detached` there
 * would give the child its own (new) console and keep it out of the console's Ctrl-C, and the
 * tree is ended with `taskkill /T` instead of a group signal.
 */
export function spawnDetachedFor(platform: OsPlatform = process.platform): boolean {
  return !isWindows(platform);
}
