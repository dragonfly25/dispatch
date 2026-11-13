/** The built-in quota readers, registered under the adapter ids they serve. */
import type { Clock, ProviderInstance, QuotaObservation, Spawner } from "../../core/contracts.js";
import type { QuotaStore } from "../provider.js";
import { QuotaReaderRegistry } from "../reader.js";
import type { ReliabilityConfig } from "../reliability.js";
import { AgyUsageReader } from "./agy-usage.js";
import { ClaudePassiveReader } from "./claude-passive.js";
import { ClaudeUsageReader } from "./claude-usage.js";
import { CodexAppServerReader } from "./codex-app-server.js";

export * from "./agy-usage.js";
export * from "./claude-passive.js";
export * from "./claude-usage.js";
export * from "./claude-usage-parse.js";
export * from "./codex-app-server.js";
export * from "./env.js";
export * from "./errors.js";

/** Dependencies of {@link defaultReaders}. */
export interface DefaultReadersOptions {
  clock: Clock;
  /** Runs `agy` and `claude -p /usage`. */
  spawner: Spawner;
  /** Where the claude adapter's passive readings are stored (the quota core's store). */
  store: Pick<QuotaStore, "latestQuotaReadings">;
  /** Dispatch version for the codex `clientInfo`. */
  version?: string;
  /** Base for child environments (default `process.env`). */
  env?: Readonly<Record<string, string | undefined>>;
  reliability?: Partial<ReliabilityConfig>;
  /** Wire to `QuotaProvider.recordObservation` so Codex exhaustion becomes an unavailability signal. */
  onObservation?: (observation: QuotaObservation) => void | Promise<void>;
  /**
   * Resolves an instance's CLI to an absolute path (config `binary:` -> PATH -> well-known dirs),
   * as the adapters do; null when not found. Without it, or on null, the readers spawn
   * `instance.binary ?? <name>`.
   */
  resolveBinary?: (
    name: string,
    instance: ProviderInstance,
  ) => string | null | Promise<string | null>;
  /** Haiku fallback of the claude-usage reader (config `quota.readers.claude-usage.llm_fallback`, default true). */
  claudeLlmFallback?: boolean;
}

/**
 * Registry with claude-passive and claude-usage (claude), codex-app-server (codex) and agy-usage
 * (antigravity). Per window kind the quota core keeps the reading with the latest `readAt`, so a
 * fresh `/usage` reading wins over an older passive one.
 */
export function defaultReaders(options: DefaultReadersOptions): QuotaReaderRegistry {
  const { clock, spawner, store, version, env, reliability, onObservation } = options;
  const llmFallback = options.claudeLlmFallback !== false;
  const resolver = (name: string) => {
    const resolve = options.resolveBinary;
    if (!resolve) return {};
    return {
      resolveBinary: async (instance: ProviderInstance) =>
        (await resolve(name, instance)) ?? instance.binary ?? name,
    };
  };
  return new QuotaReaderRegistry()
    .register(
      "claude",
      new ClaudePassiveReader({ store, clock, ...(reliability ? { reliability } : {}) }),
    )
    .register(
      "claude",
      new ClaudeUsageReader({
        spawner,
        clock,
        llmFallback,
        ...(env ? { env } : {}),
        ...resolver("claude"),
      }),
    )
    .register(
      "codex",
      new CodexAppServerReader({
        clock,
        ...(version ? { version } : {}),
        ...(env ? { env } : {}),
        ...(onObservation ? { onObservation } : {}),
        ...resolver("codex"),
      }),
    )
    .register(
      "antigravity",
      new AgyUsageReader({ spawner, clock, ...(env ? { env } : {}), ...resolver("agy") }),
    );
}
