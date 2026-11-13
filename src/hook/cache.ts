/**
 * The hook cache, `~/.dispatch/hook-cache.json`: everything a host hook needs, so the hook path
 * never opens the SQLite database (plan §2 "State"). Written atomically by the CLI whenever
 * trust or the active policy changes; read (never written) by `hook.mjs`.
 *
 * Imports node built-ins only: this module is bundled into the ≤ 80 ms hook entry.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isPathInside, pathApi } from "../config/pathkey.js";
import { envGet, homeDir, type OsPlatform } from "../platform/os.js";

/** File name of the hook cache inside the Dispatch home. */
export const HOOK_CACHE_FILE = "hook-cache.json";

/** A repo whose `.dispatch/` policy the user trusted (`dispatch trust`). */
export interface TrustedRepo {
  /** Absolute repo root. */
  root: string;
  /** Hash of the trusted repo policy, when one exists. */
  policyHash: string | null;
  /**
   * MCP servers forwardable in this repo (user, project and local scope), when forwarding is on.
   * Absent or empty: none. Read it through {@link forwardableMcpFor}.
   */
  forwardableMcp?: string[];
  /** False when this repo's merged config turns web forwarding off (`forward_web: false`). */
  forwardWeb?: boolean;
  /** False when this repo's merged config turns the isolated browser or the network off. */
  browser?: boolean;
}

/** Summary of the active routing policy, injected by SessionStart hooks. */
export interface PolicySummary {
  /** Active profile name, e.g. "balance". */
  profile: string;
  /** Codex hard mode is switched on (`hosts.codex.hard`, default true). */
  hardMode: boolean;
  /**
   * True when the policy delegates at least one kind of task (some pin or profile rule routes to
   * a provider). With `hardMode`, the Codex PreToolUse hook redirects native sub-agent spawns
   * (`deny_redirect`); otherwise the spawn proceeds. Absent in caches written before WP27: false.
   */
  hardInterception?: boolean;
  /**
   * Claude Code hard mode (`hosts.claude-code.hard`, default true): with `hardInterception`, the
   * Claude PreToolUse hook rewrites intercepted `Agent` calls to the `dispatch:dispatch` sub-agent.
   * Absent in caches written before Claude hard mode: false (soft only).
   */
  claudeHard?: boolean;
  /**
   * Sub-agent types the Claude hook intercepts (`hosts.claude-code.intercept`): `"auto"` means
   * general-purpose plus every eligible custom agent, `"*"` every eligible type, other entries
   * are an allow-list. Absent: `["auto"]`.
   */
  claudeIntercept?: string[];
  /** Sub-agent types the Claude hook never intercepts (`hosts.claude-code.exclude`). */
  claudeExclude?: string[];
  /**
   * Successful runs of intercepted custom agents are applied by the relay
   * (`hosts.claude-code.auto_apply`, default true). Absent: true.
   */
  claudeAutoApply?: boolean;
  /** MCP forwarding consent (`hosts.claude-code.forward_mcp`). Absent: false. */
  forwardMcp?: boolean;
  /**
   * User-scope MCP servers forwardable in every repo (empty when forwarding is off). Absent: none.
   * Per-repo lists (with project and local servers) are on {@link TrustedRepo.forwardableMcp}.
   */
  forwardableMcp?: string[];
  /** Web forwarding (`hosts.claude-code.forward_web`, default true). Absent: true. */
  forwardWeb?: boolean;
  /**
   * The isolated browser is enabled (`hosts.claude-code.browser`), installed (pinned, integrity
   * checked) and Google Chrome was found when the cache was written. Absent: false.
   */
  browser?: boolean;
  /** Why {@link browser} is false (doctor and the agent listing show it). */
  browserReason?: string;
  /** Global sandbox network scope (`network`, `on` normalized to `all`). Absent: off. */
  network?: "off" | "delegated-agents" | "all";
  /** Global `network_agents` (absent: every delegated agent). */
  networkAgents?: string[];
  /** One short paragraph for the host model (`additionalContext`). */
  summary: string;
}

/** Contents of {@link HOOK_CACHE_FILE} (format version 1). */
export interface HookCache {
  version: 1;
  /** ISO-8601 UTC time the cache was written. */
  writtenAt: string;
  trustedRepos: TrustedRepo[];
  policy: PolicySummary;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * `$DISPATCH_HOME`, else `<home>/.dispatch` (`HOME`; on Windows also `USERPROFILE`); null when
 * neither is set.
 */
export function hookDispatchHome(env: Env, platform: OsPlatform = process.platform): string | null {
  const explicit = envGet(env, "DISPATCH_HOME", platform);
  if (explicit) return explicit;
  const home = homeDir(env, platform);
  return home ? pathApi(platform).join(home, ".dispatch") : null;
}

/** True for `undefined` or an array of strings. */
function optionalStrings(v: unknown): boolean {
  return v === undefined || (Array.isArray(v) && v.every((t) => typeof t === "string"));
}

function isCache(v: unknown): v is HookCache {
  if (v === null || typeof v !== "object") return false;
  const c = v as Partial<HookCache>;
  const p = c.policy as Partial<PolicySummary> | undefined;
  return (
    c.version === 1 &&
    typeof c.writtenAt === "string" &&
    Array.isArray(c.trustedRepos) &&
    c.trustedRepos.every(
      (r) =>
        r !== null &&
        typeof r === "object" &&
        typeof r.root === "string" &&
        (r.policyHash === null || typeof r.policyHash === "string") &&
        optionalStrings(r.forwardableMcp) &&
        (r.forwardWeb === undefined || typeof r.forwardWeb === "boolean") &&
        (r.browser === undefined || typeof r.browser === "boolean"),
    ) &&
    p !== undefined &&
    typeof p.profile === "string" &&
    typeof p.hardMode === "boolean" &&
    (p.hardInterception === undefined || typeof p.hardInterception === "boolean") &&
    (p.claudeHard === undefined || typeof p.claudeHard === "boolean") &&
    optionalStrings(p.claudeIntercept) &&
    optionalStrings(p.claudeExclude) &&
    (p.claudeAutoApply === undefined || typeof p.claudeAutoApply === "boolean") &&
    (p.forwardMcp === undefined || typeof p.forwardMcp === "boolean") &&
    optionalStrings(p.forwardableMcp) &&
    (p.forwardWeb === undefined || typeof p.forwardWeb === "boolean") &&
    (p.browser === undefined || typeof p.browser === "boolean") &&
    (p.browserReason === undefined || typeof p.browserReason === "string") &&
    (p.network === undefined || NETWORK_SCOPES.includes(p.network)) &&
    optionalStrings(p.networkAgents) &&
    typeof p.summary === "string"
  );
}

/** Reads the cache; null when it is missing, unreadable or not format version 1. */
export function readHookCache(dispatchHome: string): HookCache | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dispatchHome, HOOK_CACHE_FILE), "utf8"));
    return isCache(v) ? v : null;
  } catch {
    return null;
  }
}

/** Writes the cache atomically (temp file + rename, mode 0600). */
export function writeHookCache(dispatchHome: string, cache: HookCache): void {
  if (!isCache(cache)) throw new Error("invalid hook cache");
  mkdirSync(dispatchHome, { recursive: true });
  const target = join(dispatchHome, HOOK_CACHE_FILE);
  const tmp = `${target}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * MCP servers an agent running in `cwd` may have forwarded: the trusted repo's own list when the
 * cache has one, else the user-scope `policy.forwardableMcp`; empty when forwarding is off.
 * The runner re-resolves every server at run time, so this only decides eligibility.
 */
export function forwardableMcpFor(cache: HookCache, cwd: string): string[] {
  if (cache.policy.forwardMcp !== true) return [];
  return trustedRepoFor(cache, cwd)?.forwardableMcp ?? cache.policy.forwardableMcp ?? [];
}

/**
 * Whether an agent running in `cwd` may be given web access: the global switch (absent: on) and
 * the trusted repo's own `forward_web: false`. The runner checks the merged setting again.
 */
export function forwardWebFor(cache: HookCache, cwd: string): boolean {
  if (cache.policy.forwardWeb === false) return false;
  return trustedRepoFor(cache, cwd)?.forwardWeb !== false;
}

const NETWORK_SCOPES: readonly unknown[] = ["off", "delegated-agents", "all"];

/**
 * Whether `agent`, running in `cwd`, may get the isolated browser: it must be ready (enabled,
 * installed, Chrome found), not turned off by the repo, and the run must get the sandbox network
 * (the same rule as `decideNetwork` in src/sandbox/network.ts, which this bundle cannot import).
 * Returns true, or why not. The runner checks everything again with the merged config.
 */
export function browserFor(cache: HookCache, cwd: string, agent: string): true | string {
  const p = cache.policy;
  if (p.browser !== true) {
    return p.browserReason ?? "the isolated browser is off (hosts.claude-code.browser)";
  }
  if (trustedRepoFor(cache, cwd)?.browser === false) {
    return "this repo's config turns the isolated browser or the sandbox network off";
  }
  const scope = p.network ?? "off";
  const inScope =
    scope === "all" ||
    (scope === "delegated-agents" &&
      (p.networkAgents === undefined || p.networkAgents.includes(agent)));
  if (!inScope) {
    return scope === "off"
      ? "needs network: set network: delegated-agents"
      : `needs network: add ${agent} to network_agents`;
  }
  return true;
}

/**
 * The trusted repo containing `cwd` (the longest matching root), or null. On Windows the match
 * ignores case and `/` vs `\`.
 */
export function trustedRepoFor(
  cache: HookCache,
  cwd: string,
  platform: OsPlatform = process.platform,
): TrustedRepo | null {
  let best: TrustedRepo | null = null;
  for (const r of cache.trustedRepos) {
    const inside = isPathInside(cwd, r.root, platform);
    if (inside && (best === null || r.root.length > best.root.length)) best = r;
  }
  return best;
}
