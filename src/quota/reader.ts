/**
 * Per-provider quota readers (implemented by WP18) and the registry the quota core uses to find
 * them. Readers never block routing: the core wraps every call in a timeout and a catch.
 */
import type { ProviderInstance, QuotaWindow } from "../core/contracts.js";

/** Default time a reader gets before the core gives up on it (spec §8: readers never block). */
export const DEFAULT_READER_TIMEOUT_MS = 5_000;

/** Extra per-call context. Readers may ignore it; those that spawn a child should honour it. */
export interface QuotaReadContext {
  /** Aborted when the core stops waiting (timeout). Use it to kill any child process. */
  signal: AbortSignal;
  /** The timeout applied to this call, in ms. */
  timeoutMs: number;
}

/**
 * A quota reading channel for one provider (e.g. `codex-app-server`). Replaceable without touching
 * the router (spec §8 requirement 1). Implementations must use credentials read-only and in place.
 */
export interface QuotaReader {
  /** Stable id, also used as `QuotaWindow.source` and in `disabled` config lists. */
  readonly id: string;
  /** Reader version, shown by `doctor`. */
  readonly version: string;
  /** Channel used, e.g. "passive", "app-server", "cli:/usage". */
  readonly channel: string;
  /**
   * Returns the instance's current windows. Every returned window must have
   * `reliability: "real"`, `source: this.id` and `readAt` = when the data was produced. May reject;
   * the core catches it.
   */
  read(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<QuotaWindow[]>;
}

/** Readers grouped by the adapter id (`ProviderInstance.adapter`) they serve. */
export class QuotaReaderRegistry {
  readonly #byAdapter = new Map<string, QuotaReader[]>();

  /** Registers `reader` for instances whose `adapter` equals `adapterId`. Reader ids are unique. */
  register(adapterId: string, reader: QuotaReader): this {
    if (this.all().some((r) => r.id === reader.id)) {
      throw new Error(`quota reader already registered: ${reader.id}`);
    }
    const list = this.#byAdapter.get(adapterId) ?? [];
    list.push(reader);
    this.#byAdapter.set(adapterId, list);
    return this;
  }

  /** Readers serving `adapterId`, in registration order. */
  forAdapter(adapterId: string): readonly QuotaReader[] {
    return this.#byAdapter.get(adapterId) ?? [];
  }

  /** Every registered reader. */
  all(): readonly QuotaReader[] {
    return [...this.#byAdapter.values()].flat();
  }
}

/** Result of one guarded reader call. */
export type ReaderOutcome =
  | { ok: true; windows: QuotaWindow[] }
  | { ok: false; error: string; timedOut: boolean };

/** Runs `reader.read` with a timeout; never rejects and never makes the caller wait past it. */
export async function runReader(
  reader: QuotaReader,
  instance: ProviderInstance,
  timeoutMs: number = DEFAULT_READER_TIMEOUT_MS,
): Promise<ReaderOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<ReaderOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ ok: false, error: `timed out after ${timeoutMs} ms`, timedOut: true });
    }, timeoutMs);
  });
  const call = (async (): Promise<ReaderOutcome> => {
    try {
      const windows = await reader.read(instance, { signal: controller.signal, timeoutMs });
      return Array.isArray(windows)
        ? { ok: true, windows }
        : { ok: false, error: "reader returned a non-array", timedOut: false };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        timedOut: false,
      };
    }
  })();
  try {
    return await Promise.race([call, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
