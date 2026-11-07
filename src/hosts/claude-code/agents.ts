/**
 * The user's own Claude Code sub-agents (`<repo>/.claude/agents/*.md`, `~/.claude/agents/*.md`):
 * a tiny frontmatter parser, the lookup of an agent by type, and the eligibility rules that decide
 * whether Dispatch may run it on another provider (hard mode, UC2).
 *
 * Read only: agent files are never written, moved or copied. Imports node built-ins only, because
 * it is bundled into the ≤ 80 ms hook entry; every problem means "not found" or "not eligible".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Largest agent file read (bytes); a bigger file is ignored. */
export const MAX_AGENT_FILE = 64 * 1024;
/** Largest instructions body handed to another provider (bytes); over it the agent stays on Claude. */
export const MAX_AGENT_BODY = 32 * 1024;
/** Most files scanned in one agents directory when matching by frontmatter `name:`. */
export const MAX_AGENT_SCAN = 200;

/** Fields of an agent file Dispatch uses. */
export interface AgentDefinition {
  name: string | null;
  description: string | null;
  model: string | null;
  effort: string | null;
  /** `tools:` entries; null when absent or `*` (every tool). */
  tools: string[] | null;
  /** The instructions (the file body after the frontmatter). */
  body: string;
}

/** A located agent file. */
export interface AgentFile {
  name: string;
  source: "project" | "user";
  path: string;
  def: AgentDefinition;
}

/** Where agents are looked up. */
export interface AgentDirs {
  /** `<repo root>/.claude/agents`, or null. */
  project: string | null;
  /** `<CLAUDE_CONFIG_DIR or ~/.claude>/agents`, or null. */
  user: string | null;
}

/** Strips one pair of matching surrounding quotes. */
function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && (t[0] === '"' || t[0] === "'") && t.at(-1) === t[0]) return t.slice(1, -1);
  return t;
}

/** Splits a comma list or an inline YAML list (`[a, b]`) into trimmed, unquoted entries. */
function splitList(v: string): string[] {
  const t = v.trim();
  const inner = t.startsWith("[") && t.endsWith("]") ? t.slice(1, -1) : t;
  return inner
    .split(",")
    .map(unquote)
    .filter((x) => x !== "");
}

/**
 * Parses an agent file: a `---` frontmatter block of `key: value` lines (block lists with `- x`
 * and `|`/`>` block scalars are understood) followed by the instructions. Returns null for a file
 * without a closed frontmatter block or with a line it cannot read.
 */
export function parseAgentFile(text: string): AgentDefinition | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return null;
  const fields = new Map<string, string | string[]>();
  let i = 1;
  while (i < end) {
    const line = lines[i] as string;
    i++;
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z_][\w-]*)\s*:(.*)$/.exec(line);
    if (!m) return null;
    const key = (m[1] as string).toLowerCase();
    const raw = (m[2] as string).trim();
    if (raw === "" || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const items: string[] = [];
      const block: string[] = [];
      while (i < end && /^\s+\S/.test(lines[i] as string)) {
        const l = (lines[i] as string).trim();
        if (l.startsWith("- ")) items.push(unquote(l.slice(2)));
        else block.push(l);
        i++;
      }
      fields.set(key, items.length > 0 ? items : block.join(raw.startsWith(">") ? " " : "\n"));
    } else fields.set(key, raw);
  }
  const str = (k: string): string | null => {
    const v = fields.get(k);
    if (typeof v !== "string") return null;
    const s = unquote(v);
    return s === "" ? null : s;
  };
  const rawTools = fields.get("tools");
  let tools: string[] | null = null;
  if (Array.isArray(rawTools)) tools = rawTools.filter((t) => t !== "");
  else if (typeof rawTools === "string" && rawTools.trim() !== "") tools = splitList(rawTools);
  if (tools !== null && (tools.length === 0 || tools.includes("*"))) tools = null;
  return {
    name: str("name"),
    description: str("description"),
    model: str("model"),
    effort: str("effort"),
    tools,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

/** Reads and parses one agent file; null when missing, not a regular file, too big or malformed. */
function readAgent(path: string): AgentDefinition | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_AGENT_FILE) return null;
    return parseAgentFile(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** True for a sub-agent type that can name a file (no path separators, no plugin prefix). */
function plainType(type: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(type);
}

/** The agent `type` in one directory: `<type>.md` first, then a file whose `name:` is `type`. */
function findIn(dir: string, type: string): { path: string; def: AgentDefinition } | null {
  const direct = join(dir, `${type}.md`);
  const def = readAgent(direct);
  if (def !== null && (def.name === null || def.name === type)) return { path: direct, def };
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md") && n !== `${type}.md`);
  } catch {
    return null;
  }
  for (const n of names.slice(0, MAX_AGENT_SCAN)) {
    const path = join(dir, n);
    const d = readAgent(path);
    if (d?.name === type) return { path, def: d };
  }
  return null;
}

/**
 * The agent file for sub-agent `type`: the project's agents first, then the user's. Null for a
 * plugin agent (`plugin:name`), a type that cannot be a file name, or no matching file (built-in
 * types such as Explore or Plan have no file).
 */
export function findAgent(type: string, dirs: AgentDirs): AgentFile | null {
  if (!plainType(type)) return null;
  for (const source of ["project", "user"] as const) {
    const dir = dirs[source];
    if (dir === null) continue;
    const hit = findIn(dir, type);
    if (hit) return { name: type, source, ...hit };
  }
  return null;
}

/** Every agent file of `dirs` (project first; a user agent shadowed by a project one is left out). */
export function listAgents(dirs: AgentDirs): AgentFile[] {
  const out: AgentFile[] = [];
  const seen = new Set<string>();
  for (const source of ["project", "user"] as const) {
    const dir = dirs[source];
    if (dir === null) continue;
    let names: string[];
    try {
      names = readdirSync(dir)
        .filter((n) => n.endsWith(".md"))
        .sort();
    } catch {
      continue;
    }
    for (const n of names.slice(0, MAX_AGENT_SCAN)) {
      const path = join(dir, n);
      const def = readAgent(path);
      const name = def?.name ?? n.slice(0, -3);
      if (def === null || seen.has(name)) continue;
      seen.add(name);
      out.push({ name, source, path, def });
    }
  }
  return out;
}

/** The agent directories for a repo root and environment. */
export function agentDirs(
  repoRoot: string | null,
  env: Readonly<Record<string, string | undefined>>,
): AgentDirs {
  const configDir =
    env.CLAUDE_CONFIG_DIR && isAbsolute(env.CLAUDE_CONFIG_DIR)
      ? env.CLAUDE_CONFIG_DIR
      : env.HOME
        ? join(env.HOME, ".claude")
        : null;
  return {
    project: repoRoot === null ? null : join(repoRoot, ".claude", "agents"),
    user: configDir === null ? null : join(configDir, "agents"),
  };
}

/** Tools an external agent can stand in for without write access. */
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "TodoWrite", "NotebookRead"]);
/** Tools that need a worktree (they write, or run commands). */
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
/** Web tools: delegable when web forwarding is on; the runner routes to a provider that can give them. */
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);
/** The desktop app's built-in browser: never forwarded. */
const BROWSER_SERVER = "Claude_Browser";

/** What decides eligibility besides the agent file. */
export interface EligibilityOptions {
  /** MCP servers that may be forwarded for this repo (`forwardableMcpFor(cache, root)`: empty without consent). */
  forwardableMcp?: readonly string[] | undefined;
  /** Web forwarding is on (`hosts.claude-code.forward_web`, `forwardWebFor(cache, root)`). */
  webSupported?: boolean;
}

/** The outcome of {@link eligibility}. */
export type Eligibility =
  | {
      eligible: true;
      autonomy: "read-only" | "worktree";
      mcpServers: string[];
      /** The agent declares WebSearch or WebFetch. */
      web: boolean;
      /** The agent declares WebFetch (opens given URLs: codex needs live search). */
      webFetch: boolean;
    }
  | { eligible: false; reason: string };

/** The MCP server of an `mcp__<server>__<tool>` (or `mcp__<server>`) entry; null otherwise. */
export function mcpServerOf(tool: string): string | null {
  const m = /^mcp__(.+?)(?:__.*)?$/.exec(tool);
  return m?.[1] ?? null;
}

/**
 * Whether Dispatch may run `def` on another provider, and with which autonomy: only read tools →
 * read-only; edit tools or Bash (or no `tools:` list, meaning every tool) → worktree. Web tools
 * need `webSupported` (web forwarding on); an MCP tool needs its server in `forwardableMcp` (the desktop browser,
 * `Claude_Browser`, never); any other tool keeps the agent on Claude. Instructions over
 * {@link MAX_AGENT_BODY} keep it on Claude too.
 */
export function eligibility(def: AgentDefinition, opts: EligibilityOptions = {}): Eligibility {
  if (Buffer.byteLength(def.body, "utf8") > MAX_AGENT_BODY) {
    return { eligible: false, reason: "instructions over 32 KB" };
  }
  if (def.tools === null)
    return { eligible: true, autonomy: "worktree", mcpServers: [], web: false, webFetch: false };
  const forwardable = new Set(opts.forwardableMcp ?? []);
  const servers = new Set<string>();
  let writes = false;
  let web = false;
  let webFetch = false;
  for (const entry of def.tools) {
    const tool = entry.replace(/\(.*$/, "").trim();
    const server = mcpServerOf(tool);
    if (server !== null) {
      if (server === BROWSER_SERVER) return { eligible: false, reason: "uses Claude_Browser" };
      if (!forwardable.has(server)) {
        return { eligible: false, reason: `uses MCP server ${server}, which is not forwardable` };
      }
      servers.add(server);
    } else if (WRITE_TOOLS.has(tool)) writes = true;
    else if (WEB_TOOLS.has(tool)) {
      if (opts.webSupported !== true) {
        return {
          eligible: false,
          reason: `uses ${tool}, and web forwarding is off (hosts.claude-code.forward_web)`,
        };
      }
      web = true;
      if (tool === "WebFetch") webFetch = true;
    } else if (!READ_TOOLS.has(tool)) {
      return {
        eligible: false,
        reason: `uses ${tool.slice(0, 60)}, which Dispatch cannot delegate`,
      };
    }
  }
  return {
    eligible: true,
    autonomy: writes ? "worktree" : "read-only",
    mcpServers: [...servers].sort(),
    web,
    webFetch,
  };
}
