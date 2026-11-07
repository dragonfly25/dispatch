/**
 * Claude Code adapter (WP14): runs `claude -p --safe-mode` children with credential deny rules
 * and a fail-closed OS sandbox, parses `stream-json`, and reads quota passively from
 * `rate_limit_event`. See docs/spikes/claude-code.md for the verified flags and shapes.
 *
 * Scratch conventions (`AdapterRunContext.scratch`):
 * - in: `instanceId` (string), set by the runner; needed to emit quota observations.
 * - out: `quotaObservations` (QuotaObservation[]), `model` (string from `system/init`),
 *   `claude` (internal parse state).
 */
import type { Adapter, AdapterCapabilities } from "../../core/contracts.js";
import { finalizeClaude } from "./finalize.js";
import { buildClaudeInvocation } from "./invocation.js";
import { parseClaudeLine } from "./parse.js";
import { probeClaude } from "./probe.js";

export {
  buildClaudeInvocation,
  CLAUDE_MAX_TURNS,
  CLAUDE_REQUIRED_FLAGS,
  CLAUDE_SIDE_EFFECT_GUARDS,
  childSettings,
  deniedPaths,
  wrapPrompt,
} from "./invocation.js";
export { CLAUDE_QUOTA_SOURCE, windowKind } from "./parse.js";
export { parseClaudeVersion, parseHelpFlags, satisfiesRange } from "./probe.js";

/** Static capabilities of the claude adapter. `pool` is overridden per instance by the caller. */
export const CLAUDE_CAPABILITIES: AdapterCapabilities = {
  id: "claude",
  version: "0.1.0",
  cliRange: ">=2.1.301 <2.2",
  streaming: true,
  autonomy: ["read-only", "worktree"],
  quotaChannel: "passive+reader",
  pool: "subscription",
  experimental: false,
  promptChannel: "stdin",
  isolation: {
    userHooks: "disabled",
    userPlugins: "builtin_only",
    userMcp: "disabled",
    projectConfig: "disabled",
  },
  sandbox: "os",
  childNetwork: "none",
};

/**
 * Creates the claude adapter. Pass `pool` to report the billing pool of the instance it serves
 * (`ProviderInstance.pool`); it defaults to "subscription".
 */
export function createClaudeAdapter(opts: { pool?: AdapterCapabilities["pool"] } = {}): Adapter {
  const caps: AdapterCapabilities = { ...CLAUDE_CAPABILITIES, pool: opts.pool ?? "subscription" };
  return {
    caps,
    probe: (instance, deps) => probeClaude(instance, deps, caps.cliRange),
    buildInvocation: buildClaudeInvocation,
    parseLine: parseClaudeLine,
    finalize: finalizeClaude,
  };
}
