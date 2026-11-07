/**
 * Codex CLI adapter (`codex exec --json`), verified against codex-cli 0.167.0
 * (docs/spikes/codex.md, fixtures in test/fixtures/codex/0.167.0/).
 *
 * Runner conventions (scratch keys of {@link AdapterRunContext}):
 * - `outputFileContent`: the runner reads `Invocation.outputFile` after exit and stores its text
 *   here before calling `finalize`; it is the preferred summary. `finalize` stays pure.
 * - `clock`: optional {@link Clock} for event timestamps and `resetAt` (system clock otherwise).
 * Quota readings come from the app-server reader (WP18), so `readQuota` is not implemented here.
 */
import type { Adapter, AdapterCapabilities } from "../../core/contracts.js";
import { buildCodexInvocation } from "./invocation.js";
import { finalizeCodex, parseCodexLine } from "./parse.js";
import { probeCodex } from "./probe.js";

export {
  buildCodexInvocation,
  CODEX_OUTPUT_FILE,
  CODEX_SIDE_EFFECT_GUARDS,
  tomlString,
  untrustedProjectsOverride,
  wrapPrompt,
} from "./invocation.js";
export { CODEX_QUOTA_PATTERN, finalizeCodex, parseCodexLine, parseResetAt } from "./parse.js";
export { codexVersionInRange, probeCodex } from "./probe.js";

/** Static capabilities of the codex adapter. */
export const CODEX_CAPABILITIES: AdapterCapabilities = {
  id: "codex",
  version: "0.1.0",
  cliRange: ">=0.167.0 <0.168",
  streaming: true,
  autonomy: ["read-only", "worktree"],
  quotaChannel: "reader",
  pool: "subscription",
  experimental: false,
  promptChannel: "stdin",
  isolation: {
    userHooks: "disabled", // --disable hooks
    userPlugins: "disabled", // --disable plugins
    userMcp: "disabled", // --ignore-user-config (MCP servers live in ~/.codex/config.toml)
    projectConfig: "disabled", // untrusted project override disables <repo>/.codex/
  },
  sandbox: "os",
  childNetwork: "none",
};

/** Creates the codex adapter. */
export function createCodexAdapter(): Adapter {
  return {
    caps: CODEX_CAPABILITIES,
    probe: (instance, deps) => probeCodex(instance, deps),
    buildInvocation: buildCodexInvocation,
    parseLine: parseCodexLine,
    finalize: finalizeCodex,
  };
}
