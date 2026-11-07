/**
 * Fanout, the "second opinion" (spec §7, UC7): every target of the decision runs concurrently,
 * each as a child run with its own id, run directory, worktree, log and lease. Nothing is merged:
 * the parent result lists one child result per target, each tagged with its external agent and
 * carrying its own patch. The parent succeeds when at least one child succeeded; otherwise the
 * task returns to the host (spec §2.7).
 */
import type { DecisionTarget, RunResult } from "../core/contracts.js";
import { redact } from "../state/redact.js";
import { type AttemptReport, type RunContext, runAttempt } from "./attempt.js";
import { completed, type ResultParts, toHost, truncate } from "./result.js";
import { RunLog, resolveRunDir } from "./runlog.js";

/** Run id of the `index`-th (0-based) child of a fanout run. */
export function fanoutChildId(parentRunId: string, index: number): string {
  return `${parentRunId}-f${index + 1}`;
}

async function runChild(rc: RunContext, target: DecisionTarget, index: number): Promise<RunResult> {
  const { clock, store } = rc.deps;
  const started = clock.monotonicMs();
  const runId = fanoutChildId(rc.runId, index);
  const runDir = resolveRunDir(rc.repoRoot, rc.dispatchHome, runId);
  const log = new RunLog(runDir, () => rc.secrets);
  const createdAt = clock.now().toISOString();
  await store.recordRun({
    runId,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    instance: target.instance,
    pid: process.pid,
    result: null,
  });
  log.write({ type: "fanout.child", parent: rc.runId, target });
  // Each child is the only (hence last) attempt of its own run: it may wait for a lease.
  const report: AttemptReport = await runAttempt({ ...rc, runId, runDir, log }, target, 0, true);
  const parts: ResultParts = report.outcome
    ? completed(report)
    : toHost(null, `${target.instance}: ${report.note}`);
  const result: RunResult = {
    schemaVersion: 1,
    runId,
    ...parts,
    summary: truncate(redact(parts.summary, rc.secrets)),
    log: { path: log.path },
    decisions: [],
    durationMs: Math.max(0, clock.monotonicMs() - started),
  };
  if (result.usage === undefined) delete result.usage;
  await store.updateRun(runId, {
    status: result.status,
    instance: target.instance,
    result,
  });
  return result;
}

/**
 * Runs every target of a fanout decision concurrently and aggregates the children. Each child
 * respects its instance's concurrency limit (bounded wait for a lease, then skipped).
 */
export async function runFanout(
  rc: RunContext,
  targets: readonly DecisionTarget[],
): Promise<ResultParts> {
  const results = await Promise.all(targets.map((t, i) => runChild(rc, t, i)));
  const line = (r: RunResult, t: DecisionTarget | undefined) =>
    `${t?.instance ?? "?"}: ${r.outcome ?? r.status}`;
  const lines = results.map((r, i) => line(r, targets[i]));
  if (results.some((r) => r.outcome === "success")) {
    return {
      status: "completed",
      outcome: "success",
      summary:
        `fanout (second opinion): ${results.length} independent results, nothing merged; ` +
        `review each one in results[] (${lines.join("; ")})`,
      externalAgent: null,
      patch: null,
      results,
    };
  }
  const last = results.findLast((r) => r.outcome !== null)?.outcome ?? null;
  const why = rc.signal.aborted ? "interrupted" : "no fanout target succeeded";
  return { ...toHost(last, `${why}: ${lines.join("; ")}`), results };
}
