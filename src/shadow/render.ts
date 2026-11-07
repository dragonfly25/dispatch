/**
 * Deterministic text rendering of a {@link CompareResult} for `status --compare`. The JSON form is
 * the result object itself.
 */
import type { CompareResult, ProfileStats } from "./compare.js";

const fmt = (n: number): string => String(Math.round(n * 100) / 100);

function pad(cells: readonly string[], widths: readonly number[]): string {
  return cells
    .map((c, i) => (i === 0 ? c.padEnd(widths[i] ?? 0) : c.padStart(widths[i] ?? 0)))
    .join("  ")
    .trimEnd();
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => pad(r, widths));
}

const HEADER = [
  "profile",
  "tasks",
  "delegated",
  "host",
  "reject",
  "fallback",
  "fell-through",
  "rel.cost",
];

function row(p: ProfileStats): string[] {
  const real = p.realTasks.value > 0 ? "*" : "";
  return [
    `${p.profile}${real}`,
    fmt(p.tasks.value),
    fmt(p.delegated.value),
    fmt(p.hostKept.value),
    fmt(p.rejected.value),
    fmt(p.fallbackMode.value),
    p.fellThrough ? fmt(p.fellThrough.value) : "n/a",
    fmt(p.relativeCost.value),
  ];
}

/** Renders the comparison as text. Same result in, same text out. */
export function renderCompare(result: CompareResult): string {
  const window =
    result.since === null && result.until === null
      ? "all recorded decisions"
      : `${result.since ?? "start"} to ${result.until ?? "now"}`;
  const lines = [`Dispatch status --compare (${window})`];
  if (result.empty) {
    lines.push(
      result.message ?? "no recorded decisions",
      "Nothing was executed; there is nothing to estimate.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `Real decisions: ${result.decisions}. All figures are ESTIMATED from recorded decision snapshots.`,
    "",
    ...table([HEADER, ...result.profiles.map(row)]),
    "",
    "Per instance (planned delegations, estimated relative cost):",
  );
  for (const p of result.profiles) {
    const parts = p.instances.map(
      (i) => `${i.instance} x${fmt(i.delegated.value)} (cost ${fmt(i.relativeCost.value)})`,
    );
    lines.push(`  ${p.profile}: ${parts.length > 0 ? parts.join(", ") : "-"}`);
  }
  const notes = ["* = profile that was active for some of these decisions (the real routing)"];
  if (result.profiles.some((p) => p.fellThrough === null)) {
    notes.push("n/a = profile never ran for real, so fall-throughs cannot be observed");
  }
  const unpriced = result.profiles.reduce((n, p) => n + p.unpricedTargets.value, 0);
  if (unpriced > 0)
    notes.push(`${unpriced} planned target(s) could not be priced and are not in rel.cost`);
  lines.push("", ...notes, "Host consumption: not observable", "");
  return lines.join("\n");
}
