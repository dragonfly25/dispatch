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
  /** True when native sub-agent spawns are redirected (Codex `deny_redirect`). */
  hardMode: boolean;
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
