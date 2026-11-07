/**
 * Registry of the built-in adapters, by adapter id (the `adapter:` of a provider instance).
 * Read-only commands use the static capabilities; the runner uses {@link createAdapter}.
 */
import { AGY_CAPABILITIES, createAgyAdapter } from "../adapters/agy/index.js";
import { CLAUDE_CAPABILITIES, createClaudeAdapter } from "../adapters/claude/index.js";
import { CODEX_CAPABILITIES, createCodexAdapter } from "../adapters/codex/index.js";
import type { Adapter, AdapterCapabilities, Pool } from "../core/contracts.js";

/** Static capabilities of every built-in adapter. */
export const ADAPTER_CAPABILITIES: Readonly<Record<string, AdapterCapabilities>> = {
  claude: CLAUDE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  antigravity: AGY_CAPABILITIES,
};

/** Capabilities of `adapterId`, or `null` for an adapter Dispatch does not ship. */
export function adapterCapabilities(adapterId: string): AdapterCapabilities | null {
  return ADAPTER_CAPABILITIES[adapterId] ?? null;
}

/** Creates the built-in adapter `adapterId` (`pool` is the billing pool of the instance served). */
export function createAdapter(adapterId: string, pool?: Pool): Adapter | null {
  switch (adapterId) {
    case "claude":
      return createClaudeAdapter(pool ? { pool } : {});
    case "codex":
      return createCodexAdapter();
    case "antigravity":
      return createAgyAdapter();
    default:
      return null;
  }
}
