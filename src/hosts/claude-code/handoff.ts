/**
 * Handoff files and the passthrough list of Claude hard mode for custom agents (UC2).
 *
 * - The PreToolUse hook writes `<dispatchHome>/handoffs/<id>.json` (0600, atomic) with the agent's
 *   instructions and the caller's task, and points the Dispatch relay at `<id>`, so no task text is
 *   ever shell-quoted. `dispatch run --handoff <id>` loads and deletes it ({@link loadHandoff}).
 * - When such a run hands the task back (returned to host, rejected, failed), the runner records
 *   the call's {@link passthroughKey} in `<dispatchHome>/hook-passthrough.json`; the hook then lets
 *   the same call through to Claude once, so the caller's retry is not redirected again.
 *
 * Imports node built-ins only (bundled into the ≤ 80 ms hook entry).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/** Directory of handoff files inside the Dispatch home. */
export const HANDOFF_DIR = "handoffs";
/** Passthrough file inside the Dispatch home. */
export const PASSTHROUGH_FILE = "hook-passthrough.json";
/** A handoff older than this is refused (and removed by `gc`). */
export const HANDOFF_MAX_AGE_MS = 60 * 60 * 1000;
/** A passthrough entry expires after this. */
export const PASSTHROUGH_TTL_MS = 30 * 60 * 1000;
/** Most passthrough entries kept (the oldest go first). */
export const PASSTHROUGH_CAP = 100;

/** Contents of a handoff file (version 1). */
export interface Handoff {
  version: 1;
  createdAt: string;
  agent: { name: string; source: "project" | "user"; path: string };
  /** The agent file's body. */
  instructions: string;
  /** The caller's original prompt. */
  task: string;
  description: string | null;
  /** The agent's `model:` (classified into a tier by the router's reverse map); null: inherit. */
  model: string | null;
  /** Dispatch effort derived from the agent's `effort:`; null when unset. */
  effort: "low" | "medium" | "high" | null;
  autonomy: "read-only" | "worktree";
  /** MCP servers the agent's tools reference (all forwardable when the hook wrote the file). */
  mcpServers: string[];
  /** The agent declares WebSearch or WebFetch (web forwarding was on when the hook wrote the file). */
  web: boolean;
  /** The agent declares WebFetch. Absent (older handoffs): treated as true when `web` is. */
  webFetch?: boolean;
  /** The agent uses the Claude desktop browser tools: the run gets the isolated browser. */
  browser?: boolean;
  autoApply: boolean;
  /** {@link passthroughKey} of the original call. */
  passthroughKey: string;
}

const ID = /^[0-9a-f]{32}$/;

/** True for a well-formed handoff id. */
export function isHandoffId(id: string): boolean {
  return ID.test(id);
}

/** Hash of a sub-agent call (type + prompt) that identifies its retry. */
export function passthroughKey(subagentType: string, prompt: string): string {
  return createHash("sha256").update(`${subagentType}\u0000${prompt}`).digest("hex");
}

/** Maps an agent `effort:` (low … max) to a Dispatch effort; null when unknown. */
export function dispatchEffort(effort: string | null): Handoff["effort"] {
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  return effort === "xhigh" || effort === "max" ? "high" : null;
}

/** Writes `data` to `path` atomically (temp file + rename) with mode 0600. */
function atomicWrite(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, data, { mode: 0o600, flag: "wx" });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** Writes a new handoff and returns its id. */
export function writeHandoff(dispatchHome: string, handoff: Handoff): string {
  const id = randomBytes(16).toString("hex");
  atomicWrite(join(dispatchHome, HANDOFF_DIR, `${id}.json`), `${JSON.stringify(handoff)}\n`);
  return id;
}

const isStr = (v: unknown): v is string => typeof v === "string";

function isHandoff(v: unknown): v is Handoff {
  if (v === null || typeof v !== "object") return false;
  const h = v as Partial<Handoff>;
  const a = h.agent as Partial<Handoff["agent"]> | undefined;
  return (
    h.version === 1 &&
    isStr(h.createdAt) &&
    a !== undefined &&
    isStr(a.name) &&
    (a.source === "project" || a.source === "user") &&
    isStr(a.path) &&
    isStr(h.instructions) &&
    isStr(h.task) &&
    h.task.trim() !== "" &&
    (h.description === null || isStr(h.description)) &&
    (h.model === null || isStr(h.model)) &&
    (h.effort === null || dispatchEffort(h.effort ?? null) === h.effort) &&
    (h.autonomy === "read-only" || h.autonomy === "worktree") &&
    Array.isArray(h.mcpServers) &&
    h.mcpServers.every(isStr) &&
    typeof h.web === "boolean" &&
    (h.webFetch === undefined || typeof h.webFetch === "boolean") &&
    (h.browser === undefined || typeof h.browser === "boolean") &&
    typeof h.autoApply === "boolean" &&
    isStr(h.passthroughKey)
  );
}

/** Why a handoff could not be loaded. */
export class HandoffError extends Error {}

/**
 * Loads and deletes handoff `id`. Refuses a malformed id, a path that is a symlink or not a
 * regular file, a file outside `<dispatchHome>/handoffs`, one owned by another user or readable
 * by others, one older than {@link HANDOFF_MAX_AGE_MS}, and malformed contents.
 */
export function loadHandoff(dispatchHome: string, id: string, nowMs: number): Handoff {
  if (!isHandoffId(id)) throw new HandoffError(`not a handoff id: ${id.slice(0, 80)}`);
  const dir = join(dispatchHome, HANDOFF_DIR);
  const path = join(dir, `${id}.json`);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch {
    throw new HandoffError(`handoff ${id} not found (it is used once and expires after 1 h)`);
  }
  if (st.isSymbolicLink() || !st.isFile()) throw new HandoffError(`handoff ${id} is not a file`);
  // The id cannot carry a separator; a symlinked directory would still lead elsewhere.
  if (lstatSync(dir).isSymbolicLink()) {
    throw new HandoffError(`handoff ${id} is outside ${dir}`);
  }
  const uid = process.getuid?.();
  if ((uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
    throw new HandoffError(`handoff ${id} has the wrong owner or mode`);
  }
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(path, "utf8"));
  } finally {
    rmSync(path, { force: true });
  }
  if (!isHandoff(v)) throw new HandoffError(`handoff ${id} is malformed`);
  const age = nowMs - Math.min(Date.parse(v.createdAt), st.mtimeMs);
  if (!Number.isFinite(age) || age > HANDOFF_MAX_AGE_MS) {
    throw new HandoffError(`handoff ${id} is older than 1 h`);
  }
  return v;
}

/** Removes handoff files older than {@link HANDOFF_MAX_AGE_MS}; returns their ids. */
export function gcHandoffs(dispatchHome: string, nowMs: number, dryRun = false): string[] {
  const dir = join(dispatchHome, HANDOFF_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      const st = lstatSync(path);
      if (nowMs - st.mtimeMs <= HANDOFF_MAX_AGE_MS) continue;
      if (!dryRun) rmSync(path, { force: true });
      gone.push(n.replace(/\.json$/, ""));
    } catch {
      // vanished meanwhile
    }
  }
  return gone;
}

/** Passthrough entries: key → expiry (epoch ms). */
type Passthrough = Record<string, number>;

function readPassthrough(dispatchHome: string, nowMs: number): Passthrough {
  try {
    const v: unknown = JSON.parse(readFileSync(join(dispatchHome, PASSTHROUGH_FILE), "utf8"));
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    return Object.fromEntries(
      Object.entries(v).filter(
        (e): e is [string, number] => typeof e[1] === "number" && e[1] > nowMs,
      ),
    );
  } catch {
    return {};
  }
}

function writePassthrough(dispatchHome: string, entries: Passthrough): void {
  const kept = Object.entries(entries)
    .sort((a, b) => b[1] - a[1])
    .slice(0, PASSTHROUGH_CAP);
  atomicWrite(
    join(dispatchHome, PASSTHROUGH_FILE),
    `${JSON.stringify(Object.fromEntries(kept))}\n`,
  );
}

/** Records `key` so the next matching call goes to Claude unchanged (expires after 30 min). */
export function addPassthrough(dispatchHome: string, key: string, nowMs: number): void {
  const entries = readPassthrough(dispatchHome, nowMs);
  entries[key] = nowMs + PASSTHROUGH_TTL_MS;
  writePassthrough(dispatchHome, entries);
}

/** True (and the entry is removed) when `key` is in the passthrough list and not expired. */
export function consumePassthrough(dispatchHome: string, key: string, nowMs: number): boolean {
  const entries = readPassthrough(dispatchHome, nowMs);
  if (!(key in entries)) return false;
  delete entries[key];
  writePassthrough(dispatchHome, entries);
  return true;
}

/** Drops expired passthrough entries; returns how many were dropped. */
export function gcPassthrough(dispatchHome: string, nowMs: number, dryRun = false): number {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(join(dispatchHome, PASSTHROUGH_FILE), "utf8"));
  } catch {
    return 0;
  }
  const live = readPassthrough(dispatchHome, nowMs);
  const dropped = Object.keys(raw ?? {}).length - Object.keys(live).length;
  if (dropped > 0 && !dryRun) writePassthrough(dispatchHome, live);
  return Math.max(0, dropped);
}
