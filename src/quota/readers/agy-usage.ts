/**
 * Antigravity quota reader: `agy -p=/usage --output-format json` (quota-free, official command).
 * Groups of models carry buckets with `remaining_fraction` and `reset_time`. The CLI uses its own
 * login (Keychain via HOME); Dispatch never opens credential files.
 */
import { tmpdir } from "node:os";
import { z } from "zod";
import type { Clock, ProviderInstance, QuotaWindow, Spawner } from "../../core/contracts.js";
import { DEFAULT_READER_TIMEOUT_MS, type QuotaReadContext, type QuotaReader } from "../reader.js";
import { buildReaderEnv } from "./env.js";
import { QuotaAuthError, QuotaFormatError, QuotaReaderError } from "./errors.js";

export const AGY_READER_ID = "agy-usage";
const AUTH_ERROR = /not logged in|log ?in|sign ?in|authenticat|unauthori[sz]ed|credential|expired/i;

const BucketSchema = z.object({
  id: z.string().optional(),
  window: z.string().optional(),
  remaining_fraction: z.number().finite(),
  reset_time: z.string().nullish(),
});
const UsageSchema = z.object({
  command: z.object({
    data: z.object({
      groups: z.array(z.object({ name: z.string().optional(), buckets: z.array(BucketSchema) })),
    }),
  }),
});

/** Model group of a `/usage` group (plans.ts suffixes), from its name or its buckets' ids. */
function groupOf(name: string | undefined, ids: readonly (string | undefined)[]): string | null {
  const hay = `${name ?? ""} ${ids.join(" ")}`.toLowerCase();
  if (hay.includes("gemini")) return "gemini";
  if (/claude|gpt|\b3p\b/.test(hay)) return "claude-gpt";
  return null;
}

/** Window prefix (plans.ts) of a bucket, from its `window` field or id. */
function periodOf(bucket: z.infer<typeof BucketSchema>): string | null {
  const hay = `${bucket.window ?? ""} ${bucket.id ?? ""}`.toLowerCase();
  if (hay.includes("weekly") || hay.includes("7d")) return "weekly";
  if (/\b5h\b|5-?hour|five[_ -]?hour|5h/.test(hay)) return "5h";
  return null;
}

/** Options of {@link AgyUsageReader}. */
export interface AgyReaderOptions {
  spawner: Spawner;
  clock: Clock;
  /** Environment the child env is derived from (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  /** Working directory (default: the OS temp dir; `/usage` needs no repository). */
  cwd?: string;
  timeoutMs?: number;
  /** Default: `instance.binary ?? "agy"`. */
  resolveBinary?: (instance: ProviderInstance) => string | Promise<string>;
}

/** Reads Antigravity quota from `agy /usage`. */
export class AgyUsageReader implements QuotaReader {
  readonly id = AGY_READER_ID;
  readonly version = "1";
  readonly channel = "cli:/usage";
  readonly #opts: AgyReaderOptions;

  constructor(options: AgyReaderOptions) {
    this.#opts = options;
  }

  async read(instance: ProviderInstance, ctx?: QuotaReadContext): Promise<QuotaWindow[]> {
    const o = this.#opts;
    const binary = o.resolveBinary ? await o.resolveBinary(instance) : (instance.binary ?? "agy");
    const out: string[] = [];
    const err: string[] = [];
    const timeoutMs = ctx?.timeoutMs ?? o.timeoutMs ?? DEFAULT_READER_TIMEOUT_MS;
    const result = await o.spawner.spawn({
      binary,
      argv: ["-p=/usage", "--output-format", "json"],
      env: buildReaderEnv(o.env ?? process.env, instance),
      cwd: o.cwd ?? tmpdir(),
      timeoutMs,
      ...(ctx?.signal ? { signal: ctx.signal } : {}),
      onLine: (stream, line) => (stream === "stdout" ? out : err).push(line),
    });
    if (result.timedOut)
      throw new QuotaReaderError(this.id, `agy /usage timed out after ${timeoutMs} ms`);
    if (result.exitCode !== 0) throw this.#failure(result.exitCode, result.signal, err);
    return this.#parse(out, o.clock.now().toISOString());
  }

  /** Typed error for a failed run: `AGY_ERROR: {"short_error": ...}` on stderr, auth-aware. */
  #failure(code: number | null, signal: string | null, stderr: readonly string[]): Error {
    for (const line of stderr) {
      const m = /^AGY_ERROR:\s*(\{.*\})\s*$/.exec(line);
      if (!m) continue;
      let message: string | undefined;
      try {
        const parsed: unknown = JSON.parse(m[1] as string);
        const short = (parsed as { short_error?: unknown } | null)?.short_error;
        if (typeof short === "string") message = short;
      } catch {
        // fall through to the generic message
      }
      if (message !== undefined) {
        return AUTH_ERROR.test(message)
          ? new QuotaAuthError(this.id, message)
          : new QuotaReaderError(this.id, `agy /usage failed: ${message}`);
      }
    }
    return new QuotaReaderError(this.id, `agy /usage exited with ${signal ?? `code ${code}`}`);
  }

  #parse(lines: readonly string[], readAt: string): QuotaWindow[] {
    const json = parseJsonObject(lines);
    const parsed = UsageSchema.safeParse(json);
    if (!parsed.success) {
      throw new QuotaFormatError(this.id, "unexpected /usage output", { cause: parsed.error });
    }
    const windows = new Map<string, QuotaWindow>();
    let seen = 0;
    for (const group of parsed.data.command.data.groups) {
      const model = groupOf(
        group.name,
        group.buckets.map((b) => b.id),
      );
      for (const bucket of group.buckets) {
        seen++;
        const period = periodOf(bucket);
        if (!model || !period) continue;
        const kind = `${period}:${model}`;
        const usedPct = Math.min(100, Math.max(0, (1 - bucket.remaining_fraction) * 100));
        const prev = windows.get(kind);
        if (prev && (prev.usedPct ?? 0) >= usedPct) continue; // keep the more used one
        windows.set(kind, {
          kind,
          usedPct: Math.round(usedPct * 100) / 100,
          resetAt: toIso(bucket.reset_time),
          source: this.id,
          readAt,
          reliability: "real",
        });
      }
    }
    if (seen > 0 && windows.size === 0) {
      throw new QuotaFormatError(this.id, "no bucket with a known group and window");
    }
    return [...windows.values()];
  }
}

/** The JSON document in the output: the whole text, else the last line that is a JSON object. */
function parseJsonObject(lines: readonly string[]): unknown {
  const attempts = [lines.join("\n"), ...[...lines].reverse()];
  for (const text of attempts) {
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null) return value;
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

function toIso(value: string | null | undefined): string | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
