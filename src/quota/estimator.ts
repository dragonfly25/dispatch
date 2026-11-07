/**
 * Fallback estimator (spec §8, source 2): projects the delegated runs Dispatch recorded onto the
 * windows of the user's declared plan. Output is always `reliability: "estimated"`.
 *
 * Model: a run costs `units = relativeCost * weight`, where weight comes from reported tokens, or
 * else from duration. A window opens at the first run after the previous window ended and lasts
 * `durationMs` (this matches provider "5h from first message" windows; for calendar-anchored
 * windows it is an approximation). Used % = units in the open window / plan capacity.
 *
 * The HOST instance is never estimated: its interactive session consumes quota Dispatch cannot see
 * (spec §8), so a number derived from Dispatch's own runs would be wrong.
 */
import type { QuotaWindow } from "../core/contracts.js";
import { modelMatches, type PlanSpec, type PlanWindow } from "./plans.js";

/** Source label of estimated windows. */
export const ESTIMATOR_SOURCE = "estimator";

/** One delegated run as seen by the estimator. */
export interface EstimatorRun {
  /** ISO UTC start time of the run. */
  at: string;
  durationMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  model?: string | undefined;
  /** Relative cost of the run's tier (1 = cheapest), from the adapter's model table. */
  relativeCost: number;
}

/** Tunables of the unit model. */
export interface EstimatorTuning {
  /** Tokens that weigh one unit at relativeCost 1 (default 10 000). */
  tokensPerUnit?: number;
  /** Milliseconds that weigh one unit when no tokens are reported (default 60 000). */
  msPerUnit?: number;
  /** Minimum units of any run (default 0.1). */
  minUnits?: number;
}

export interface EstimateOptions extends EstimatorTuning {
  now: Date;
  /** The host instance is never estimated: the result is then empty. */
  isHost: boolean;
}

/** Units a run consumes. */
export function runUnits(run: EstimatorRun, tuning: EstimatorTuning = {}): number {
  const tokensPerUnit = tuning.tokensPerUnit ?? 10_000;
  const msPerUnit = tuning.msPerUnit ?? 60_000;
  const minUnits = tuning.minUnits ?? 0.1;
  const tokens = (run.inputTokens ?? 0) + (run.outputTokens ?? 0);
  const weight = tokens > 0 ? tokens / tokensPerUnit : Math.max(0, run.durationMs) / msPerUnit;
  return Math.max(minUnits, weight * run.relativeCost);
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

function estimateWindow(
  pw: PlanWindow,
  runs: readonly EstimatorRun[],
  opts: EstimateOptions,
): QuotaWindow {
  const nowMs = opts.now.getTime();
  const relevant = runs
    .filter((r) => modelMatches(pw.models, r.model) && Date.parse(r.at) <= nowMs)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  let start: number | null = null;
  let used = 0;
  for (const run of relevant) {
    const t = Date.parse(run.at);
    if (start === null || t >= start + pw.durationMs) {
      start = t;
      used = 0;
    }
    used += runUnits(run, opts);
  }
  const open = start !== null && start + pw.durationMs > nowMs;
  return {
    kind: pw.kind,
    usedPct: open ? round1(Math.min(100, (used / pw.capacity) * 100)) : 0,
    resetAt: open && start !== null ? new Date(start + pw.durationMs).toISOString() : null,
    source: ESTIMATOR_SOURCE,
    readAt: opts.now.toISOString(),
    reliability: "estimated",
  };
}

/**
 * Estimated windows of one (non-host) instance. `runs` must already be filtered to the instance.
 * Returns `[]` for the host.
 */
export function estimateWindows(
  plan: PlanSpec,
  runs: readonly EstimatorRun[],
  opts: EstimateOptions,
): QuotaWindow[] {
  if (opts.isHost) return [];
  return plan.windows.map((pw) => estimateWindow(pw, runs, opts));
}
