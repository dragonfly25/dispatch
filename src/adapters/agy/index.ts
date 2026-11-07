import type { Adapter, AdapterCapabilities } from "../../core/contracts.js";
import { finalizeAgy } from "./finalize.js";
import { buildAgyInvocation } from "./invocation.js";
import { parseAgyLine } from "./parse.js";
import { probeAgy } from "./probe.js";

export { parseResetDelayMs } from "./finalize.js";
export { REQUIRED_FLAGS, wrapPrompt } from "./invocation.js";
export { satisfiesRange } from "./version.js";

/**
 * Capabilities of the Antigravity (`agy`) adapter. Experimental and read-only: agy enforces
 * read-only only through headless permission auto-deny (`sandbox: "permission-only"`; `--sandbox`
 * has no effect when the sandbox is unavailable). `childNetwork: "none"` describes shell commands
 * (auto-denied); agy's own web tools are not verified. User hooks, plugins, MCP and project
 * config (`.agents/`) cannot be disabled, so `doctor` discloses them. The prompt is passed as
 * `-p=<prompt>`: agy ignores stdin. Quota is read out-of-band from `/usage` (WP18).
 *
 * Runner conventions (`AdapterRunContext.scratch`): `now` is an optional `() => Date` stamping
 * events; `endedAt` is the ISO time the child ended, set before `finalize` to resolve relative
 * quota resets ("Resets in 2h39m").
 */
export const AGY_CAPABILITIES: AdapterCapabilities = {
  id: "antigravity",
  version: "0.1.0",
  cliRange: ">=1.5.2 <1.6",
  streaming: true,
  autonomy: ["read-only"],
  quotaChannel: "reader",
  pool: "subscription",
  experimental: true,
  promptChannel: "argv",
  isolation: {
    userHooks: "not_disableable",
    userPlugins: "not_disableable",
    userMcp: "not_disableable",
    projectConfig: "not_disableable",
  },
  sandbox: "permission-only",
  childNetwork: "none",
};

/** Creates the Antigravity adapter (read-only, experimental). */
export function createAgyAdapter(): Adapter {
  return {
    caps: AGY_CAPABILITIES,
    probe: (instance, deps) => probeAgy(instance, deps, AGY_CAPABILITIES),
    buildInvocation: buildAgyInvocation,
    parseLine: parseAgyLine,
    finalize: finalizeAgy,
  };
}
