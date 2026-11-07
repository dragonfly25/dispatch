/** Shared shapes of `dispatch doctor`: one line per check, one report per run. */
import type { DoctorStatus } from "../hosts/_framework/registry.js";

export type { DoctorStatus };

/** One check result. `section` groups lines in the text output ("system", "repo", an instance id, "host", "live"). */
export interface DoctorLine {
  /** Stable id, e.g. "launcher", "codex.login", "live.claude". */
  id: string;
  section: string;
  status: DoctorStatus;
  message: string;
  /** A command or instruction that resolves a warning or failure. */
  fix?: string;
  /** Machine-readable facts (paths, versions, run ids) for `--json`. */
  data?: Record<string, unknown>;
}

/** The `--json` output of `dispatch doctor` (schema version 1). */
export interface DoctorReport {
  schemaVersion: 1;
  /** True when no check failed. */
  ok: boolean;
  /** 0 when `ok`, else 4. */
  exitCode: number;
  summary: Record<DoctorStatus, number>;
  checks: DoctorLine[];
  /** True when the live smoke test ran. */
  live: boolean;
}

type Extra = Pick<DoctorLine, "fix" | "data">;

/** Builds a line of the given status. */
export function mkLine(
  status: DoctorStatus,
  section: string,
  id: string,
  message: string,
  extra: Extra = {},
): DoctorLine {
  return { id, section, status, message, ...extra };
}

/** Counts lines per status. */
export function summarize(lines: readonly DoctorLine[]): DoctorReport["summary"] {
  const summary = { ok: 0, warn: 0, fail: 0 };
  for (const l of lines) summary[l.status]++;
  return summary;
}
