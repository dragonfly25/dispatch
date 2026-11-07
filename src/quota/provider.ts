/**
 * The quota core (spec §8): merges manual overrides, real readings, the estimator and
 * `quota_exhausted` signals into the {@link QuotaSnapshot} the router consumes.
 *
 * Per instance and window kind the value comes from the first available rung of this ladder:
 *   1. manual override (`status --set`, with expiry)
 *   2. real reading (fresh)
 *   3. stale real reading (older than cacheMinutes*staleFactor, channel failing, incoherent)
 *   4. estimate from Dispatch's own recorded runs (never for the host instance)
 *   5. unknown
 * It never blocks and never throws because of a reader: all readers may be disabled or broken and
 * a valid snapshot is still returned (AC4, UC11).
 */
import type {
  Clock,
  InstanceQuota,
  Pool,
  ProviderInstance,
  QuotaObservation,
  QuotaProvider,
  QuotaSnapshot,
  QuotaWindow,
  RunRecord,
  RunResult,
} from "../core/contracts.js";
import type { SqliteStateStore } from "../state/store.js";
import { type EstimatorRun, type EstimatorTuning, estimateWindows } from "./estimator.js";
import {
  DEFAULT_PLANS,
  longestWindowMs,
  mergePlans,
  type PlanSpec,
  type PlanTable,
  planKey,
  resolvePlan,
} from "./plans.js";
import {
  DEFAULT_READER_TIMEOUT_MS,
  type QuotaReader,
  QuotaReaderRegistry,
  runReader,
} from "./reader.js";
import {
  DEFAULT_RELIABILITY,
  hasRolledOver,
  incoherence,
  isFresh,
  isOld,
  type ReliabilityConfig,
} from "./reliability.js";

/** Window kind of the placeholder shown when nothing at all is known about an instance. */
export const UNKNOWN_KIND = "unknown";
/** Override `window` meaning "every window of the instance". */
export const ANY_WINDOW = "*";
/** Source label of manual overrides. */
export const MANUAL_SOURCE = "manual";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Used % from which a window counts as the likely cause of an exhaustion signal. */
const EXHAUSTED_PCT = 90;

/** The slice of {@link SqliteStateStore} the quota core needs. */
export type QuotaStore = Pick<
  SqliteStateStore,
  | "recordQuotaReading"
  | "latestQuotaReadings"
  | "recordQuotaSignal"
  | "activeQuotaSignals"
  | "setOverride"
  | "listOverrides"
  | "listRuns"
>;

/** Context for a relative-cost lookup of one delegated run. */
export interface RunCostContext {
  instanceId: string;
  model?: string | undefined;
  tier?: string | undefined;
}

export interface DefaultQuotaProviderOptions {
  store: QuotaStore;
  clock: Clock;
  /** Readers per adapter. Default: none (estimates / unknown only). */
  readers?: QuotaReaderRegistry;
  /** Reader ids to skip, or "all" (config: quota readers disabled). */
  disabledReaders?: readonly string[] | "all";
  /** Per-reader-call timeout (default 5 000 ms). */
  readerTimeoutMs?: number;
  /** Cache / staleness / coherence tunables (defaults: 5 min, x3, 20%). */
  reliability?: Partial<ReliabilityConfig>;
  /** Config overrides for the plan table, keyed `adapter:plan` (see {@link mergePlans}). */
  plans?: Record<string, unknown>;
  /** Declared plan per instance id: `"max5x"` (resolved with the instance's adapter) or `"claude:max5x"`. */
  instancePlans?: Readonly<Record<string, string>>;
  /** Relative cost (tier) of a run for the estimator; default 1. */
  relativeCost?: (ctx: RunCostContext) => number;
  estimator?: EstimatorTuning;
  /** Instance whose quota is only ever real or unknown. Can also be passed per snapshot. */
  hostInstanceId?: string | null;
  /** Unavailability after an exhaustion signal with no known or estimable reset (default 1 h). */
  fallbackUnavailableMs?: number;
  /** Upper bound of any signal's unavailability, against bogus reset times (default 8 days). */
  maxUnavailableMs?: number;
  /** Lifetime of a manual override without explicit expiry (default 6 h). */
  overrideTtlMs?: number;
  /** How many recent runs the estimator loads (default 2000). */
  maxRuns?: number;
}

/** Per-call options of {@link DefaultQuotaProvider.snapshot}. */
export interface SnapshotOptions {
  /** The calling host's instance id; never estimated. */
  hostInstanceId?: string | null;
  /** Evaluation time; default `clock.now()`. */
  now?: Date;
  /** Re-read every channel even when its cached reading is fresh (`doctor` checks channel health). */
  fresh?: boolean;
  /**
   * Per-reader-call timeout for this snapshot (default: the provider's `readerTimeoutMs`). Commands
   * the user waits on (`status`, `doctor`) pass {@link INTERACTIVE_READER_TIMEOUT_MS}; routing never.
   */
  readerTimeoutMs?: number;
}

/** Reader timeout of commands the user waits on: long enough for slower fallbacks of a reader. */
export const INTERACTIVE_READER_TIMEOUT_MS = 30_000;

/** Outcome of the latest read attempt of one reader (for `doctor` / `status`). */
export interface ReaderHealth {
  instanceId: string;
  readerId: string;
  channel: string;
  version: string;
  ok: boolean;
  /** Failure or incoherence description. */
  error?: string;
  at: string;
}

/** Everything one snapshot computation shares between instances. */
interface Ctx {
  now: Date;
  host: string | null;
  runs: Map<string, EstimatorRun[]>;
  readings: Map<string, Map<string, QuotaWindow>>;
  /** Kinds (or "all") whose latest read failed or was incoherent. */
  suspect: Map<string, Set<string> | "all">;
  /** Skip the cache check and always read. */
  fresh: boolean;
  /** Per-reader-call timeout. */
  timeoutMs: number;
}

/** Default {@link QuotaProvider}; see the module comment for the ladder. */
export class DefaultQuotaProvider implements QuotaProvider {
  readonly #store: QuotaStore;
  readonly #clock: Clock;
  readonly #readers: QuotaReaderRegistry;
  readonly #disabled: ReadonlySet<string> | "all";
  readonly #timeoutMs: number;
  readonly #cfg: ReliabilityConfig;
  readonly #plans: PlanTable;
  readonly #instancePlans: Readonly<Record<string, string>>;
  readonly #cost: (ctx: RunCostContext) => number;
  readonly #tuning: EstimatorTuning;
  readonly #host: string | null;
  readonly #fallbackMs: number;
  readonly #maxUnavailableMs: number;
  readonly #overrideTtlMs: number;
  readonly #maxRuns: number;
  readonly #health = new Map<string, ReaderHealth[]>();

  constructor(options: DefaultQuotaProviderOptions) {
    this.#store = options.store;
    this.#clock = options.clock;
    this.#readers = options.readers ?? new QuotaReaderRegistry();
    this.#disabled =
      options.disabledReaders === "all" ? "all" : new Set(options.disabledReaders ?? []);
    this.#timeoutMs = options.readerTimeoutMs ?? DEFAULT_READER_TIMEOUT_MS;
    this.#cfg = { ...DEFAULT_RELIABILITY, ...options.reliability };
    this.#plans = mergePlans(DEFAULT_PLANS, options.plans ?? {});
    this.#instancePlans = options.instancePlans ?? {};
    this.#cost = options.relativeCost ?? (() => 1);
    this.#tuning = options.estimator ?? {};
    this.#host = options.hostInstanceId ?? null;
    this.#fallbackMs = options.fallbackUnavailableMs ?? HOUR_MS;
    this.#maxUnavailableMs = options.maxUnavailableMs ?? 8 * DAY_MS;
    this.#overrideTtlMs = options.overrideTtlMs ?? 6 * HOUR_MS;
    this.#maxRuns = options.maxRuns ?? 2000;
  }

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  /** Builds the snapshot for `instances`, re-reading stale channels first. Never throws on readers. */
  async snapshot(
    instances: readonly ProviderInstance[],
    options: SnapshotOptions = {},
  ): Promise<QuotaSnapshot> {
    const now = options.now ?? this.#clock.now();
    const ctx: Ctx = {
      now,
      host: options.hostInstanceId === undefined ? this.#host : options.hostInstanceId,
      runs: this.#loadRuns(now),
      readings: this.#loadReadings(),
      suspect: new Map(),
      fresh: options.fresh === true,
      timeoutMs: options.readerTimeoutMs ?? this.#timeoutMs,
    };
    await Promise.all(instances.map((inst) => this.#refresh(inst, ctx)));
    ctx.readings = this.#loadReadings();

    const overrides = this.#store.listOverrides(now);
    const signals = new Map(this.#store.activeQuotaSignals(now).map((s) => [s.instanceId, s]));
    const out: Record<string, InstanceQuota> = {};
    for (const inst of instances) {
      const estimates = this.#estimates(inst.id, inst.adapter, ctx.runs, now, ctx.host);
      const own = overrides.filter((o) => o.instanceId === inst.id);
      const kinds = this.#kinds(inst.id, inst.adapter, estimates, ctx, own);
      const windows = kinds.map((kind) => {
        const o = own.find((x) => x.window === kind) ?? own.find((x) => x.window === ANY_WINDOW);
        const base = this.#ladder(kind, inst.id, estimates, ctx);
        return o
          ? {
              kind,
              usedPct: o.usedPct,
              resetAt: base.resetAt,
              source: MANUAL_SOURCE,
              readAt: now.toISOString(),
              reliability: "real" as const,
            }
          : base;
      });
      const signal = signals.get(inst.id);
      out[inst.id] = {
        windows,
        pool: inst.pool as Pool,
        ...(signal ? { unavailableUntil: signal.until } : {}),
        ...(signal?.error ? { lastQuotaError: signal.error } : {}),
      };
    }
    return { takenAt: now.toISOString(), instances: out };
  }

  /** Rungs 2-5 of the ladder for one window kind. */
  #ladder(kind: string, id: string, estimates: QuotaWindow[], ctx: Ctx): QuotaWindow {
    const real = ctx.readings.get(id)?.get(kind);
    const est = estimates.find((e) => e.kind === kind);
    if (real && !hasRolledOver(real, ctx.now)) {
      const flagged = ctx.suspect.get(id);
      const suspect = flagged === "all" || flagged?.has(kind) === true;
      const bad =
        suspect ||
        isOld(real, ctx.now, this.#cfg) ||
        incoherence(real, est?.usedPct ?? null, this.#cfg) !== null;
      return { ...real, reliability: bad ? "stale" : "real" };
    }
    if (est) return est;
    return {
      kind,
      usedPct: null,
      resetAt: null,
      source: "none",
      readAt: ctx.now.toISOString(),
      reliability: "unknown",
    };
  }

  /** Window kinds of an instance: plan windows, then read ones, then override-only ones. */
  #kinds(
    id: string,
    adapter: string,
    estimates: QuotaWindow[],
    ctx: Ctx,
    overrides: { window: string }[],
  ): string[] {
    const planKinds = this.#planKinds(id, adapter, estimates);
    const read = [...(ctx.readings.get(id)?.keys() ?? [])].sort();
    const manual = overrides.map((o) => o.window).filter((k) => k !== ANY_WINDOW);
    const kinds = [...new Set([...planKinds, ...read, ...manual])];
    return kinds.length > 0 ? kinds : [UNKNOWN_KIND];
  }

  /** Plan window kinds, also for the host (whose estimates are empty). */
  #planKinds(id: string, adapter: string, estimates: QuotaWindow[]): string[] {
    if (estimates.length > 0) return estimates.map((e) => e.kind);
    return this.#planFor(id, adapter)?.windows.map((w) => w.kind) ?? [];
  }

  // -------------------------------------------------------------------------
  // readers
  // -------------------------------------------------------------------------

  #readersFor(inst: ProviderInstance): readonly QuotaReader[] {
    if (this.#disabled === "all") return [];
    const disabled = this.#disabled;
    return this.#readers.forAdapter(inst.adapter).filter((r) => !disabled.has(r.id));
  }

  /** Re-reads `inst` when its cache is cold; stores coherent readings, flags the rest. */
  async #refresh(inst: ProviderInstance, ctx: Ctx): Promise<void> {
    const readers = this.#readersFor(inst);
    if (readers.length === 0) return;
    const live = [...(ctx.readings.get(inst.id)?.values() ?? [])].filter(
      (w) => !isOld(w, ctx.now, this.#cfg),
    );
    if (!ctx.fresh && live.length > 0 && live.every((w) => isFresh(w, ctx.now, this.#cfg))) return;

    const outcomes = await Promise.all(readers.map((r) => runReader(r, inst, ctx.timeoutMs)));
    const health: ReaderHealth[] = [];
    const fetched = new Map<string, QuotaWindow>();
    let anyOk = false;
    outcomes.forEach((outcome, i) => {
      const reader = readers[i] as QuotaReader;
      const entry = {
        instanceId: inst.id,
        readerId: reader.id,
        channel: reader.channel,
        version: reader.version,
        at: ctx.now.toISOString(),
      };
      if (!outcome.ok) {
        health.push({ ...entry, ok: false, error: outcome.error });
        return;
      }
      anyOk = true;
      health.push({ ...entry, ok: true });
      for (const w of outcome.windows) {
        const prev = fetched.get(w.kind);
        if (!prev || Date.parse(w.readAt) >= Date.parse(prev.readAt)) fetched.set(w.kind, w);
      }
    });
    this.#health.set(inst.id, health);
    if (!anyOk) {
      ctx.suspect.set(inst.id, "all");
      return;
    }

    const estimates = this.#estimates(inst.id, inst.adapter, ctx.runs, ctx.now, ctx.host);
    const bad = new Set<string>();
    for (const w of fetched.values()) {
      const est = estimates.find((e) => e.kind === w.kind)?.usedPct ?? null;
      const reason =
        w.reliability === "real" ? incoherence(w, est, this.#cfg) : "not a real reading";
      if (reason === null) {
        this.#store.recordQuotaReading(inst.id, w);
      } else {
        bad.add(w.kind);
        health.push({
          instanceId: inst.id,
          readerId: w.source,
          channel: "",
          version: "",
          ok: false,
          error: `${w.kind}: ${reason}`,
          at: ctx.now.toISOString(),
        });
      }
    }
    if (bad.size > 0) ctx.suspect.set(inst.id, bad);
  }

  /** Outcome of the latest read attempt per instance (empty before the first read). */
  readerHealth(instanceId?: string): ReaderHealth[] {
    if (instanceId !== undefined) return [...(this.#health.get(instanceId) ?? [])];
    return [...this.#health.values()].flat();
  }

  #loadReadings(): Map<string, Map<string, QuotaWindow>> {
    const out = new Map<string, Map<string, QuotaWindow>>();
    for (const r of this.#store.latestQuotaReadings()) {
      const m = out.get(r.instanceId) ?? new Map<string, QuotaWindow>();
      m.set(r.window.kind, r.window);
      out.set(r.instanceId, m);
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // estimator inputs
  // -------------------------------------------------------------------------

  #planFor(instanceId: string, adapter?: string): PlanSpec | undefined {
    const declared = this.#instancePlans[instanceId];
    if (declared === undefined) return undefined;
    if (adapter !== undefined) return resolvePlan(this.#plans, adapter, declared);
    if (declared.includes(":")) return this.#plans[planKey("", declared)];
    const hits = Object.keys(this.#plans).filter((k) => k.endsWith(`:${declared.toLowerCase()}`));
    return hits.length === 1 ? this.#plans[hits[0] as string] : undefined;
  }

  #estimates(
    id: string,
    adapter: string | undefined,
    runs: Map<string, EstimatorRun[]>,
    now: Date,
    host: string | null,
  ): QuotaWindow[] {
    const plan = this.#planFor(id, adapter);
    if (!plan) return [];
    return estimateWindows(plan, runs.get(id) ?? [], {
      ...this.#tuning,
      now,
      isHost: id === host,
    });
  }

  /** Recent delegated runs grouped by instance, as estimator input. */
  #loadRuns(now: Date): Map<string, EstimatorRun[]> {
    const since = now.getTime() - 2 * longestWindowMs(this.#plans);
    const out = new Map<string, EstimatorRun[]>();
    const add = (instanceId: string, run: EstimatorRun) => {
      const list = out.get(instanceId) ?? [];
      list.push(run);
      out.set(instanceId, list);
    };
    for (const rec of this.#store.listRuns({ limit: this.#maxRuns })) {
      if (Date.parse(rec.createdAt) < since) continue;
      this.#leaves(rec, now, add);
    }
    return out;
  }

  /** Emits one estimator run per delegated child of `rec` (fanout children count separately). */
  #leaves(rec: RunRecord, now: Date, add: (id: string, run: EstimatorRun) => void): void {
    if (rec.result === null) {
      if (rec.status === "running" && rec.instance !== null) {
        const durationMs = Math.max(0, now.getTime() - Date.parse(rec.createdAt));
        const relativeCost = this.#cost({ instanceId: rec.instance });
        add(rec.instance, { at: rec.createdAt, durationMs, relativeCost });
      }
      return;
    }
    const walk = (r: RunResult): void => {
      if (r.results && r.results.length > 0) {
        for (const child of r.results) walk(child);
        return;
      }
      const agent = r.externalAgent;
      if (!agent || r.outcome === null) return;
      const tier = r.decisions
        .flatMap((d) => d.targets)
        .find((t) => t.instance === agent.instance && t.model === agent.model)?.tier;
      add(agent.instance, {
        at: rec.createdAt,
        durationMs: r.durationMs,
        inputTokens: r.usage?.inputTokens,
        outputTokens: r.usage?.outputTokens,
        model: agent.model,
        relativeCost: this.#cost({ instanceId: agent.instance, model: agent.model, tier }),
      });
    };
    walk(rec.result);
  }

  // -------------------------------------------------------------------------
  // observations
  // -------------------------------------------------------------------------

  /**
   * Persists a runtime observation: a real reading (when coherent) and/or an exhaustion signal
   * that marks the instance unavailable until its reset (known, else estimated, else a fallback).
   */
  async recordObservation(observation: QuotaObservation): Promise<void> {
    const { instanceId, window, exhausted } = observation;
    if (window && window.reliability === "real" && incoherence(window, null, this.#cfg) === null) {
      this.#store.recordQuotaReading(instanceId, window);
    }
    if (exhausted) {
      const t0 = new Date(observation.at);
      const until = this.#unavailableUntil(instanceId, t0, exhausted.resetAt);
      this.#store.recordQuotaSignal(instanceId, new Date(until), exhausted.error);
    }
  }

  /** ms epoch until which the instance counts as exhausted. */
  #unavailableUntil(instanceId: string, t0: Date, resetAt: string | null): number {
    const start = t0.getTime();
    const cap = start + this.#maxUnavailableMs;
    const known = resetAt === null ? Number.NaN : Date.parse(resetAt);
    if (known > start) return Math.min(known, cap);
    const estimated = this.#estimatedReset(instanceId, t0);
    return Math.min(estimated ?? start + this.#fallbackMs, cap);
  }

  /** Next reset among the instance's windows, preferring the ones that look exhausted. */
  #estimatedReset(instanceId: string, t0: Date): number | null {
    const start = t0.getTime();
    const windows: QuotaWindow[] = this.#store
      .latestQuotaReadings()
      .filter((r) => r.instanceId === instanceId)
      .map((r) => r.window);
    windows.push(...this.#estimates(instanceId, undefined, this.#loadRuns(t0), t0, this.#host));
    const future = windows.filter((w) => w.resetAt !== null && Date.parse(w.resetAt) > start);
    const hot = future.filter((w) => (w.usedPct ?? 0) >= EXHAUSTED_PCT);
    const pool = hot.length > 0 ? hot : future;
    if (pool.length === 0) return null;
    return Math.min(...pool.map((w) => Date.parse(w.resetAt as string)));
  }

  // -------------------------------------------------------------------------
  // manual overrides (`status --set`)
  // -------------------------------------------------------------------------

  /**
   * Pins the used % of one window (default: every window) until `expiresAt` / `ttlMs` from now.
   * The override wins over every other source until it expires.
   */
  setOverride(
    instanceId: string,
    usedPct: number,
    opts: { window?: string; ttlMs?: number; expiresAt?: Date } = {},
  ): { instanceId: string; window: string; usedPct: number; expiresAt: string } {
    if (!(usedPct >= 0 && usedPct <= 100)) throw new RangeError(`usedPct out of range: ${usedPct}`);
    const expires =
      opts.expiresAt ?? new Date(this.#clock.now().getTime() + (opts.ttlMs ?? this.#overrideTtlMs));
    const record = {
      instanceId,
      window: opts.window ?? ANY_WINDOW,
      usedPct,
      expiresAt: expires.toISOString(),
    };
    this.#store.setOverride(record);
    return record;
  }

  /** Ends an override immediately. */
  clearOverride(instanceId: string, window: string = ANY_WINDOW): void {
    this.#store.setOverride({
      instanceId,
      window,
      usedPct: 0,
      expiresAt: this.#clock.now().toISOString(),
    });
  }
}
