/**
 * Claude quota, read passively: no process is started and no credential is touched. The claude
 * adapter turns the `rate_limit_event`s of a run into {@link QuotaObservation}s (kept in
 * `ctx.scratch.quotaObservations`); {@link ingestClaudeObservations} stores them through the quota
 * provider, and {@link ClaudePassiveReader} serves the latest stored passive reading so that
 * `status` shows it as a real value while it is fresh.
 */
import {
  type Clock,
  type ProviderInstance,
  type QuotaObservation,
  QuotaObservationSchema,
  type QuotaProvider,
  type QuotaWindow,
} from "../../core/contracts.js";
import type { QuotaStore } from "../provider.js";
import type { QuotaReader } from "../reader.js";
import {
  DEFAULT_RELIABILITY,
  hasRolledOver,
  isOld,
  type ReliabilityConfig,
} from "../reliability.js";

export const CLAUDE_PASSIVE_ID = "claude-passive";

/** Outcome of {@link ingestClaudeObservations}. */
export interface IngestResult {
  recorded: number;
  /** Items that were not valid observations or that the provider failed to record. */
  rejected: number;
}

/**
 * Records the observations a claude run collected (`ctx.scratch.quotaObservations`). Invalid items
 * are skipped; real windows are re-labelled with the `claude-passive` source. Never throws.
 */
export async function ingestClaudeObservations(
  provider: Pick<QuotaProvider, "recordObservation">,
  observations: unknown,
): Promise<IngestResult> {
  const result: IngestResult = { recorded: 0, rejected: 0 };
  if (!Array.isArray(observations)) return result;
  for (const item of observations) {
    const parsed = QuotaObservationSchema.safeParse(item);
    if (!parsed.success) {
      result.rejected++;
      continue;
    }
    const obs: QuotaObservation = parsed.data;
    const normalized = obs.window
      ? { ...obs, window: { ...obs.window, source: CLAUDE_PASSIVE_ID } }
      : obs;
    try {
      await provider.recordObservation(normalized);
      result.recorded++;
    } catch {
      result.rejected++;
    }
  }
  return result;
}

/** Options of {@link ClaudePassiveReader}. */
export interface ClaudePassiveOptions {
  store: Pick<QuotaStore, "latestQuotaReadings">;
  clock: Clock;
  /** Same tunables as the quota core; a reading older than `cacheMinutes * staleFactor` is dropped. */
  reliability?: Partial<ReliabilityConfig>;
}

/** Returns the instance's latest stored passive readings while they are fresh. No I/O but the store. */
export class ClaudePassiveReader implements QuotaReader {
  readonly id = CLAUDE_PASSIVE_ID;
  readonly version = "1";
  readonly channel = "passive";
  readonly #opts: ClaudePassiveOptions;

  constructor(options: ClaudePassiveOptions) {
    this.#opts = options;
  }

  async read(instance: ProviderInstance): Promise<QuotaWindow[]> {
    const now = this.#opts.clock.now();
    const cfg = { ...DEFAULT_RELIABILITY, ...this.#opts.reliability };
    return this.#opts.store
      .latestQuotaReadings()
      .filter((r) => r.instanceId === instance.id && r.window.source === this.id)
      .map((r) => r.window)
      .filter((w) => w.reliability === "real" && !isOld(w, now, cfg) && !hasRolledOver(w, now));
  }
}
