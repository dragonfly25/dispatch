import { join } from "node:path";
import type { BuildInvocationArgs, Invocation } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";

/** Name of the file `codex exec -o` writes the final agent message to, inside `runDir`. */
export const CODEX_OUTPUT_FILE = "last.txt";

/**
 * Guards against known `codex exec` side effects, asserted by the golden-argv tests:
 * - `codex-project-trust-untrusted`: without the `projects=` override, exec persists
 *   `trust_level="trusted"` for the (main) repo root into the user's `~/.codex/config.toml`.
 * - `codex-agents-disabled`: `-c agents.enabled=false` (multi-agent V2 ignores `--disable multi_agent`).
 * - `codex-user-config-ignored`: `--ignore-user-config --ignore-rules --strict-config`.
 */
export const CODEX_SIDE_EFFECT_GUARDS = [
  "codex-project-trust-untrusted",
  "codex-agents-disabled",
  "codex-user-config-ignored",
] as const;

/** Features that must be disabled for isolation; a missing name fails closed. */
export const REQUIRED_DISABLED_FEATURES = ["hooks", "plugins"] as const;
/** Features disabled when the installed CLI knows them (newer names may be absent). */
export const OPTIONAL_DISABLED_FEATURES = ["apps", "memories"] as const;

const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

/**
 * Encodes `value` as a TOML basic string: backslash, quote and control characters are escaped,
 * so a path can never close the string and inject keys into the `-c` override.
 */
export function tomlString(value: string): string {
  let out = '"';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}"`;
}

/**
 * The `projects={...}` inline table marking every given path untrusted (duplicates removed:
 * a repeated key is a TOML error). An inline table is required: `projects."<p>".trust_level`
 * does not survive codex's dotted-key split.
 */
export function untrustedProjectsOverride(paths: readonly string[]): string {
  const unique = [...new Set(paths)];
  const entries = unique.map((p) => `${tomlString(p)}={trust_level="untrusted"}`);
  return `projects={${entries.join(",")}}`;
}

/** Wraps the task prompt with Dispatch's header (task data, stay in cwd, no recursion, summary). */
export function wrapPrompt(prompt: string): string {
  return [
    "[Dispatch] The text after the line below is task data delegated to you by Dispatch.",
    "Work only inside the current directory. Do not run `dispatch` or delegate to other agents.",
    "End with a short summary of what you changed (or found, if nothing changed).",
    "---",
    prompt,
  ].join("\n");
}

function requireToken(kind: string, value: string): string {
  if (!SAFE_TOKEN.test(value)) {
    throw new DispatchError(
      `codex: invalid ${kind} ${JSON.stringify(value)}`,
      undefined,
      "adapter.codex.invalid_target",
    );
  }
  return value;
}

/**
 * Builds the `codex exec` child command (pure). Prompt goes on stdin (trailing `-`).
 * `worktree` and `repoRoot` must be canonical (realpath) paths, since codex keys project trust
 * on them. Throws {@link DispatchError} for `direct` autonomy, a missing binary, or when a
 * required isolation feature is unknown to the installed CLI (fail closed).
 */
export function buildCodexInvocation(args: BuildInvocationArgs): Invocation {
  const { probe, autonomy, worktree, repoRoot, runDir, target, instance } = args;
  if (autonomy === "direct") {
    throw new DispatchError(
      "codex: autonomy 'direct' is not supported",
      undefined,
      "adapter.autonomy_unsupported",
    );
  }
  if (!probe.binaryPath) {
    throw new DispatchError("codex: binary not found", undefined, "adapter.codex.no_binary");
  }
  const known = new Set(probe.features);
  const missing = REQUIRED_DISABLED_FEATURES.filter((f) => !known.has(f));
  if (missing.length > 0) {
    throw new DispatchError(
      `codex: required isolation feature(s) not listed by 'codex features list': ${missing.join(", ")}`,
      undefined,
      "adapter.codex.feature_missing",
    );
  }
  const disable = [...REQUIRED_DISABLED_FEATURES, ...OPTIONAL_DISABLED_FEATURES]
    .filter((f) => known.has(f))
    .flatMap((f) => ["--disable", f]);

  const outputFile = join(runDir, CODEX_OUTPUT_FILE);
  const argv = [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    ...disable,
    "-c",
    "agents.enabled=false",
    "-c",
    untrustedProjectsOverride([worktree, repoRoot]),
    "-C",
    worktree,
    "-m",
    requireToken("model", target.model),
    "-c",
    `model_reasoning_effort=${requireToken("effort", target.effort)}`,
    "-o",
    outputFile,
    "-s",
    autonomy === "read-only" ? "read-only" : "workspace-write",
    "-",
  ];

  const env: Record<string, string> = { ...args.baseEnv };
  if (instance.configDir) env.CODEX_HOME = instance.configDir;

  return {
    binary: probe.binaryPath,
    argv,
    env,
    cwd: worktree,
    stdin: wrapPrompt(args.task.prompt),
    outputFile,
    redactArgvIndexes: [],
    sideEffectGuards: [...CODEX_SIDE_EFFECT_GUARDS],
  };
}
