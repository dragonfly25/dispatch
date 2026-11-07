/**
 * Codex quota reader: `codex app-server` JSON-RPC (`initialize` -> `initialized` ->
 * `account/rateLimits/read`). Official, quota-free. The CLI uses its own login; Dispatch never
 * opens credential files (spec §8 requirements 1-2), it only sets `CODEX_HOME` for the instance.
 */
import { tmpdir } from "node:os";
import { z } from "zod";
import type {
  Clock,
  ProviderInstance,
  QuotaObservation,
  QuotaWindow,
} from "../../core/contracts.js";
import { RpcError, runRpcSession } from "../../runner/rpc.js";
import { DEFAULT_READER_TIMEOUT_MS, type QuotaReadContext, type QuotaReader } from "../reader.js";
import { buildReaderEnv } from "./env.js";
import { QuotaAuthError, QuotaFormatError } from "./errors.js";

export const CODEX_READER_ID = "codex-app-server";
const RPC_METHOD = "account/rateLimits/read";
/** `windowDurationMins` -> window kind (plans.ts). Other durations are not modelled. */
const KIND_BY_MINUTES: Readonly<Record<number, string>> = { 300: "5h", 10080: "weekly" };
const AUTH_ERROR = /auth|log ?in|sign ?in|unauthori[sz]ed|credential/i;

const LimitWindowSchema = z.object({
  usedPercent: z.number().finite(),
  windowDurationMins: z.number().finite(),
  resetsAt: z.number().finite().nullish(),
});
const SnapshotSchema = z.object({
  primary: LimitWindowSchema.nullish(),
  secondary: LimitWindowSchema.nullish(),
  ordinaryUsageAllowed: z.boolean().nullish(),
  rateLimitReachedType: z.string().nullish(),
});
const ResultSchema = z.object({
  rateLimits: SnapshotSchema.nullish(),
  rateLimitsByLimitId: z.record(z.string(), SnapshotSchema).nullish(),
});

/** The latest exhaustion detected for an instance (the provider records it via `onObservation`). */
export interface CodexExhaustion {
  at: string;
  resetAt: string | null;
  error: string;
}

/** Options of {@link CodexAppServerReader}. */
export interface CodexReaderOptions {
  clock: Clock;
  /** Dispatch version reported in `clientInfo`. */
  version?: string;
  /** Environment the child env is derived from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Working directory of the child (default: the OS temp dir). */
  cwd?: string;
  /** Overrides the 5 s default when the core passes no context. */
  timeoutMs?: number;
  /** Resolves the binary (config `binary:` -> PATH -> well-known dirs); default: `instance.binary ?? "codex"`. */
  resolveBinary?: (instance: ProviderInstance) => string | Promise<string>;
  /**
   * Receives a `quota_exhausted` observation when the account cannot be used right now; wire it to
   * `QuotaProvider.recordObservation`. Failures are swallowed (a reader never throws because of it).
   */
  onObservation?: (observation: QuotaObservation) => void | Promise<void>;
}

/** Reads Codex rate limits from the app-server. */
export class CodexAppServerReader implements QuotaReader {
  readonly id = CODEX_READER_ID;
  readonly version = "1";
  readonly channel = "app-server";
  readonly #opts: CodexReaderOptions;
  readonly #exhausted = new Map<string, CodexExhaustion>();

  constructor(options: CodexReaderOptions) {
    this.#opts = options;
  }

  /** Latest exhaustion seen for `instanceId`; cleared by the next read that finds it usable. */
  lastExhausted(instanceId: string): CodexExhaustion | undefined {
    return this.#exhausted.get(instanceId);
  }

  async read(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<QuotaWindow[]> {
    const raw = await this.#call(instance, ctx);
    const readAt = this.#opts.clock.now().toISOString();
    const parsed = ResultSchema.safeParse(raw);
    if (!parsed.success)
      throw new QuotaFormatError(this.id, "unexpected result shape", { cause: parsed.error });
    const snap = parsed.data.rateLimitsByLimitId?.codex ?? parsed.data.rateLimits;
    if (!snap) throw new QuotaFormatError(this.id, "no rate limit snapshot in the result");

    const byKind = new Map<string, QuotaWindow>();
    for (const w of [snap.primary, snap.secondary]) {
      const kind = w ? KIND_BY_MINUTES[w.windowDurationMins] : undefined;
      if (!w || !kind) continue;
      byKind.set(kind, {
        kind,
        usedPct: Math.min(100, Math.max(0, w.usedPercent)),
        resetAt: w.resetsAt == null ? null : new Date(w.resetsAt * 1000).toISOString(),
        source: this.id,
        readAt,
        reliability: "real",
      });
    }
    if (byKind.size === 0) throw new QuotaFormatError(this.id, "no 5h or weekly window found");

    const windows = [...byKind.values()];
    const reached = snap.rateLimitReachedType ?? null;
    if (snap.ordinaryUsageAllowed === false || reached !== null) {
      await this.#markExhausted(instance, windows, reached, readAt);
    } else {
      this.#exhausted.delete(instance.id);
    }
    return windows;
  }

  /** Runs the handshake and the rate-limit read. */
  async #call(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<unknown> {
    const o = this.#opts;
    const binary = o.resolveBinary ? await o.resolveBinary(instance) : (instance.binary ?? "codex");
    try {
      return await runRpcSession(
        {
          binary,
          argv: ["app-server"],
          env: buildReaderEnv(o.env ?? process.env, instance, "CODEX_HOME"),
          cwd: o.cwd ?? tmpdir(),
          timeoutMs: ctx?.timeoutMs ?? o.timeoutMs ?? DEFAULT_READER_TIMEOUT_MS,
          ...(ctx?.signal ? { signal: ctx.signal } : {}),
        },
        async (rpc) => {
          await rpc.request("initialize", {
            clientInfo: { name: "dispatch", title: "Dispatch", version: o.version ?? "0.0.0" },
          });
          rpc.notify("initialized");
          return rpc.request(RPC_METHOD);
        },
      );
    } catch (err) {
      if (err instanceof RpcError && AUTH_ERROR.test(err.message)) {
        throw new QuotaAuthError(this.id, err.message);
      }
      throw err;
    }
  }

  /**
   * The account cannot be used now: make sure a window shows 100% (the most used one when none
   * does) and report the exhaustion, resetting when the exhausted window(s) reset.
   */
  async #markExhausted(
    instance: ProviderInstance,
    windows: QuotaWindow[],
    reached: string | null,
    at: string,
  ): Promise<void> {
    if (!windows.some((w) => (w.usedPct ?? 0) >= 100)) {
      const top = windows.reduce((a, b) => ((b.usedPct ?? 0) > (a.usedPct ?? 0) ? b : a));
      top.usedPct = 100;
    }
    const resets = windows
      .filter((w) => (w.usedPct ?? 0) >= 100 && w.resetAt !== null)
      .map((w) => w.resetAt as string)
      .sort();
    const exhaustion: CodexExhaustion = {
      at,
      resetAt: resets.at(-1) ?? null,
      error: `codex usage limit reached${reached ? ` (${reached})` : ""}`,
    };
    this.#exhausted.set(instance.id, exhaustion);
    try {
      await this.#opts.onObservation?.({
        instanceId: instance.id,
        at,
        exhausted: { resetAt: exhaustion.resetAt, error: exhaustion.error },
      });
    } catch {
      // Recording is best effort; the windows returned above carry the information too.
    }
  }
}
