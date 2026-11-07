/**
 * Read-only resolver of the user's Claude Code MCP server definitions (MCP forwarding).
 *
 * Sources, as Claude Code 2.1.301 resolves them (same name in several scopes: the first wins):
 *  1. local:   `<claude.json>` `projects[<repo root>].mcpServers`
 *  2. project: `<repo root>/.mcp.json` `mcpServers` (only servers the user approved in Claude Code:
 *     `enabledMcpjsonServers` / `enableAllProjectMcpServers`, not in `disabledMcpjsonServers`)
 *  3. user:    `<claude.json>` top-level `mcpServers`
 * `<claude.json>` is `$CLAUDE_CONFIG_DIR/.claude.json` when that variable is set, else
 * `~/.claude.json`. Nothing here writes, and nothing calls `claude mcp`.
 *
 * Secrets rule: credential values are never copied. A server is forwardable only when every env
 * and header value is a pure `${VAR}` reference; the child then receives `VAR` by name from
 * Dispatch's own environment at run time (never on disk, in argv, state or logs).
 */
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** Transport of an MCP server. */
export type McpTransport = "stdio" | "http" | "sse";
/** Where a definition came from (Claude Code's scope names). */
export type McpScope = "local" | "project" | "user";

/** One MCP server as Dispatch sees it. Values of env and headers are never kept. */
export interface McpServer {
  name: string;
  scope: McpScope;
  transport: McpTransport;
  command?: string;
  args?: string[];
  url?: string;
  /** Variables the server's env references (`NAME: ${NAME}` entries; same-name only). */
  envRefs: string[];
  /** Variables the server's headers reference. */
  headerRefs: string[];
  /** Header name → referenced variable name. */
  headers: Record<string, string>;
  forwardable: boolean;
  /** Why the server is not forwardable. */
  reason?: string;
}

/** A requested server that will not be forwarded, and why. */
export interface DroppedServer {
  name: string;
  reason: string;
}

/** Result of {@link resolveForwardedServers}. */
export interface ForwardResolution {
  /** Forwardable servers, in request order. */
  servers: McpServer[];
  /** Requested servers that cannot be forwarded. */
  dropped: DroppedServer[];
}

type Env = Readonly<Record<string, string | undefined>>;

/** Reads a file as text; null when it is missing or unreadable. Injectable for tests. */
export type ReadText = (path: string) => string | null;

/** A {@link ReadText} that reads each path once (the hook cache lists many repos). */
export function memoRead(read: ReadText = defaultRead): ReadText {
  const seen = new Map<string, string | null>();
  return (path) => {
    if (!seen.has(path)) seen.set(path, read(path));
    return seen.get(path) ?? null;
  };
}

const defaultRead: ReadText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Server names usable as a TOML key and in `mcp__<name>__*` tool names. */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** A pure `${VAR}` reference (no default, no surrounding text). */
const PURE_REF = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
/** Variables a server may never reference: host markers, Dispatch's own, loader hooks. */
const RESERVED = /^(CLAUDECODE|CLAUDE_CODE_|CODEX_|ANTIGRAVITY_|DISPATCH_|NODE_OPTIONS$|LD_|DYLD_)/;

/** Reasons shown by doctor and in returned-to-host results. */
export const REASONS = {
  literal: "literal secret in env/headers",
  helper: "headersHelper/OAuth server",
  notFound: "not configured (built-in or unknown server)",
  name: "unsupported server name",
  transport: "unsupported transport",
  sse: "sse transport cannot be forwarded (codex hosts stdio and streamable HTTP only)",
  rename: `env renames a variable (only NAME: \${NAME} entries can be passed by name)`,
  reserved: "references a reserved variable",
  expand: "variable reference in command, args or url",
  unapproved: "project .mcp.json server not approved in Claude Code",
  malformed: "malformed definition",
} as const;

/** Path of Claude Code's global config file (`.claude.json`). */
export function claudeJsonPath(env: Env): string | null {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, ".claude.json");
  return env.HOME ? join(env.HOME, ".claude.json") : null;
}

function parseJson(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** Paths under which Claude Code may have recorded the repo in `projects`. */
function projectKeys(repoRoot: string): string[] {
  const keys = [repoRoot];
  try {
    const real = realpathSync(repoRoot);
    if (real !== repoRoot) keys.push(real);
  } catch {
    // A missing root has no other spelling.
  }
  return keys;
}

/** `projects[<repo root>]` of `.claude.json`, or an empty object. */
function projectEntry(claudeJson: Record<string, unknown> | null, repoRoot: string) {
  const projects = claudeJson?.projects;
  if (!isObject(projects)) return {};
  for (const k of projectKeys(repoRoot)) {
    const e = projects[k];
    if (isObject(e)) return e;
  }
  return {};
}

/** Approval of `.mcp.json` servers as recorded by Claude Code (user-written files only). */
function approvals(
  entry: Record<string, unknown>,
  userSettings: Record<string, unknown> | null,
  localSettings: Record<string, unknown> | null,
) {
  const layers = [entry, userSettings ?? {}, localSettings ?? {}];
  return {
    all: layers.some((l) => l.enableAllProjectMcpServers === true),
    enabled: new Set(layers.flatMap((l) => strings(l.enabledMcpjsonServers))),
    disabled: new Set(layers.flatMap((l) => strings(l.disabledMcpjsonServers))),
  };
}

function hasExpansion(s: string | undefined): boolean {
  return s?.includes("${") ?? false;
}

/** Turns one raw definition into an {@link McpServer} (forwardable or not, with a reason). */
export function describeServer(name: string, scope: McpScope, raw: unknown): McpServer {
  const base: McpServer = {
    name,
    scope,
    transport: "stdio",
    envRefs: [],
    headerRefs: [],
    headers: {},
    forwardable: false,
  };
  const no = (reason: string): McpServer => ({ ...base, forwardable: false, reason });
  if (!isObject(raw)) return no(REASONS.malformed);
  const type = raw.type ?? (typeof raw.url === "string" ? "http" : "stdio");
  if (type !== "stdio" && type !== "http" && type !== "sse") return no(REASONS.transport);
  base.transport = type;
  if (typeof raw.command === "string") base.command = raw.command;
  if (Array.isArray(raw.args)) base.args = strings(raw.args);
  if (typeof raw.url === "string") base.url = raw.url;
  if (!SAFE_NAME.test(name)) return no(REASONS.name);
  if (raw.headersHelper !== undefined || raw.oauth !== undefined) return no(REASONS.helper);
  if (type === "stdio" ? !base.command : !base.url) return no(REASONS.malformed);

  const env = raw.env ?? {};
  const headers = raw.headers ?? {};
  if (!isObject(env) || !isObject(headers)) return no(REASONS.malformed);
  let renamed = false;
  for (const [key, value] of Object.entries(env)) {
    const ref = typeof value === "string" ? PURE_REF.exec(value)?.[1] : undefined;
    if (ref === undefined) return no(REASONS.literal);
    if (ref !== key) renamed = true;
    base.envRefs.push(ref);
  }
  for (const [key, value] of Object.entries(headers)) {
    const ref = typeof value === "string" ? PURE_REF.exec(value)?.[1] : undefined;
    if (ref === undefined) return no(REASONS.literal);
    base.headers[key] = ref;
    base.headerRefs.push(ref);
  }
  if (renamed) return no(REASONS.rename);
  if ([...base.envRefs, ...base.headerRefs].some((v) => RESERVED.test(v))) {
    return no(REASONS.reserved);
  }
  if (hasExpansion(base.command) || hasExpansion(base.url) || base.args?.some(hasExpansion)) {
    return no(REASONS.expand);
  }
  if (type === "sse") return no(REASONS.sse);
  const ok = { ...base, forwardable: true };
  delete ok.reason;
  return ok;
}

/** Options of {@link listMcpServers}. */
export interface ListOptions {
  /** Test seam: reads a file (default: `readFileSync`, null on error). */
  read?: ReadText;
}

/**
 * Every MCP server Claude Code would load in `repoRoot`, with its forwardability. A missing or
 * malformed file contributes nothing. Sorted by name. `repoRoot` null lists the user scope only
 * (servers available in every repository).
 */
export function listMcpServers(
  repoRoot: string | null,
  env: Env,
  opts: ListOptions = {},
): McpServer[] {
  const read = opts.read ?? defaultRead;
  const jsonPath = claudeJsonPath(env);
  const claudeJson = jsonPath ? parseJson(read(jsonPath)) : null;
  const entry = repoRoot === null ? {} : projectEntry(claudeJson, repoRoot);
  const configDir = env.CLAUDE_CONFIG_DIR ?? (env.HOME ? join(env.HOME, ".claude") : null);
  const userSettings = configDir ? parseJson(read(join(configDir, "settings.json"))) : null;
  const local = repoRoot === null ? null : read(join(repoRoot, ".claude", "settings.local.json"));
  const approved = approvals(entry, userSettings, parseJson(local));
  const project = repoRoot === null ? null : parseJson(read(join(repoRoot, ".mcp.json")));

  const found = new Map<string, McpServer>();
  const add = (scope: McpScope, servers: unknown) => {
    if (!isObject(servers)) return;
    for (const [name, raw] of Object.entries(servers)) {
      if (found.has(name)) continue;
      let s = describeServer(name, scope, raw);
      const ok = approved.all ? !approved.disabled.has(name) : approved.enabled.has(name);
      if (scope === "project" && s.forwardable && (!ok || approved.disabled.has(name))) {
        s = { ...s, forwardable: false, reason: REASONS.unapproved };
      }
      found.set(name, s);
    }
  };
  add("local", entry.mcpServers);
  add("project", project?.mcpServers);
  add("user", claudeJson?.mcpServers);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Names of the forwardable servers of `repoRoot` (null: user scope only), for the hook cache. */
export function forwardableNames(
  repoRoot: string | null,
  env: Env,
  opts: ListOptions = {},
): string[] {
  return listMcpServers(repoRoot, env, opts)
    .filter((s) => s.forwardable)
    .map((s) => s.name);
}

/**
 * Resolves the servers a run asked for (the handoff's `mcpServers`) at run time: the hook's view
 * is never trusted. A server is dropped when it is unknown, no longer forwardable, or references a
 * variable that is not set in `env` (Dispatch's own environment).
 */
export function resolveForwardedServers(
  repoRoot: string,
  names: readonly string[],
  env: Env,
  opts: ListOptions = {},
): ForwardResolution {
  const all = new Map(listMcpServers(repoRoot, env, opts).map((s) => [s.name, s]));
  const servers: McpServer[] = [];
  const dropped: DroppedServer[] = [];
  for (const name of new Set(names)) {
    const s = all.get(name);
    if (!s) dropped.push({ name, reason: REASONS.notFound });
    else if (!s.forwardable) dropped.push({ name, reason: s.reason ?? REASONS.malformed });
    else {
      const unset = [...s.envRefs, ...s.headerRefs].filter((v) => !env[v]);
      if (unset.length > 0) {
        dropped.push({ name, reason: `${unset.join(", ")} not set in Dispatch's environment` });
      } else servers.push(s);
    }
  }
  return { servers, dropped };
}

/** Every variable name the servers reference (env and headers), deduplicated. */
export function referencedVariables(servers: readonly McpServer[]): string[] {
  return [...new Set(servers.flatMap((s) => [...s.envRefs, ...s.headerRefs]))];
}
