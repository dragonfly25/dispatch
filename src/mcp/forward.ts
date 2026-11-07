/**
 * What each adapter can do with forwarded MCP servers, and how the servers reach
 * `Adapter.buildInvocation` without touching the frozen {@link BuildInvocationArgs}: the runner
 * passes {@link BuildInvocationWithMcp} (a structural superset), adapters read `mcpServers`.
 *
 * Verified live (docs/spikes/mcp-forwarding.md):
 * - codex 0.167: `-c mcp_servers.<name>.*` overrides still apply with `--ignore-user-config
 *   --strict-config --disable plugins`; `env_vars` passes variables by name; exec needs
 *   `default_tools_approval_mode="approve"` or every MCP call is refused.
 * - claude 2.1.301: `--safe-mode` drops `--mcp-config` servers (init lists none), and dropping
 *   `--safe-mode` would load the user's hooks, plugins and CLAUDE.md: claude targets cannot
 *   receive MCP servers in v0.x.
 * - antigravity: never (read-only, experimental).
 */
import { type BuildInvocationArgs, ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { McpServer, McpTransport } from "./resolve.js";

/** Optional extension of the invocation arguments carrying the servers of this run. */
export interface McpForwarding {
  /** Servers to load in the child, already re-resolved by the runner. Absent/empty: none. */
  mcpServers?: readonly McpServer[];
}

/** {@link BuildInvocationArgs} plus the forwarded servers. */
export type BuildInvocationWithMcp = BuildInvocationArgs & McpForwarding;

/** Transports each adapter can host; adapters not listed host none. */
const HOSTED: Readonly<Record<string, readonly McpTransport[]>> = {
  codex: ["stdio", "http"],
};

/** Why an adapter cannot host MCP servers at all (doctor and returned-to-host reasons). */
export const MCP_UNSUPPORTED: Readonly<Record<string, string>> = {
  claude: "claude --safe-mode ignores --mcp-config, so claude targets cannot receive MCP servers",
  antigravity: "antigravity never receives MCP servers (read-only, experimental)",
};

/** True when `adapterId` can load every server in `servers` (always true for none). */
export function adapterCanHost(adapterId: string, servers: readonly McpServer[]): boolean {
  if (servers.length === 0) return true;
  const ok = HOSTED[adapterId] ?? [];
  return servers.every((s) => ok.includes(s.transport));
}

/**
 * Fails closed in an adapter that cannot host MCP servers when a run still carries some (the
 * router should have filtered it out): the child would silently lack tools the agent needs.
 */
export function refuseMcp(adapterId: string, args: McpForwarding): void {
  if (!args.mcpServers?.length) return;
  throw new DispatchError(
    MCP_UNSUPPORTED[adapterId] ?? `${adapterId} cannot receive MCP servers`,
    ExitCode.REJECTED,
    "adapter.mcp_unsupported",
  );
}

/** Adapter ids that can host MCP servers at all. */
export function mcpCapableAdapters(): string[] {
  return Object.keys(HOSTED);
}
