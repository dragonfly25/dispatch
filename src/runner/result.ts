/**
 * Building blocks of a {@link RunResult} shared by the single, fallback and fanout paths, plus the
 * mapping from a result to the CLI exit code (`run`, `wait`).
 */
import {
  EXTERNAL_AGENT_MARKER,
  ExitCode,
  type PatchInfo,
  type RunResult,
} from "../core/contracts.js";
import type { AttemptReport } from "./attempt.js";

/** Longest summary handed back to the host (characters). */
export const MAX_SUMMARY_CHARS = 8 * 1024;

/** The fields of a result that depend on how the run ended. */
export type ResultParts = Pick<
  RunResult,
  "status" | "outcome" | "summary" | "externalAgent" | "patch"
> &
  Pick<Partial<RunResult>, "usage" | "results">;

/** Caps `text` at {@link MAX_SUMMARY_CHARS}, saying how much was cut. */
export function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS)}\n…[truncated ${text.length - MAX_SUMMARY_CHARS} chars]`;
}

/** A run refused by policy (router reject, recursion guard). */
export function rejected(summary: string): ResultParts {
  return { status: "rejected", outcome: "rejected", summary, externalAgent: null, patch: null };
}

/** The task goes back to the host, which proceeds natively (spec §2.7). */
export function toHost(outcome: RunResult["outcome"], summary: string): ResultParts {
  return { status: "returned_to_host", outcome, summary, externalAgent: null, patch: null };
}

/** A run that ended without an external result: cancelled, or its supervisor died. */
export function failedRun(summary: string): ResultParts {
  return { status: "completed", outcome: "failed", summary, externalAgent: null, patch: null };
}

/**
 * The patch reported to the host: the real one; or, when every change was rejected by the filter,
 * an empty one (no file, `diffstat` "", `applies: false`: there is nothing to apply) that still
 * lists `rejectedPaths`, so the host sees what was dropped (spec §9 rule 6). No change at all: null.
 */
export function reportedPatch(result: AttemptReport["patch"]): PatchInfo | null {
  if (!result) return null;
  if (!result.empty) return result.patch;
  if (result.patch.rejectedPaths.length === 0) return null;
  return { ...result.patch, diffstat: "", applies: false };
}

/** The result of an attempt that spawned an agent (its outcome is set). */
export function completed(report: AttemptReport): ResultParts {
  const out = report.outcome as NonNullable<AttemptReport["outcome"]>;
  const patch = reportedPatch(report.patch);
  return {
    status: "completed",
    outcome: out.outcome,
    summary: out.summary,
    externalAgent: {
      provider: report.adapterId ?? report.target.instance,
      instance: report.target.instance,
      model: report.target.model,
      marker: EXTERNAL_AGENT_MARKER,
    },
    patch,
    usage: out.usage,
  };
}

/**
 * Exit code of `run` / `wait` for `result`: 0 success or returned to host, 3 rejected, 4 failed,
 * 5 quota exhausted, 6 timeout, 75 still running.
 */
export function exitCodeForResult(result: Pick<RunResult, "status" | "outcome">): ExitCode {
  if (result.status === "running") return ExitCode.STILL_RUNNING;
  if (result.status === "rejected") return ExitCode.REJECTED;
  if (result.status === "returned_to_host") return ExitCode.OK;
  switch (result.outcome) {
    case "success":
      return ExitCode.OK;
    case "rejected":
      return ExitCode.REJECTED;
    case "quota_exhausted":
      return ExitCode.QUOTA;
    case "timeout":
      return ExitCode.TIMEOUT_OR_STATE;
    default:
      return ExitCode.FAILED;
  }
}
