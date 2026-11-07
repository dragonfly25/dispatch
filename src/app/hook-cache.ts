/**
 * The hook cache writer. Host hooks (`hook.mjs`) never load the configuration or open SQLite:
 * they read `~/.dispatch/hook-cache.json`, which the CLI rewrites whenever trust or the active
 * policy changes (`trust`, `use`, `install`, `setup`, `uninstall`).
 *
 * The cache holds one policy summary, the one in effect where the command ran (the repo's
 * trusted policy when the command runs inside a trusted repo, else the global one), and the list
 * of trusted repositories (the SessionStart hook is silent outside them).
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { globalConfigPath, parseYaml } from "../config/index.js";
import { type GlobalConfigFile, GlobalConfigFileSchema } from "../config/schema.js";
import type { RoutingConfig, Rule, RuleAction, RuleMatch } from "../core/routing.js";
import {
  type HookCache,
  type PolicySummary,
  type TrustedRepo,
  writeHookCache,
} from "../hook/cache.js";
import { DEFAULT_CLAUDE_INTERCEPT } from "../hosts/claude-code/hook.js";
import { type AppContext, type LoadAppContextOptions, loadAppContext } from "./context.js";

/** Longest summary written (the Claude hook cuts at 2000 characters). */
const MAX_SUMMARY_CHARS = 1800;
/** Most rules described; the rest are counted. */
const MAX_RULES = 10;

/** Repo-controlled strings (globs, ids) go into the host model's context: keep them inert. */
function inert(text: string, max = 80): string {
  return text.replace(/[^\w@./*?{},!\-[\]:+ ]/g, "").slice(0, max);
}

const list = (xs: readonly string[]) => xs.map((x) => inert(x)).join(", ");

function describeMatch(m: RuleMatch): string {
  const parts: string[] = [];
  if (m.taskType?.length) parts.push(`${list(m.taskType)} tasks`);
  if (m.paths?.length) parts.push(`paths ${list(m.paths)}`);
  if (m.tier?.length) parts.push(`tier ${list(m.tier)}`);
  if (m.autonomy?.length) parts.push(`${list(m.autonomy)} autonomy`);
  return parts.length > 0 ? parts.join(" and ") : "all other tasks";
}

function describeAction(a: RuleAction): string {
  switch (a.type) {
    case "provider":
      return `delegated to ${inert(a.instance)}`;
    case "host":
      return "kept on the host (never delegated)";
    case "fallback":
      return `delegated to ${a.instances.map((i) => inert(i)).join(", then ")}${
        a.strategy === "most_remaining" ? " (most remaining quota first)" : ""
      }, then back to the host`;
    case "fanout":
      return `second opinion from ${list(a.instances)} (results are not merged)`;
    case "reject":
      return "rejected";
  }
}

const line = (r: Rule) => `- ${describeMatch(r.match)}: ${describeAction(r.action)}.`;

/**
 * A short plain-text description of the routing policy: the pins first, then the active
 * profile's rules (which task types go to which instances), then the default. Rule descriptions
 * and reject reasons are free text and are left out; only structure is described.
 */
export function summarizePolicy(routing: RoutingConfig): string {
  const profile = routing.profiles[routing.activeProfile];
  const pins = routing.pins.filter((r) => r.id !== "flag:provider");
  const rules = [...pins, ...(profile?.rules ?? [])];
  const lines = [`Routing policy (profile ${inert(routing.activeProfile)}):`];
  lines.push(...rules.slice(0, MAX_RULES).map(line));
  if (rules.length > MAX_RULES) lines.push(`- ...and ${rules.length - MAX_RULES} more rule(s).`);
  const kept = pins.filter((r) => r.action.type === "host" && r.match.paths?.length);
  if (kept.length > 0) {
    lines.push(`Pinned to the host: ${list(kept.flatMap((r) => r.match.paths ?? []))}.`);
  }
  lines.push("A task no rule delegates stays on the host.");
  return lines.join("\n").slice(0, MAX_SUMMARY_CHARS);
}

/** Absolute checkout root of a trusted repository id (`<root>/.git`); null for a bare repo. */
function rootOf(repoId: string): string | null {
  return basename(repoId) === ".git" ? dirname(repoId) : null;
}

/** The global config file, or null when it is missing or unreadable. */
function globalFile(ctx: AppContext): GlobalConfigFile | null {
  const path = globalConfigPath(ctx.env);
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, "utf8"), path, GlobalConfigFileSchema);
  } catch {
    return null;
  }
}

/** The repositories recorded in the global config's `trusted_repos`. */
function trustedRepos(global: GlobalConfigFile | null): TrustedRepo[] {
  return Object.entries(global?.trusted_repos ?? {}).flatMap(([id, entry]) => {
    const root = rootOf(id);
    return root === null ? [] : [{ root, policyHash: entry.hash }];
  });
}

/** Rule actions that send a task to a provider. */
const DELEGATING = new Set<RuleAction["type"]>(["provider", "fallback", "fanout"]);

/**
 * True when some pin or rule of the active profile routes tasks to a provider, i.e. a native
 * Codex sub-agent spawn has somewhere to go. A policy that keeps everything on the host is false.
 */
export function policyDelegates(routing: RoutingConfig): boolean {
  const profile = routing.profiles[routing.activeProfile];
  const pins = routing.pins.filter((r) => r.id !== "flag:provider");
  return [...pins, ...(profile?.rules ?? [])].some((r) => DELEGATING.has(r.action.type));
}

/** The cache contents for the policy in effect in `ctx`. */
export function buildHookCache(ctx: AppContext): HookCache {
  const global = globalFile(ctx);
  const policy: PolicySummary = {
    profile: ctx.config.routing.activeProfile,
    hardMode: global?.hosts?.codex?.hard ?? true,
    hardInterception: policyDelegates(ctx.config.routing),
    claudeHard: global?.hosts?.["claude-code"]?.hard ?? true,
    claudeIntercept: global?.hosts?.["claude-code"]?.intercept ?? [...DEFAULT_CLAUDE_INTERCEPT],
    summary: summarizePolicy(ctx.config.routing),
  };
  return {
    version: 1,
    writtenAt: ctx.clock.now().toISOString(),
    trustedRepos: trustedRepos(global),
    policy,
  };
}

/** Rewrites `<dispatchHome>/hook-cache.json` from `ctx` and returns what was written. */
export function refreshHookCache(ctx: AppContext): HookCache {
  const cache = buildHookCache(ctx);
  writeHookCache(ctx.dispatchHome, cache);
  return cache;
}

/**
 * Reloads the configuration (so a just-trusted policy or a just-switched profile is in effect)
 * and refreshes the cache. Never throws: a cache that cannot be written is reported through
 * `warn` and the command that triggered it still succeeds (the hooks stay silent until the next
 * refresh).
 */
export function refreshHookCacheSafely(
  opts: LoadAppContextOptions,
  warn: (message: string) => void,
): void {
  try {
    const ctx = loadAppContext(opts);
    try {
      refreshHookCache(ctx);
    } finally {
      ctx.close();
    }
  } catch (err) {
    warn(`could not refresh the hook cache: ${err instanceof Error ? err.message : String(err)}`);
  }
}
