import { join } from "node:path";
import type { Invocation } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import type { McpServer } from "../../mcp/resolve.js";
import type { BuildInvocationWithWeb, WebAccess } from "../../web/index.js";

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

/** The `-c` key prefix of one forwarded server (names are validated by the resolver too). */
function serverKey(s: McpServer): string {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(s.name)) {
    throw new DispatchError(
      `codex: invalid MCP server name ${JSON.stringify(s.name)}`,
      undefined,
      "adapter.codex.invalid_target",
    );
  }
  return `mcp_servers.${s.name}`;
}

const tomlArray = (xs: readonly string[]): string => `[${xs.map(tomlString).join(",")}]`;

/**
 * `-c` overrides that load exactly the forwarded servers (live-verified on 0.167: they apply with
 * `--ignore-user-config --strict-config --disable plugins`). Secrets travel by variable NAME only:
 * `env_vars` for stdio, `env_http_headers` for HTTP. Every tool is pre-approved, since `codex exec`
 * refuses an MCP call that needs approval. Referenced variables are excluded from the agent's
 * shell environment, so only the server process sees them.
 */
export function mcpOverrides(servers: readonly McpServer[]): string[] {
  const out: string[] = [];
  const c = (kv: string) => out.push("-c", kv);
  for (const s of servers) {
    const key = serverKey(s);
    if (s.transport === "stdio") {
      c(`${key}.command=${tomlString(s.command ?? "")}`);
      c(`${key}.args=${tomlArray(s.args ?? [])}`);
      if (s.envRefs.length > 0) c(`${key}.env_vars=${tomlArray(s.envRefs)}`);
    } else if (s.transport === "http") {
      c(`${key}.url=${tomlString(s.url ?? "")}`);
      const headers = Object.entries(s.headers).map(
        ([h, v]) => `${tomlString(h)}=${tomlString(v)}`,
      );
      if (headers.length > 0) c(`${key}.env_http_headers={${headers.join(",")}}`);
    } else {
      throw new DispatchError(
        `codex: MCP transport ${s.transport} cannot be forwarded`,
        undefined,
        "adapter.mcp_unsupported",
      );
    }
    c(`${key}.default_tools_approval_mode="approve"`);
  }
  const vars = [...new Set(servers.flatMap((s) => [...s.envRefs, ...s.headerRefs]))];
  if (vars.length > 0) c(`shell_environment_policy.exclude=${tomlArray(vars)}`);
  return out;
}

/**
 * The `web_search` mode for the requested web access (live-verified on 0.167, docs/spikes/
 * web-access.md): `cached` (OpenAI's index, no live fetch) is enough for `WebSearch`; `WebFetch`
 * must open a given URL, which needs `live`. The tool runs model-side: the shell sandbox's network
 * is unchanged. No access: no override (codex's own default applies, as before).
 */
export function webOverride(web: WebAccess | undefined): string[] {
  if (web === undefined) return [];
  return ["-c", `web_search=${web === "fetch" ? '"live"' : '"cached"'}`];
}

/**
 * Builds the `codex exec` child command (pure). Prompt goes on stdin (trailing `-`).
 * `worktree` and `repoRoot` must be canonical (realpath) paths, since codex keys project trust
 * on them. `mcpServers` (optional) adds only those MCP servers ({@link mcpOverrides}); the user's
 * own MCP config stays ignored. `web` (optional) turns on codex's web search ({@link webOverride}).
 * Throws {@link DispatchError} for `direct` autonomy, a missing binary, or when a
 * required isolation feature is unknown to the installed CLI (fail closed).
 */
export function buildCodexInvocation(args: BuildInvocationWithWeb): Invocation {
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
    ...mcpOverrides(args.mcpServers ?? []),
    ...webOverride(args.web),
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
    sideEffectGuards: [
      ...CODEX_SIDE_EFFECT_GUARDS,
      ...(args.mcpServers?.length ? ["codex-mcp-forwarded-only"] : []),
      ...(args.web ? ["codex-web-model-side-only"] : []),
    ],
  };
}
