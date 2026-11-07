/** The built-in quota readers, registered under the adapter ids they serve. */
import type { Clock, QuotaObservation, Spawner } from "../../core/contracts.js";
import type { QuotaStore } from "../provider.js";
import { QuotaReaderRegistry } from "../reader.js";
import type { ReliabilityConfig } from "../reliability.js";
import { AgyUsageReader } from "./agy-usage.js";
import { ClaudePassiveReader } from "./claude-passive.js";
import { CodexAppServerReader } from "./codex-app-server.js";

export * from "./agy-usage.js";
export * from "./claude-passive.js";
export * from "./codex-app-server.js";
export * from "./env.js";
export * from "./errors.js";

/** Dependencies of {@link defaultReaders}. */
export interface DefaultReadersOptions {
  clock: Clock;
  /** Runs `agy`. */
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
}

/** Registry with claude-passive (claude), codex-app-server (codex) and agy-usage (antigravity). */
export function defaultReaders(options: DefaultReadersOptions): QuotaReaderRegistry {
  const { clock, spawner, store, version, env, reliability, onObservation } = options;
  return new QuotaReaderRegistry()
    .register(
      "claude",
      new ClaudePassiveReader({ store, clock, ...(reliability ? { reliability } : {}) }),
    )
    .register(
      "codex",
      new CodexAppServerReader({
        clock,
        ...(version ? { version } : {}),
        ...(env ? { env } : {}),
        ...(onObservation ? { onObservation } : {}),
      }),
    )
    .register("antigravity", new AgyUsageReader({ spawner, clock, ...(env ? { env } : {}) }));
}
