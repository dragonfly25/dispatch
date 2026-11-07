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
 * Deny-list: even when named in `allow` or `passthrough`, names matching {@link isDeniedEnvName}
 * (agent-host markers such as `CLAUDECODE*`, `CLAUDE_CODE_*`, `CODEX_*`, `ANTIGRAVITY_*`, API keys,
 * anything containing `TOKEN`, and `NODE_OPTIONS`) are dropped. The only way through is the
 * separate `dangerouslyAllow` list: an explicit, greppable opt-in for the rare case where a
 * child genuinely needs one of those variables. Never feed it from repo-level config.
 */

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

/** Matches an exact name, or a `PREFIX*` pattern. */
function matches(pattern: string, name: string): boolean {
  return pattern.endsWith("*") ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
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
  const dangerous = new Set(opts.dangerouslyAllow ?? []);
  const listedPatterns = [...(opts.allow ?? []), ...opts.passthrough];

  const env: Record<string, string> = {};
  const forwardedNames = new Set<string>();
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue;
    const base = BASE_NAMES.includes(name) || BASE_PATTERNS.some((p) => matches(p, name));
    const listed = listedPatterns.some((p) => matches(p, name));
    if (dangerous.has(name) || ((base || listed) && !isDeniedEnvName(name))) {
      env[name] = value;
      forwardedNames.add(name);
    }
  }
  env.TERM = "dumb";
  Object.assign(env, opts.extra);
  env.DISPATCH_DEPTH = String(depth + 1);
  if (opts.runId !== undefined) env.DISPATCH_RUN_ID = opts.runId;

  const sent = new Set(Object.values(env));
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value === undefined || value === "" || forwardedNames.has(name) || sent.has(value))
      continue;
    secrets.add(value);
  }
  return { env, secrets: [...secrets] };
}
