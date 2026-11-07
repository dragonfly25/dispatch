/**
 * Per-instance concurrency leases (plan §2 "Runner"): a run holds one SQLite lease while its
 * child runs, beats every {@link LEASE_HEARTBEAT_MS}, and releases it when the attempt ends.
 */
import { performance } from "node:perf_hooks";
import type { Clock } from "../core/contracts.js";
import type { SqliteStateStore } from "../state/store.js";

/** Heartbeat period of a held lease (the store reaps leases older than 30 s). */
export const LEASE_HEARTBEAT_MS = 5_000;
const POLL_MS = 250;

/** The lease operations of the state store. */
export type LeaseStore = Pick<SqliteStateStore, "acquireLease" | "releaseLease" | "heartbeat">;

/** Start time of this process (epoch ms), stored with every lease to detect pid reuse. */
export const SELF_PID_START = String(Math.round(performance.timeOrigin));

/**
 * Liveness of a lease holder. This process is judged by its start time too; another process only
 * by its pid (its start time is not readable without spawning `ps`), stale heartbeats cover reuse.
 */
export function isProcessAlive(pid: number, pidStart: string): boolean {
  if (pid === process.pid) return pidStart === SELF_PID_START;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Options of {@link acquireLease}. */
export interface AcquireLeaseOptions {
  /** Max concurrent runs of the instance. */
  limit: number;
  clock: Clock;
  /** How long to keep retrying when the instance is full (0: one try). */
  waitMs: number;
  signal?: AbortSignal;
}

/** Takes a concurrency slot for `instanceId`, polling for up to `waitMs`. */
export async function acquireLease(
  store: LeaseStore,
  instanceId: string,
  runId: string,
  opts: AcquireLeaseOptions,
): Promise<boolean> {
  const deadline = opts.clock.monotonicMs() + opts.waitMs;
  for (;;) {
    const ok = store.acquireLease(instanceId, runId, {
      pid: process.pid,
      pidStart: SELF_PID_START,
      limit: opts.limit,
      now: opts.clock.now(),
      isAlive: isProcessAlive,
    });
    if (ok) return true;
    if (opts.signal?.aborted || opts.clock.monotonicMs() >= deadline) return false;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

/** Beats the lease of `runId` until the returned function is called; that call also releases it. */
export function holdLease(store: LeaseStore, runId: string, clock: Clock): () => void {
  const timer = setInterval(() => {
    try {
      store.heartbeat(runId, clock.now());
    } catch {
      // a busy database must not crash the run; the next beat retries
    }
  }, LEASE_HEARTBEAT_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    try {
      store.releaseLease(runId);
    } catch {
      // the lease goes stale and is reaped
    }
  };
}
