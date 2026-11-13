/**
 * Child environment construction (plan §2 "Child isolation").
 *
 * A child never inherits the parent's environment. It receives only:
 *  1. the base allow-list: `PATH HOME USER LOGNAME LANG LC_* TMPDIR SHELL` (plus `TERM=dumb`),
 *  2. names listed in `allow` (adapter-owned needs) and `passthrough` (user config `envPassthrough`),
 *  3. `extra`, explicit values chosen by Dispatch itself (e.g. a provider config-dir variable
 *     such as `CODEX_HOME`); these are trusted and bypass the deny-list,
 *  4. `DISPATCH_DEPTH=depth+1` and, when given, `DISPATCH_RUN_ID`; these always win.
 *
 * Windows: the base list also carries {@link WINDOWS_BASE_ENV} (system variables a child needs to
 * start). Environment names are case-insensitive there, so every name and pattern is matched
 * without regard to case (the parent may have `Path`), each variable is emitted once under the
 * parent's spelling, and Dispatch's own values replace a parent variable of any spelling.
 *
 * Deny-list: even when named in `allow` or `passthrough`, names matching {@link isDeniedEnvName}
 * (agent-host markers such as `CLAUDECODE*`, `CLAUDE_CODE_*`, `CODEX_*`, `ANTIGRAVITY_*`, API keys,
 * anything containing `TOKEN`, and `NODE_OPTIONS`) are dropped. The only way through is the
 * separate `dangerouslyAllow` list: an explicit, greppable opt-in for the rare case where a
 * child genuinely needs one of those variables. Never feed it from repo-level config.
 */
import { isWindows, type OsPlatform, WINDOWS_BASE_ENV } from "../platform/os.js";

/** Exact base names forwarded from the parent when present. */
const BASE_NAMES: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "TMPDIR",
  "SHELL",
];
const BASE_PATTERNS: readonly string[] = ["LC_*"];

const DENY: readonly RegExp[] = [
  /^CLAUDECODE/,
  /^CLAUDE_CODE_/,
  /^CODEX_/,
  /^ANTIGRAVITY_/,
  /_API_KEY$/,
  /TOKEN/,
  /^NODE_OPTIONS$/,
];

/** True when `name` is blocked from `allow`/`passthrough` (case-insensitive). */
export function isDeniedEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return DENY.some((re) => re.test(upper));
}

/** Matches an exact name, or a `PREFIX*` pattern (case-insensitively when `fold`). */
function matches(pattern: string, name: string, fold = false): boolean {
  const p = fold ? pattern.toUpperCase() : pattern;
  const n = fold ? name.toUpperCase() : name;
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : p === n;
}

/** Sets `name` in `env`, first dropping any other spelling of it when `fold` (Windows). */
function setVar(env: Record<string, string>, name: string, value: string, fold: boolean): void {
  if (fold) {
    const upper = name.toUpperCase();
    for (const k of Object.keys(env)) if (k !== name && k.toUpperCase() === upper) delete env[k];
  }
  env[name] = value;
}

/** Options for {@link buildChildEnv}. */
export interface BuildChildEnvOptions {
  /** The parent's environment (normally `process.env`). */
  parentEnv: Readonly<Record<string, string | undefined>>;
  /** Extra names (or `PREFIX*` patterns) forwarded on top of the base list; deny-list applies. */
  allow?: readonly string[];
  /** Names from the user's `envPassthrough` config; deny-list applies. */
  passthrough: readonly string[];
  /** Explicit values set by Dispatch itself; trusted, not filtered. */
  extra: Readonly<Record<string, string>>;
  /** Depth of the current process; the child gets `depth + 1`. */
  depth: number;
  /** Becomes `DISPATCH_RUN_ID` when given. */
  runId?: string;
  /** Names forwarded even if denied. Dangerous: see the module comment. */
  dangerouslyAllow?: readonly string[];
  /** OS whose base list and name rules apply. Default `process.platform`. */
  platform?: OsPlatform;
}

/** Result of {@link buildChildEnv}. */
export interface ChildEnv {
  /** Exactly the environment to hand to the child. */
  env: Record<string, string>;
  /**
   * Values of parent variables that were NOT forwarded, deduplicated. Feed them to the state
   * store's redactor so a leaked value is masked in logs and events.
   */
  secrets: string[];
}

/** Builds the child environment from an allow-list. See the module comment for the rules. */
export function buildChildEnv(opts: BuildChildEnvOptions): ChildEnv {
  const { parentEnv, depth } = opts;
  const fold = isWindows(opts.platform ?? process.platform);
  const baseNames = fold ? [...BASE_NAMES, ...WINDOWS_BASE_ENV] : BASE_NAMES;
  const dangerousList = opts.dangerouslyAllow ?? [];
  const listedPatterns = [...(opts.allow ?? []), ...opts.passthrough];

  const env: Record<string, string> = {};
  const forwardedNames = new Set<string>();
  /** Upper-cased names already emitted (Windows: one variable per name, whatever the spelling). */
  const seen = new Set<string>();
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    if (fold && seen.has(name.toUpperCase())) continue;
    const base =
      baseNames.some((b) => matches(b, name, fold)) ||
      BASE_PATTERNS.some((p) => matches(p, name, fold));
    const listed = listedPatterns.some((p) => matches(p, name, fold));
    const dangerous = dangerousList.some((d) =>
      fold ? d.toUpperCase() === name.toUpperCase() : d === name,
    );
    if (dangerous || ((base || listed) && !isDeniedEnvName(name))) {
      env[name] = value;
      forwardedNames.add(name);
      seen.add(name.toUpperCase());
    }
  }
  setVar(env, "TERM", "dumb", fold);
  for (const [name, value] of Object.entries(opts.extra)) setVar(env, name, value, fold);
  setVar(env, "DISPATCH_DEPTH", String(depth + 1), fold);
  if (opts.runId !== undefined) setVar(env, "DISPATCH_RUN_ID", opts.runId, fold);

  const sent = new Set(Object.values(env));
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined || value === "" || forwardedNames.has(name) || sent.has(value))
      continue;
    secrets.add(value);
  }
  return { env, secrets: [...secrets] };
}
