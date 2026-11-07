/**
 * Declared subscription plans -> quota windows and a rough capacity per window, in "relative cost
 * units" (see estimator.ts). THE NUMBERS BELOW ARE ESTIMATES, not published limits: providers do
 * not document exact allowances and change them. They only feed the fallback estimator (spec §8,
 * source 2) and can be overridden from config via {@link mergePlans}.
 */
import { z } from "zod";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** One window of a plan. */
export const PlanWindowSchema = z.object({
  /** Window label; must match the `kind` the readers report (e.g. "5h", "7d", "weekly"). */
  kind: z.string().min(1),
  durationMs: z.number().int().positive(),
  /** Estimated allowance of the window, in relative cost units. */
  capacity: z.number().positive(),
  /**
   * Model globs (`*` wildcard) this window counts, for plans with per-model-group windows (agy).
   * Absent = every model.
   */
  models: z.array(z.string().min(1)).optional(),
});
export type PlanWindow = z.infer<typeof PlanWindowSchema>;

/** A plan as declared by the user at setup (Pro, Max 5x, Plus, ...). */
export const PlanSpecSchema = z.object({
  adapter: z.string().min(1),
  plan: z.string().min(1),
  label: z.string().min(1),
  windows: z.array(PlanWindowSchema),
});
export type PlanSpec = z.infer<typeof PlanSpecSchema>;

/** Plan table keyed by `adapter:plan`. */
export type PlanTable = Readonly<Record<string, PlanSpec>>;

const win = (kind: string, durationMs: number, capacity: number, models?: string[]): PlanWindow =>
  models ? { kind, durationMs, capacity, models } : { kind, durationMs, capacity };
const plan = (adapter: string, id: string, label: string, windows: PlanWindow[]): PlanSpec => ({
  adapter,
  plan: id,
  label,
  windows,
});

const GEMINI = ["gemini-*"];
const CLAUDE_GPT = ["claude-*", "gpt-*"];
/** agy windows are reported per model group; each group gets a 5h and a weekly bucket. */
const agyWindows = (scale: number): PlanWindow[] => [
  win("5h:gemini", 5 * HOUR_MS, 50 * scale, GEMINI),
  win("5h:claude-gpt", 5 * HOUR_MS, 30 * scale, CLAUDE_GPT),
  win("weekly:gemini", 7 * DAY_MS, 500 * scale, GEMINI),
  win("weekly:claude-gpt", 7 * DAY_MS, 300 * scale, CLAUDE_GPT),
];

/** Built-in plan table (ESTIMATES; capacities in relative cost units). */
export const DEFAULT_PLANS: PlanTable = Object.fromEntries(
  [
    plan("claude", "pro", "Claude Pro", [win("5h", 5 * HOUR_MS, 40), win("7d", 7 * DAY_MS, 400)]),
    plan("claude", "max5x", "Claude Max 5x", [
      win("5h", 5 * HOUR_MS, 200),
      win("7d", 7 * DAY_MS, 2_000),
    ]),
    plan("claude", "max20x", "Claude Max 20x", [
      win("5h", 5 * HOUR_MS, 800),
      win("7d", 7 * DAY_MS, 8_000),
    ]),
    plan("codex", "plus", "ChatGPT Plus", [
      win("5h", 5 * HOUR_MS, 60),
      win("weekly", 7 * DAY_MS, 600),
    ]),
    // ChatGPT Pro: no 5h window is modelled, only the weekly one.
    plan("codex", "pro", "ChatGPT Pro", [win("weekly", 7 * DAY_MS, 3_000)]),
    plan("codex", "business", "ChatGPT Business", [
      win("5h", 5 * HOUR_MS, 100),
      win("weekly", 7 * DAY_MS, 1_000),
    ]),
    plan("antigravity", "pro", "Google AI Pro", agyWindows(1)),
    plan("antigravity", "ultra", "Google AI Ultra", agyWindows(4)),
  ].map((p) => [`${p.adapter}:${p.plan}`, p]),
);

/** Adapter id aliases accepted in declared plans (the CLI is called `agy`). */
const ADAPTER_ALIASES: Readonly<Record<string, string>> = { agy: "antigravity" };

/**
 * Plan-table key for a declared plan. `declared` is either `plan` (resolved against the instance's
 * `adapter`) or already `adapter:plan`.
 */
export function planKey(adapter: string, declared: string): string {
  const full = (declared.includes(":") ? declared : `${adapter}:${declared}`).toLowerCase();
  const [a = "", ...rest] = full.split(":");
  return [ADAPTER_ALIASES[a] ?? a, ...rest].join(":");
}

/** Looks up a declared plan; `undefined` when unknown (the estimator then stays silent). */
export function resolvePlan(
  table: PlanTable,
  adapter: string,
  declared: string | undefined,
): PlanSpec | undefined {
  return declared === undefined ? undefined : table[planKey(adapter, declared)];
}

/**
 * Layers config overrides (keyed `adapter:plan`) over `base`. An override replaces the entry with
 * the same key entirely; new keys add custom plans. Overrides are validated, so a bad config
 * fails loudly.
 */
export function mergePlans(
  base: PlanTable,
  overrides: Readonly<Record<string, unknown>>,
): PlanTable {
  const merged: Record<string, PlanSpec> = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    merged[planKey("", key)] = PlanSpecSchema.parse(value);
  }
  return merged;
}

/** Longest window duration in `table`; bounds how much run history the estimator needs. */
export function longestWindowMs(table: PlanTable): number {
  return Math.max(0, ...Object.values(table).flatMap((p) => p.windows.map((x) => x.durationMs)));
}

/** True when `model` matches any of the `*` globs (case-insensitive); no globs = any model. */
export function modelMatches(
  globs: readonly string[] | undefined,
  model: string | undefined,
): boolean {
  if (!globs) return true;
  if (!model) return false;
  const m = model.toLowerCase();
  return globs.some((g) => {
    const body = g
      .toLowerCase()
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${body}$`).test(m);
  });
}
