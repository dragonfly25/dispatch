/**
 * `wait` and `cancel` for detached runs (plan §2 "Runner", UC3).
 *
 * `wait` only reads the store, so any number of waits on the same run may run at once (Codex may
 * start duplicates, docs/spikes/hosts-prototype.md finding 10). The one write is idempotent: a run
 * whose heartbeat is stale AND whose supervisor is gone is marked failed (`supervisor_lost`).
 * Liveness is judged by pid plus start time (`ps`; Windows: PowerShell `Get-Process`), and a
 * zombie counts as dead.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { basename, isAbsolute, join, win32 } from "node:path";
import type { Clock, NormalizedEvent, RunRecord, RunResult } from "../core/contracts.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { DetectedHost } from "../platform/host.js";
import { isWindows, type OsPlatform } from "../platform/os.js";
import { LEASE_STALE_MS, type SqliteStateStore } from "../state/store.js";
import { CANCELLED, requestCancel } from "./detach.js";
import { fanoutChildId } from "./fanout.js";
import { exitCodeForResult, failedRun } from "./result.js";
import { EVENTS_FILE } from "./runlog.js";
import { killTree, pidExists, type SignalFn, type SyncRun, systemRoot } from "./tree.js";

/** Summary of a run whose supervisor died without recording a result. */
export const SUPERVISOR_LOST = "supervisor_lost";
/** Events shown as progress while a run is still going. */
const PROGRESS_EVENTS = 5;
const POLL_MS = 250;
/** A supervisor starts within this long after its run was recorded (slow CI included). */
const START_WINDOW_MS = 120_000;

/** `wait --timeout` default per host (seconds): Claude Bash tool 120 s, Codex poll ceiling 300 s. */
const HOST_WAIT_SECONDS: Record<DetectedHost, number> = {
  "claude-code": 100,
  codex: 280,
  antigravity: 100,
};

/** Default `wait` timeout in seconds for the detected host; null (unbounded) without a host. */
export function defaultWaitSeconds(host: DetectedHost | null): number | null {
  return host === null ? null : HOST_WAIT_SECONDS[host];
}

/** Liveness check of a supervisor: `(pid, createdAt of its run)`. */
export type SupervisorAlive = (pid: number | null, createdAt: string) => boolean;

type Env = Readonly<Record<string, string | undefined>>;

/** Runs a helper synchronously and returns its stdout; throws (with `status`) when it fails. */
export type ExecSync = (file: string, args: readonly string[], env: Env) => string;

const defaultExec: ExecSync = (file, args, env) =>
  execFileSync(file, [...args], {
    encoding: "utf8",
    env: { ...env },
    shell: false,
    windowsHide: true,
    timeout: 15_000,
    stdio: ["ignore", "pipe", "ignore"],
  });

/** Options of {@link makeSupervisorAlive} (tests inject all of them). */
export interface SupervisorAliveOptions {
  platform?: OsPlatform;
  /** Environment of the PowerShell helper on Windows (locates `%SystemRoot%`). */
  env?: Env;
  exec?: ExecSync;
  kill?: SignalFn;
}

/** Absolute path of Windows PowerShell 5.1 (always present) from `%SystemRoot%`. */
export function powershellPath(env: Env = process.env, platform: OsPlatform = process.platform) {
  return win32.join(
    systemRoot(env, platform),
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

/**
 * PowerShell arguments printing the UTC start time (ISO 8601) of `pid`, nothing when the process
 * does not exist, and `unknown` when its start time is not readable. `pid` must be a validated
 * positive integer: it is the only value interpolated into the script.
 */
export function startTimeArgs(pid: number): string[] {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`invalid pid: ${pid}`);
  const script =
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; ` +
    `if ($p) { try { $p.StartTime.ToUniversalTime().ToString('o') } catch { 'unknown' } }`;
  return ["-NoProfile", "-NonInteractive", "-Command", script];
}

/** True when a process that started at `startMs` may be the supervisor of a run created then. */
function inStartWindow(startMs: number, createdAt: string): boolean {
  const created = Date.parse(createdAt);
  // `lstart` has one-second resolution.
  return startMs >= created - 2_000 && startMs <= created + START_WINDOW_MS;
}

/**
 * Builds a {@link SupervisorAlive}: true when `pid` is a live, non-zombie process that started
 * within the start window of a run created at `createdAt` (so a recycled pid does not count).
 * The start time comes from `ps` (POSIX) or PowerShell `Get-Process` (Windows, absolute path);
 * when the helper is unavailable or its answer unreadable, the bare pid check decides.
 */
export function makeSupervisorAlive(o: SupervisorAliveOptions = {}): SupervisorAlive {
  const platform = o.platform ?? process.platform;
  const exec = o.exec ?? defaultExec;
  const kill: SignalFn = o.kill ?? ((pid, sig) => process.kill(pid, sig));
  return (pid, createdAt) => {
    if (pid === null || !pidExists(pid, kill)) return false;
    if (isWindows(platform)) {
      let out: string;
      try {
        out = exec(
          powershellPath(o.env, platform),
          startTimeArgs(pid),
          o.env ?? process.env,
        ).trim();
      } catch {
        return true; // PowerShell unavailable: trust the pid check
      }
      if (out === "") return false;
      const startMs = Date.parse(out);
      return Number.isNaN(startMs) ? true : inStartWindow(startMs, createdAt);
    }
    let line: string;
    try {
      line = exec("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
        PATH: "/bin:/usr/bin",
        LC_ALL: "C",
      }).trim();
    } catch (err) {
      // ps exits 1 when the pid is gone; any other failure: trust the signal check.
      return (err as { status?: number }).status !== 1;
    }
    if (line === "") return false;
    const [stat = "", ...rest] = line.split(/\s+/);
    if (stat.startsWith("Z")) return false;
    const startMs = Date.parse(rest.join(" "));
    return Number.isNaN(startMs) ? true : inStartWindow(startMs, createdAt);
  };
}

/** {@link SupervisorAlive} of the running OS. See {@link makeSupervisorAlive}. */
export const supervisorAlive: SupervisorAlive = makeSupervisorAlive();

/** Store operations of `wait` / `cancel`. */
export type WaitStore = Pick<SqliteStateStore, "getRun" | "updateRun" | "listEvents"> &
  Partial<Pick<SqliteStateStore, "getRunDir">>;

/** Dependencies of {@link waitForRun} and {@link cancelRun}. */
export interface WaitDeps {
  store: WaitStore;
  clock: Clock;
  /**
   * Fallback lookup of a run's directory (null if unknown), used when the store has none recorded
   * for it (runs written before the `run_dir` column). See {@link locateRunDir}.
   */
  runDir?: (runId: string) => string | null;
  /** Default {@link supervisorAlive}. */
  isAlive?: SupervisorAlive;
  /** A heartbeat older than this is stale (default 30 s). */
  staleMs?: number;
  /** Poll period (default 250 ms). */
  pollMs?: number;
}

/** What `wait` reports while the run is still going (exit 75). */
export interface RunningStatus {
  schemaVersion: 1;
  runId: string;
  status: "running";
  outcome: null;
  /** The latest normalized events of the run (and of its fanout children). */
  progress: NormalizedEvent[];
}

/** Outcome of {@link waitForRun}: the final result or the running status, and the exit code. */
export interface WaitOutcome {
  result: RunResult | RunningStatus;
  exitCode: ExitCode;
}

/**
 * Directory of a run, without creating it: inside `repoRoot/.dispatch` when present there, else
 * under the Dispatch home. Null when neither exists.
 */
export function findRunDir(repoRoot: string | null, dispatchHome: string, runId: string) {
  const candidates = [
    ...(repoRoot ? [join(repoRoot, ".dispatch", "state", "runs", runId)] : []),
    join(dispatchHome, "runs", runId),
  ];
  return candidates.find((d) => existsSync(d)) ?? null;
}

/**
 * Directory of a run, independent of the cwd: the one recorded with the run when it still exists
 * as a real directory named after the run, else `deps.runDir` (the cwd-based {@link findRunDir}
 * lookup, for older rows). Null when neither knows it.
 */
export function locateRunDir(
  deps: Pick<WaitDeps, "store" | "runDir">,
  runId: string,
): string | null {
  return storedRunDir(deps.store, runId) ?? deps.runDir?.(runId) ?? null;
}

function storedRunDir(store: WaitStore, runId: string): string | null {
  try {
    const dir = store.getRunDir?.(runId) ?? null;
    if (!dir || !isAbsolute(dir) || basename(dir) !== runId) return null;
    // lstat: a symlink planted in place of the run dir is not followed.
    return lstatSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

async function getOrThrow(store: WaitStore, runId: string): Promise<RunRecord> {
  const run = await store.getRun(runId);
  if (!run) throw new DispatchError(`unknown run: ${runId}`, ExitCode.USAGE, "run.unknown");
  return run;
}

/** Ends a run that has no result yet with `summary` (failed) and returns that result. */
async function endRun(deps: WaitDeps, run: RunRecord, summary: string): Promise<RunResult> {
  const dir = locateRunDir(deps, run.runId);
  const result: RunResult = {
    schemaVersion: 1,
    runId: run.runId,
    ...failedRun(summary),
    log: { path: dir ? join(dir, EVENTS_FILE) : EVENTS_FILE },
    decisions: [],
    durationMs: Math.max(0, deps.clock.now().getTime() - Date.parse(run.createdAt)),
  };
  await deps.store.updateRun(run.runId, { status: result.status, result });
  return result;
}

function isLost(deps: WaitDeps, run: RunRecord): boolean {
  const age = deps.clock.now().getTime() - Date.parse(run.updatedAt);
  if (age <= (deps.staleMs ?? LEASE_STALE_MS)) return false;
  return !(deps.isAlive ?? supervisorAlive)(run.pid, run.createdAt);
}

function progress(store: WaitStore, runId: string): NormalizedEvent[] {
  const own = store.listEvents(runId);
  // Fanout children (`<runId>-f<n>`) carry the agents' events; a fanout has a handful of targets.
  const children = Array.from({ length: 8 }, (_, i) => store.listEvents(fanoutChildId(runId, i)));
  return [...own, ...children.flat()]
    .sort((a, b) => a.ts.localeCompare(b.ts))
    .slice(-PROGRESS_EVENTS);
}

/**
 * Polls the store until the run ends or `timeoutMs` passes (null: no limit). A finished run gives
 * its result and mapped exit code; a run still going at the deadline gives a
 * {@link RunningStatus} and exit 75; a stale run whose supervisor is gone is marked
 * `supervisor_lost` (failed). Unknown run ids throw (exit 2).
 */
export async function waitForRun(
  deps: WaitDeps,
  runId: string,
  timeoutMs: number | null,
): Promise<WaitOutcome> {
  const deadline = timeoutMs === null ? null : deps.clock.monotonicMs() + timeoutMs;
  for (;;) {
    const run = await getOrThrow(deps.store, runId);
    if (run.status !== "running" && run.result) {
      return { result: run.result, exitCode: exitCodeForResult(run.result) };
    }
    if (isLost(deps, run)) {
      const result = await endRun(deps, run, `${SUPERVISOR_LOST}: the supervisor died`);
      return { result, exitCode: exitCodeForResult(result) };
    }
    if (deadline !== null && deps.clock.monotonicMs() >= deadline) {
      const status: RunningStatus = {
        schemaVersion: 1,
        runId,
        status: "running",
        outcome: null,
        progress: progress(deps.store, runId),
      };
      return { result: status, exitCode: ExitCode.STILL_RUNNING };
    }
    const left = deadline === null ? Number.POSITIVE_INFINITY : deadline - deps.clock.monotonicMs();
    await new Promise((r) => setTimeout(r, Math.max(1, Math.min(deps.pollMs ?? POLL_MS, left))));
  }
}

/** Options of {@link cancelRun}. */
export interface CancelOptions {
  /** How long to wait for the supervisor to clean up after SIGTERM (default 20 s). */
  graceMs?: number;
  /** Signal sender (tests). */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** OS whose cancel path is used (tests). Default `process.platform`. */
  platform?: OsPlatform;
  /** Runs `taskkill` on Windows (tests). */
  run?: SyncRun;
  /** Environment locating `%SystemRoot%` on Windows (tests). Default `process.env`. */
  env?: Env;
  /** Receives a one-line notice when the cancel cannot run as usual (the CLI prints it). */
  onNotice?: (message: string) => void;
}

/**
 * Cancels a detached run: writes the cancel request file into its run directory and (POSIX) sends
 * SIGTERM to its supervisor (after the pid + start time check). The supervisor kills the agent's
 * process tree, releases the lease, disposes the worktree and records the run as failed with
 * summary `cancelled`. The run directory comes from the store (see {@link locateRunDir}), so the
 * cwd of `cancel` does not matter. A supervisor that does not finish within the grace period is
 * killed (SIGKILL; Windows: `taskkill /T /F`) and the run is marked cancelled here. On Windows,
 * when no request file could be written, the grace is still observed (the supervisor's liveness is
 * polled, it may finish by itself) and `onNotice` says so. A finished run is returned unchanged.
 */
export async function cancelRun(
  deps: WaitDeps,
  runId: string,
  opts: CancelOptions = {},
): Promise<RunResult> {
  const alive = deps.isAlive ?? supervisorAlive;
  const kill = opts.kill ?? ((pid, sig) => process.kill(pid, sig));
  let run = await getOrThrow(deps.store, runId);
  if (run.status !== "running" && run.result) return run.result;
  const pid = run.pid;
  const win = isWindows(opts.platform ?? process.platform);
  const dir = locateRunDir(deps, runId);
  // Also covers a supervisor that has not recorded its pid yet: it checks the file at start.
  const requested = dir !== null && requestCancel(dir, deps.clock.now());
  if (pid !== null && alive(pid, run.createdAt)) {
    const send = (sig: NodeJS.Signals) => {
      if (win) {
        if (sig === "SIGKILL") {
          killTree(pid, {
            force: true,
            platform: "win32",
            ...(opts.run ? { run: opts.run } : {}),
            ...(opts.env ? { env: opts.env } : {}),
          });
        }
        return; // "SIGTERM" would be TerminateProcess on Windows: the request file asks instead
      }
      try {
        kill(pid, sig);
      } catch {
        // already gone
      }
    };
    const grace = opts.graceMs ?? 20_000;
    if (win && !requested) {
      opts.onNotice?.(
        `run directory of ${runId} not found, no cancel request could be written; waiting up to ` +
          `${Math.ceil(grace / 1000)} s for the supervisor to exit before force-killing it ` +
          "(taskkill /T /F; a force-killed supervisor may leave its worktree behind, its lease " +
          "expires after 30 s)",
      );
    }
    send("SIGTERM");
    const deadline = deps.clock.monotonicMs() + grace;
    for (;;) {
      run = await getOrThrow(deps.store, runId);
      if (run.status !== "running" && run.result) return run.result;
      if (!alive(pid, run.createdAt)) break;
      if (deps.clock.monotonicMs() >= deadline) {
        send("SIGKILL");
        break;
      }
      await new Promise((r) => setTimeout(r, deps.pollMs ?? POLL_MS));
    }
    run = await getOrThrow(deps.store, runId);
    if (run.status !== "running" && run.result) return run.result;
  }
  return endRun(deps, run, CANCELLED);
}
