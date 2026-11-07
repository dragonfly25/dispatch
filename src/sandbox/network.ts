/**
 * Opt-in shell sandbox network for delegated agents (`network:` in the global config).
 *
 * Off by default. When the effective scope covers a run, its worktree attempts get a sandbox that
 * may listen on localhost, reach the Docker socket and the internet (live-verified, see
 * docs/spikes/sandbox-network.md):
 * - codex 0.167: `-c sandbox_workspace_write.network_access=true` (workspace-write only; the
 *   read-only sandbox has no network setting, `sandbox_read_only` is an unknown key).
 * - claude 2.1.301: `sandbox.network` in `--settings` (`allowLocalBinding`, `allowAllUnixSockets`,
 *   `allowedDomains: ["*"]`); the credential `denyRead` list still applies.
 * Package managers cannot write their default caches (`~/.npm`, the pnpm store) from inside the
 * sandbox, so the child gets per-attempt caches under TMPDIR ({@link packageCacheEnv}).
 *
 * The request reaches `Adapter.buildInvocation` without touching the frozen
 * `BuildInvocationArgs`: the runner passes {@link BuildInvocationWithNetwork} (a structural
 * superset), adapters read `network`. Pure module.
 */
import { join } from "node:path";
import type { NetworkScope } from "../config/merge.js";
import type { BuildInvocationWithWeb } from "../web/index.js";

export type { NetworkScope };

/** The agent name of a run a host session starts without a handoff. */
export const GENERAL_PURPOSE = "general-purpose";

/** Sandbox network given to one attempt; absent: none (the adapter adds nothing). */
export interface SandboxNetwork {
  /** Writable directory (outside the worktree) for package-manager caches of this attempt. */
  cacheDir: string;
}

/** Optional extension of the invocation arguments carrying the sandbox network. */
export interface NetworkForwarding {
  network?: SandboxNetwork;
}

/** `BuildInvocationArgs` plus MCP servers, web access and sandbox network. */
export type BuildInvocationWithNetwork = BuildInvocationWithWeb & NetworkForwarding;

/** The effective decision of one run, stored in its result (`sandboxNetwork`) and run log. */
export interface NetworkDecision {
  /** True when worktree attempts of the run get the sandbox network. */
  enabled: boolean;
  /** Effective `network` scope. */
  scope: NetworkScope;
  /** The delegated agent the run belongs to; null for a run started by hand. */
  agent: string | null;
  /** Why, in one short phrase. */
  reason: string;
}

/** Inputs of {@link decideNetwork}. */
export interface NetworkInput {
  scope: NetworkScope;
  /** Global `network_agents`; undefined = every delegated agent. */
  agents?: readonly string[] | undefined;
  /** {@link runAgent} of the run. */
  agent: string | null;
}

/**
 * The agent a run belongs to: the handoff's custom agent, else {@link GENERAL_PURPOSE} when a host
 * session (Claude Code, Codex) started it, else null (a terminal or a script).
 */
export function runAgent(handoffAgent: string | undefined, hostDetected: boolean): string | null {
  if (handoffAgent !== undefined) return handoffAgent;
  return hostDetected ? GENERAL_PURPOSE : null;
}

/** Whether the run gets the sandbox network, and why. Pure. */
export function decideNetwork(input: NetworkInput): NetworkDecision {
  const { scope, agent } = input;
  const out = (enabled: boolean, reason: string): NetworkDecision => ({
    enabled,
    scope,
    agent,
    reason,
  });
  if (scope === "off") return out(false, "network: off");
  if (scope === "all") return out(true, "network: all");
  if (agent === null) return out(false, "not a delegated agent (network: delegated-agents)");
  if (input.agents !== undefined && !input.agents.includes(agent)) {
    return out(false, `${agent} is not in network_agents`);
  }
  return out(true, `delegated agent ${agent} (network: delegated-agents)`);
}

/** The per-attempt cache directory under `tmp`: `<tmp>/dispatch-net/<runId>-<attempt>`. */
export function cacheDirFor(tmp: string, runId: string, attempt: number): string {
  return join(tmp, "dispatch-net", `${runId}-${attempt}`);
}

/**
 * Env that points npm and pnpm at writable caches inside `cacheDir` (verified live: without it
 * npm fails on `~/.npm` and pnpm on its global store, or pnpm drops a store into the worktree).
 */
export function packageCacheEnv(net: SandboxNetwork): Record<string, string> {
  return {
    npm_config_cache: join(net.cacheDir, "npm"),
    npm_config_store_dir: join(net.cacheDir, "pnpm-store"),
  };
}

/** One line for `logs` / `run` output: `on (delegated agent x ...)` or `off (...)`. */
export function describeNetwork(d: NetworkDecision): string {
  return `${d.enabled ? "on" : "off"} (${d.reason})`;
}
