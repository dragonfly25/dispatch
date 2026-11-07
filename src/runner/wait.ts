/**
 * `wait` and `cancel` for detached runs (plan §2 "Runner", UC3).
 *
 * `wait` only reads the store, so any number of waits on the same run may run at once (Codex may
 * start duplicates, docs/spikes/hosts-prototype.md finding 10). The one write is idempotent: a run
 * whose heartbeat is stale AND whose supervisor is gone is marked failed (`supervisor_lost`).
 * Liveness is judged by pid plus start time (`ps`), and a zombie counts as dead.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Clock, NormalizedEvent, RunRecord, RunResult } from "../core/contracts.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { DetectedHost } from "../platform/host.js";
import { LEASE_STALE_MS, type SqliteStateStore } from "../state/store.js";
import { CANCELLED } from "./detach.js";
import { fanoutChildId } from "./fanout.js";
import { exitCodeForResult, failedRun } from "./result.js";
import { EVENTS_FILE } from "./runlog.js";

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

/**
 * True when `pid` is a live, non-zombie process that started within the start window of a run
 * created at `createdAt` (so a recycled pid does not count). Falls back to the bare pid check
 * when `ps` is unavailable.
 */
export const supervisorAlive: SupervisorAlive = (pid, createdAt) => {
  if (pid === null || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let line: string;
  try {
    line = execFileSync("ps", ["-o", "stat=,lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { PATH: "/bin:/usr/bin", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch (err) {
    // ps exits 1 when the pid is gone; any other failure: trust the signal check.
    return (err as { status?: number }).status !== 1;
  }
  if (line === "") return false;
  const [stat = "", ...rest] = line.split(/\s+/);
  if (stat.startsWith("Z")) return false;
  const startMs = Date.parse(rest.join(" "));
  if (Number.isNaN(startMs)) return true;
  const created = Date.parse(createdAt);
  // `lstart` has one-second resolution.
  return startMs >= created - 2_000 && startMs <= created + START_WINDOW_MS;
};

/** Store operations of `wait` / `cancel`. */
export type WaitStore = Pick<SqliteStateStore, "getRun" | "updateRun" | "listEvents">;

/** Dependencies of {@link waitForRun} and {@link cancelRun}. */
export interface WaitDeps {
  store: WaitStore;
  clock: Clock;
  /** Run directory of a run id, for the log path of results written here (null if unknown). */
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

async function getOrThrow(store: WaitStore, runId: string): Promise<RunRecord> {
  const run = await store.getRun(runId);
  if (!run) throw new DispatchError(`unknown run: ${runId}`, ExitCode.USAGE, "run.unknown");
  return run;
}

/** Ends a run that has no result yet with `summary` (failed) and returns that result. */
async function endRun(deps: WaitDeps, run: RunRecord, summary: string): Promise<RunResult> {
  const dir = deps.runDir?.(run.runId) ?? null;
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
}

/**
 * Cancels a detached run: SIGTERM to its supervisor (after the pid + start time check), which
 * kills the agent's process group, releases the lease, disposes the worktree and records the run
 * as failed with summary `cancelled`. A supervisor that does not finish within the grace period
 * gets SIGKILL and the run is marked cancelled here. A finished run is returned unchanged.
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
  if (pid !== null && alive(pid, run.createdAt)) {
    const send = (sig: NodeJS.Signals) => {
      try {
        kill(pid, sig);
      } catch {
        // already gone
      }
    };
    send("SIGTERM");
    const deadline = deps.clock.monotonicMs() + (opts.graceMs ?? 20_000);
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
