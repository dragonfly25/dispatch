/**
 * Run-time side of MCP forwarding: the server names a run asks for (the handoff's `mcpServers`)
 * are re-resolved from the user's Claude config here, never taken from the hook's view. Any
 * problem returns the task to the host with a reason; nothing is forwarded without consent
 * (`hosts.claude-code.forward_mcp`).
 */
import type { RoutingConfig } from "../core/routing.js";
import { adapterCanHost } from "../mcp/forward.js";
import {
  type ForwardResolution,
  type McpServer,
  referencedVariables,
  resolveForwardedServers,
} from "../mcp/resolve.js";
import { restrictToCapable } from "../router/capability.js";

type Env = Readonly<Record<string, string | undefined>>;

/** Resolver signature (injectable for tests). */
export type McpResolver = (
  repoRoot: string,
  names: readonly string[],
  env: Env,
) => ForwardResolution;

/** What {@link planMcp} decided. */
export type McpPlan =
  | { ok: true; servers: McpServer[]; routing: RoutingConfig; excluded: string[] }
  | { ok: false; reason: string };

/** Inputs of {@link planMcp}. */
export interface McpPlanInput {
  /** Requested server names; empty means no forwarding (the plan is a no-op). */
  wanted: readonly string[];
  /** Consent: `hosts.claude-code.forward_mcp` after tighten-only merging. */
  forwardMcp: boolean;
  repoRoot: string;
  env: Env;
  routing: RoutingConfig;
  resolve?: McpResolver;
}

/**
 * Re-resolves the requested servers and restricts routing to instances that can host them all.
 * Fails (task back to the host) when consent is off, a server is not forwardable any more, or no
 * enabled instance can host the servers.
 */
export function planMcp(input: McpPlanInput): McpPlan {
  const wanted = [...new Set(input.wanted)];
  if (wanted.length === 0) {
    return { ok: true, servers: [], routing: input.routing, excluded: [] };
  }
  const names = wanted.join(", ");
  if (!input.forwardMcp) {
    return {
      ok: false,
      reason: `the agent needs MCP server(s) ${names}, and MCP forwarding is off (hosts.claude-code.forward_mcp)`,
    };
  }
  const res = (input.resolve ?? resolveForwardedServers)(input.repoRoot, wanted, input.env);
  if (res.dropped.length > 0) {
    const why = res.dropped.map((d) => `${d.name}: ${d.reason}`).join("; ");
    return { ok: false, reason: `MCP server(s) cannot be forwarded (${why})` };
  }
  const r = restrictToCapable(input.routing, (a) => adapterCanHost(a, res.servers));
  if (r.remaining.length === 0) {
    return {
      ok: false,
      reason: `no enabled provider can host MCP server(s) ${names} (only codex receives MCP servers)`,
    };
  }
  return { ok: true, servers: res.servers, routing: r.routing, excluded: r.excluded };
}

/** Names and values of the variables the servers need, for the child env and the redactor. */
export function mcpVariables(
  servers: readonly McpServer[],
  env: Env,
): { names: string[]; values: string[] } {
  const names = referencedVariables(servers);
  const values = names.flatMap((n) => (env[n] ? [env[n] as string] : []));
  return { names, values };
}
