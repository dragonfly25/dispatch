/**
 * Compare aggregator behind `status --compare` (UC8, plan deviation 14).
 *
 * Aggregates recorded decisions per routing profile: the real decisions (under the profile that
 * was active) and the shadow decisions (what the other profiles would have done on the same
 * snapshot). Every figure is derived from recorded data and labelled `estimated: true`; nothing
 * is executed and nothing is invented. With no data the result says so explicitly.
 */
import type {
  Decision,
  DecisionInput,
  DecisionRecord,
  DecisionTarget,
  RunRecord,
} from "../core/contracts.js";
import { type RoutingConfig, RoutingConfigSchema } from "../core/routing.js";
import type { ShadowRecord, SqliteStateStore } from "../state/store.js";

const EPOCH = "1970-01-01T00:00:00.000Z";
const UNKNOWN_PROFILE = "(unknown)";
const MAX_RUNS = 100_000;

/** A figure derived from recorded data, never measured. */
export interface Est {
  value: number;
  estimated: true;
}

/** A {@link Est} that also says over how many runs it could be observed. */
export interface ObservedEst extends Est {
  observedRuns: number;
}

/** Relative cost of one planned target, or null when the stored input cannot price it. */
export type CostModel = (input: DecisionInput, target: DecisionTarget) => number | null;

const configCache = new WeakMap<object, RoutingConfig | null>();

function routingOf(input: DecisionInput): RoutingConfig | null {
  const cached = configCache.get(input.routing);
  if (cached !== undefined) return cached;
  const parsed = RoutingConfigSchema.safeParse(input.routing);
  const cfg = parsed.success ? parsed.data : null;
  configCache.set(input.routing, cfg);
  return cfg;
}

/**
 * Default cost model: `relativeCost` of the target's tier in the stored input's `routing.models`
 * (for the adapter of the target's instance). Null when the input has no such entry.
 */
export const relativeCostModel: CostModel = (input, target) => {
  const cfg = routingOf(input);
  const adapter = cfg?.instances.find((i) => i.id === target.instance)?.adapter;
  return (adapter && cfg?.models[adapter]?.tiers[target.tier]?.relativeCost) || null;
};

export interface InstanceStats {
  instance: string;
  delegated: Est;
  /** Sum of relative costs of the planned targets on this instance. */
  relativeCost: Est;
}

export interface ProfileStats {
  profile: string;
  /** Decisions evaluated under this profile (real and shadow). */
  tasks: Est;
  /** Of `tasks`, those where this profile was the active one (the real routing). */
  realTasks: Est;
  /** Decisions that delegate to at least one instance. */
  delegated: Est;
  /** Decisions that keep the task on the host. */
  hostKept: Est;
  rejected: Est;
  /** Decisions whose mode is `fallback`. */
  fallbackMode: Est;
  /**
   * Real attempts that fell through to the next target or back to the host, as shown by the real
   * runs' history. Null for a profile that never ran for real (nothing to observe).
   */
  fellThrough: ObservedEst | null;
  /** Total relative cost of the planned targets (see {@link plannedTargets}). */
  relativeCost: Est;
  /** Planned targets the cost model could not price; they are not in `relativeCost`. */
  unpricedTargets: Est;
  instances: InstanceStats[];
}

export interface CompareResult {
  /** True when no decision falls in the window; `profiles` is then empty. */
  empty: boolean;
  /** "no recorded decisions" when `empty`, else null. */
  message: string | null;
  since: string | null;
  until: string | null;
  /** Number of real decisions in the window. */
  decisions: number;
  /** One entry per profile, sorted by name. */
  profiles: ProfileStats[];
  /** The host's own consumption is not visible to Dispatch (spec §8). */
  hostConsumption: "not observable";
  estimated: true;
}

export interface CompareInput {
  /** Real decisions from the store. */
  decisions: readonly DecisionRecord[];
  /** Shadow decisions from the store; rows of decisions outside the window are ignored. */
  shadow: readonly ShadowRecord[];
  runs: readonly RunRecord[];
  /** Window start, inclusive (ISO UTC). */
  since?: string;
  /** Window end, exclusive (ISO UTC). */
  until?: string;
  costModel?: CostModel;
}

const est = (value: number): Est => ({ value, estimated: true });
const ms = (t: string): number => new Date(t).getTime();

/**
 * Targets that count towards usage and cost: all of them for a fanout (every one runs), only the
 * first for single and fallback (later fallback targets run only if the earlier ones fall through,
 * which is counted separately in `fellThrough`).
 */
export function plannedTargets(decision: Decision): DecisionTarget[] {
  if (decision.action !== "delegate") return [];
  return decision.mode === "fanout" ? decision.targets : decision.targets.slice(0, 1);
}

/**
 * How many attempts of a real run fell through, or null when its history does not show it
 * (no run yet, still running, rejected, or the decision never delegated).
 */
function fellThroughOf(decision: Decision, run: RunRecord | undefined): number | null {
  if (decision.action !== "delegate" || !run || decision.mode === "fanout") return null;
  const agent = run.result?.externalAgent;
  if (run.status === "returned_to_host") return decision.targets.length;
  if (run.status === "completed" && agent) {
    const idx = decision.targets.findIndex((t) => t.instance === agent.instance);
    return idx < 0 ? null : idx;
  }
  return null;
}

interface Acc {
  tasks: number;
  real: number;
  delegated: number;
  host: number;
  rejected: number;
  fallback: number;
  fell: number;
  observed: number;
  cost: number;
  unpriced: number;
  inst: Map<string, { n: number; cost: number }>;
}

const newAcc = (): Acc => ({
  tasks: 0,
  real: 0,
  delegated: 0,
  host: 0,
  rejected: 0,
  fallback: 0,
  fell: 0,
  observed: 0,
  cost: 0,
  unpriced: 0,
  inst: new Map(),
});

function add(acc: Acc, rec: DecisionRecord, d: Decision, cost: CostModel): void {
  acc.tasks++;
  if (d.action === "delegate") acc.delegated++;
  else if (d.action === "host") acc.host++;
  else acc.rejected++;
  if (d.mode === "fallback") acc.fallback++;
  for (const t of plannedTargets(d)) {
    const c = cost(rec.input, t);
    const slot = acc.inst.get(t.instance) ?? { n: 0, cost: 0 };
    slot.n++;
    if (c === null) acc.unpriced++;
    else {
      slot.cost += c;
      acc.cost += c;
    }
    acc.inst.set(t.instance, slot);
  }
}

function toStats(profile: string, a: Acc, hasReal: boolean): ProfileStats {
  return {
    profile,
    tasks: est(a.tasks),
    realTasks: est(a.real),
    delegated: est(a.delegated),
    hostKept: est(a.host),
    rejected: est(a.rejected),
    fallbackMode: est(a.fallback),
    fellThrough: hasReal ? { ...est(a.fell), observedRuns: a.observed } : null,
    relativeCost: est(a.cost),
    unpricedTargets: est(a.unpriced),
    instances: [...a.inst.entries()]
      .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
      .map(([instance, s]) => ({ instance, delegated: est(s.n), relativeCost: est(s.cost) })),
  };
}

/**
 * Per-profile comparison of recorded decisions inside `[since, until)`. Pure: the same inputs give
 * the same result.
 */
export function compareProfiles(input: CompareInput): CompareResult {
  const cost = input.costModel ?? relativeCostModel;
  const from = input.since === undefined ? -Infinity : ms(input.since);
  const to = input.until === undefined ? Infinity : ms(input.until);
  const inWindow = input.decisions.filter((r) => ms(r.createdAt) >= from && ms(r.createdAt) < to);
  const runs = new Map(input.runs.map((r) => [r.runId, r]));
  const byId = new Map(inWindow.map((r) => [r.id, r]));

  const accs = new Map<string, Acc>();
  const hasReal = new Set<string>();
  const accOf = (profile: string): Acc => {
    const existing = accs.get(profile);
    if (existing) return existing;
    const fresh = newAcc();
    accs.set(profile, fresh);
    return fresh;
  };

  const realProfile = new Map<string, string>();
  for (const rec of inWindow) {
    const active = rec.input.routing.activeProfile;
    const profile = typeof active === "string" && active !== "" ? active : UNKNOWN_PROFILE;
    realProfile.set(rec.id, profile);
    hasReal.add(profile);
    const a = accOf(profile);
    a.real++;
    add(a, rec, rec.decision, cost);
    const fell = fellThroughOf(rec.decision, rec.runId === null ? undefined : runs.get(rec.runId));
    if (fell !== null) {
      a.fell += fell;
      a.observed++;
    }
  }
  for (const s of input.shadow) {
    const rec = byId.get(s.decisionId);
    // The real decision of the active profile wins over a shadow row for the same profile.
    if (!rec || realProfile.get(s.decisionId) === s.profile) continue;
    add(accOf(s.profile), rec, s.decision, cost);
  }

  const profiles = [...accs.entries()]
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([name, a]) => toStats(name, a, hasReal.has(name)));
  const empty = inWindow.length === 0;
  return {
    empty,
    message: empty ? "no recorded decisions" : null,
    since: input.since ?? null,
    until: input.until ?? null,
    decisions: inWindow.length,
    profiles: empty ? [] : profiles,
    hostConsumption: "not observable",
    estimated: true,
  };
}

/** Reads decisions, shadow rows and runs from `store` and aggregates them with {@link compareProfiles}. */
export async function compareFromStore(
  store: Pick<SqliteStateStore, "listDecisions" | "listShadow" | "listRuns">,
  window: { since?: string; until?: string; costModel?: CostModel } = {},
): Promise<CompareResult> {
  const input: CompareInput = {
    decisions: await store.listDecisions(window.since ?? EPOCH),
    shadow: store.listShadow(EPOCH),
    runs: store.listRuns({ limit: MAX_RUNS }),
  };
  if (window.since !== undefined) input.since = window.since;
  if (window.until !== undefined) input.until = window.until;
  if (window.costModel) input.costModel = window.costModel;
  return compareProfiles(input);
}
