/**
 * The hook cache, `~/.dispatch/hook-cache.json`: everything a host hook needs, so the hook path
 * never opens the SQLite database (plan §2 "State"). Written atomically by the CLI whenever
 * trust or the active policy changes; read (never written) by `hook.mjs`.
 *
 * Imports node built-ins only: this module is bundled into the ≤ 80 ms hook entry.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";

/** File name of the hook cache inside the Dispatch home. */
export const HOOK_CACHE_FILE = "hook-cache.json";

/** A repo whose `.dispatch/` policy the user trusted (`dispatch trust`). */
export interface TrustedRepo {
  /** Absolute repo root. */
  root: string;
  /** Hash of the trusted repo policy, when one exists. */
  policyHash: string | null;
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
  /**
   * MCP server names that may be forwarded to the external agent for this repo (written by the
   * MCP forwarding feature). Absent: none, so custom agents that use MCP tools stay on Claude.
   */
  forwardableMcp?: string[];
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

/** `$DISPATCH_HOME`, else `$HOME/.dispatch`; null when neither is set. */
export function hookDispatchHome(env: Env): string | null {
  if (env.DISPATCH_HOME) return env.DISPATCH_HOME;
  return env.HOME ? join(env.HOME, ".dispatch") : null;
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
        (r.policyHash === null || typeof r.policyHash === "string"),
    ) &&
    p !== undefined &&
    typeof p.profile === "string" &&
    typeof p.hardMode === "boolean" &&
    (p.hardInterception === undefined || typeof p.hardInterception === "boolean") &&
    (p.claudeHard === undefined || typeof p.claudeHard === "boolean") &&
    optionalStrings(p.claudeIntercept) &&
    optionalStrings(p.claudeExclude) &&
    (p.claudeAutoApply === undefined || typeof p.claudeAutoApply === "boolean") &&
    optionalStrings(p.forwardableMcp) &&
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

/** The trusted repo containing `cwd` (the longest matching root), or null. */
export function trustedRepoFor(cache: HookCache, cwd: string): TrustedRepo | null {
  let best: TrustedRepo | null = null;
  for (const r of cache.trustedRepos) {
    const inside = cwd === r.root || cwd.startsWith(r.root.endsWith(sep) ? r.root : r.root + sep);
    if (inside && (best === null || r.root.length > best.root.length)) best = r;
  }
  return best;
}
