/**
 * Candidate filtering (spec §7 thresholds, §8.3 "routing never blocks for lack of quota data").
 * Every candidate gets exactly one `filter` trace entry: `matched: true` means it was kept.
 */
import type {
  Autonomy,
  DecisionTarget,
  HostContext,
  QuotaSnapshot,
  QuotaWindow,
  Reliability,
  RuleTrace,
  Task,
} from "../core/contracts.js";
import type { RoutingConfig, RoutingInstance } from "../core/routing.js";

const AUTONOMY_RANK: Record<Autonomy, number> = { "read-only": 0, worktree: 1, direct: 2 };

/** True when an instance capped at `max` may receive a task asking for `requested`. */
export function autonomyAllows(max: Autonomy, requested: Autonomy): boolean {
  return AUTONOMY_RANK[requested] <= AUTONOMY_RANK[max];
}

const ISO = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?(?:\.(\d+))?Z$/;

/** Sortable key of an ISO-8601 UTC timestamp (handles any fractional precision). */
function isoKey(iso: string): string {
  const m = ISO.exec(iso);
  if (!m) return iso;
  return `${m[1]}T${m[2]}:${m[3] ?? "00"}.${(m[4] ?? "").padEnd(12, "0")}`;
}

/** True when ISO timestamp `a` is strictly later than `b` (no clock involved). */
export function isoAfter(a: string, b: string): boolean {
  return isoKey(a) > isoKey(b);
}

/** Quota of one instance as the router sees it. */
export interface QuotaView {
  /** 100 − max usedPct over windows with a known value; null when unknown. */
  remainingPct: number | null;
  /** The tightest window (highest usedPct), if any. */
  window: QuotaWindow | null;
  /** Reliability of the tightest window, "unknown" when there is none. */
  reliability: Reliability;
}

/** Remaining quota of `instanceId` in `snapshot` (unknown when absent or without numbers). */
export function quotaView(snapshot: QuotaSnapshot, instanceId: string): QuotaView {
  let window: QuotaWindow | null = null;
  for (const w of snapshot.instances[instanceId]?.windows ?? []) {
    if (w.usedPct !== null && (window === null || w.usedPct > (window.usedPct as number)))
      window = w;
  }
  if (window === null) return { remainingPct: null, window: null, reliability: "unknown" };
  return {
    remainingPct: 100 - (window.usedPct as number),
    window,
    reliability: window.reliability,
  };
}

/** A candidate that passed every filter. */
export interface Candidate {
  instance: RoutingInstance;
  target: DecisionTarget;
  quota: QuotaView;
}

/** Everything the filters read. */
export interface FilterContext {
  cfg: RoutingConfig;
  task: Task;
  host: HostContext;
  quota: QuotaSnapshot;
  now: string;
}

function trace(id: string, kept: boolean, effect: string, note?: string): RuleTrace {
  const t: RuleTrace = { layer: "filter", ruleId: id, matched: kept, effect };
  if (note !== undefined) t.note = note;
  return t;
}

function fmtPct(n: number): string {
  return `${Math.round(n * 10) / 10}%`;
}

/** Why an instance is excluded before quota thresholds are looked at, or null. */
function hardReason(
  ctx: FilterContext,
  inst: RoutingInstance | undefined,
  id: string,
  q: QuotaView,
): string | null {
  if (!inst) return "unknown instance";
  if (id === ctx.host.self) return "self (the host never delegates to itself)";
  if (!inst.enabled) return "disabled";
  if (!autonomyAllows(inst.maxAutonomy, ctx.task.autonomy)) {
    return `autonomy ${ctx.task.autonomy} above instance max ${inst.maxAutonomy}`;
  }
  if (!autonomyAllows(ctx.cfg.maxAutonomy, ctx.task.autonomy)) {
    return `autonomy ${ctx.task.autonomy} above config max ${ctx.cfg.maxAutonomy}`;
  }
  const until = ctx.quota.instances[id]?.unavailableUntil;
  if (until !== undefined && isoAfter(until, ctx.now)) return `unavailable until ${until}`;
  if (q.remainingPct !== null && q.remainingPct < inst.thresholds.hard) {
    return `below hard limit (remaining ${fmtPct(q.remainingPct)} < ${inst.thresholds.hard}%)`;
  }
  return null;
}

/**
 * Filters `ids` (deduplicated, order kept) and resolves each survivor's target with `resolve`.
 * Below-soft candidates are dropped only when another candidate is not below soft.
 */
export function filterCandidates(
  ctx: FilterContext,
  ids: readonly string[],
  resolve: (
    inst: RoutingInstance,
  ) => { ok: true; target: DecisionTarget } | { ok: false; reason: string },
): { kept: Candidate[]; trace: RuleTrace[] } {
  const rows: { id: string; reason: string | null; cand?: Candidate }[] = [];
  for (const id of new Set(ids)) {
    const inst = ctx.cfg.instances.find((i) => i.id === id);
    const quota = quotaView(ctx.quota, id);
    const reason = hardReason(ctx, inst, id, quota);
    if (reason !== null || !inst) {
      rows.push({ id, reason: reason ?? "unknown instance" });
      continue;
    }
    const r = resolve(inst);
    if (r.ok) rows.push({ id, reason: null, cand: { instance: inst, target: r.target, quota } });
    else rows.push({ id, reason: r.reason });
  }

  const belowSoft = (c: Candidate) =>
    c.quota.remainingPct !== null && c.quota.remainingPct < c.instance.thresholds.soft;
  const alive = rows.flatMap((r) => (r.cand ? [r.cand] : []));
  const someAboveSoft = alive.some((c) => !belowSoft(c));

  const kept: Candidate[] = [];
  const out: RuleTrace[] = [];
  for (const row of rows) {
    const c = row.cand;
    if (!c) {
      out.push(trace(row.id, false, `filtered: ${row.reason}`));
      continue;
    }
    const q = c.quota;
    const quotaText =
      q.remainingPct === null ? "quota unknown" : `remaining ${fmtPct(q.remainingPct)}`;
    if (belowSoft(c) && someAboveSoft) {
      out.push(
        trace(
          row.id,
          false,
          `filtered: below soft limit (${quotaText} < ${c.instance.thresholds.soft}%)`,
          "an alternative is above its soft limit",
        ),
      );
      continue;
    }
    kept.push(c);
    out.push(
      trace(
        row.id,
        true,
        `kept: ${quotaText}`,
        belowSoft(c) ? "below soft limit, no alternative" : undefined,
      ),
    );
  }
  return { kept, trace: out };
}
