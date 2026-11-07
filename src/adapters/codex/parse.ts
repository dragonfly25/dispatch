import { isAbsolute, relative, sep } from "node:path";
import { systemClock } from "../../core/clock.js";
import type {
  AdapterOutcome,
  AdapterRunContext,
  Clock,
  NormalizedEvent,
  SpawnResult,
  Usage,
} from "../../core/contracts.js";

/**
 * Per-run state kept in `ctx.scratch.codex`. Other scratch keys this adapter reads (set by the runner):
 * - `outputFileContent` (string): content of `Invocation.outputFile` (`-o last.txt`), read by the
 *   runner after the child exits; preferred over the last `agent_message` as the summary.
 * - `clock` ({@link Clock}): timestamps for events and the base for `resetAt`; defaults to the system clock.
 */
interface CodexRunState {
  seenItems: string[];
  lastAgentMessage: string | null;
  turnFailed: string | null;
  errors: string[];
  stderrTail: string[];
  denied: string[];
  usage: { input: number; cached: number; cacheWrite: number; output: number; reasoning: number };
  turns: number;
}

/** Matches codex usage-limit / credit messages (protocol/src/error.rs; note U+2019). */
export const CODEX_QUOTA_PATTERN =
  /(you[’']ve hit your usage limit|out of credits|hit your spend cap)/i;

const DETAIL_MAX = 200;
const STDERR_TAIL = 20;

function state(ctx: AdapterRunContext): CodexRunState {
  const existing = ctx.scratch.codex as CodexRunState | undefined;
  if (existing) return existing;
  const fresh: CodexRunState = {
    seenItems: [],
    lastAgentMessage: null,
    turnFailed: null,
    errors: [],
    stderrTail: [],
    denied: [],
    usage: { input: 0, cached: 0, cacheWrite: 0, output: 0, reasoning: 0 },
    turns: 0,
  };
  ctx.scratch.codex = fresh;
  return fresh;
}

function clockOf(ctx: AdapterRunContext): Clock {
  const c = ctx.scratch.clock as Partial<Clock> | undefined;
  return c && typeof c.now === "function" ? (c as Clock) : systemClock;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const clip = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);

/** Worktree-relative path; paths outside the worktree are returned unchanged. */
export function relativize(worktree: string, path: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(worktree, path);
  if (rel === "") return ".";
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) return path;
  return rel.split(sep).join("/");
}

function itemEvents(
  phase: string,
  item: Record<string, unknown>,
  ctx: AdapterRunContext,
  st: CodexRunState,
  ts: string,
): NormalizedEvent[] {
  const id = str(item.id) ?? "";
  const status = str(item.status);
  const firstSighting = !st.seenItems.includes(id);
  if (id && firstSighting) st.seenItems.push(id);
  const completed = phase === "item.completed";
  const declined = status === "declined";

  switch (item.type) {
    case "command_execution": {
      const command = str(item.command) ?? "";
      if (declined && completed) {
        st.denied.push(`command: ${command}`);
        return [{ kind: "denied", ts, detail: clip(command) }];
      }
      return firstSighting ? [{ kind: "running", ts, detail: clip(command) }] : [];
    }
    case "file_change": {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isObj) : [];
      const paths = changes
        .map((c) => str(c.path))
        .filter((p): p is string => p !== undefined)
        .map((p) => relativize(ctx.worktree, p));
      if (declined && completed) {
        for (const p of paths) st.denied.push(`edit: ${p}`);
        return paths.map((path) => ({ kind: "denied", ts, path, detail: "file_change declined" }));
      }
      if (!firstSighting) return [];
      return paths.map((path, i) => ({
        kind: "editing" as const,
        ts,
        path,
        detail: str(changes[i]?.kind) ?? "update",
      }));
    }
    case "reasoning": {
      const text = str(item.text);
      return firstSighting
        ? [{ kind: "thinking", ts, ...(text ? { detail: clip(text) } : {}) }]
        : [];
    }
    case "agent_message": {
      const text = str(item.text);
      if (completed && text !== undefined) st.lastAgentMessage = text;
      return completed && text ? [{ kind: "thinking", ts, detail: clip(text) }] : [];
    }
    case "mcp_tool_call": {
      if (!firstSighting) return [];
      const name = [str(item.server), str(item.tool)].filter(Boolean).join(".");
      return [{ kind: "running", ts, detail: clip(`mcp ${name}`) }];
    }
    case "web_search": {
      if (!firstSighting) return [];
      return [{ kind: "running", ts, detail: clip(`web_search ${str(item.query) ?? ""}`.trim()) }];
    }
    case "error": {
      // Item-level errors are non-fatal warnings (e.g. fallback model metadata).
      const message = str(item.message) ?? "error";
      return completed ? [{ kind: "error", ts, detail: clip(message) }] : [];
    }
    default:
      // todo_list, collab_tool_call and future item types carry no progress worth reporting.
      return [];
  }
}

/**
 * Parses one line of `codex exec --json` output into normalized events. Never throws:
 * malformed or unknown input yields `[]`. stderr lines only feed the failure diagnostics.
 */
export function parseCodexLine(
  stream: "stdout" | "stderr",
  line: string,
  ctx: AdapterRunContext,
): NormalizedEvent[] {
  try {
    const st = state(ctx);
    if (stream === "stderr") {
      if (line.trim()) {
        st.stderrTail.push(line);
        if (st.stderrTail.length > STDERR_TAIL) st.stderrTail.shift();
      }
      return [];
    }
    if (!line.trimStart().startsWith("{")) return [];
    const msg: unknown = JSON.parse(line);
    if (!isObj(msg)) return [];
    const ts = clockOf(ctx).now().toISOString();
    switch (msg.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        return isObj(msg.item) ? itemEvents(msg.type, msg.item, ctx, st, ts) : [];
      case "turn.completed": {
        st.turns += 1;
        const u = isObj(msg.usage) ? msg.usage : {};
        st.usage.input += num(u.input_tokens);
        st.usage.cached += num(u.cached_input_tokens);
        st.usage.cacheWrite += num(u.cache_write_input_tokens);
        st.usage.output += num(u.output_tokens);
        st.usage.reasoning += num(u.reasoning_output_tokens);
        return [{ kind: "done", ts }];
      }
      case "turn.failed": {
        const err = isObj(msg.error) ? msg.error : {};
        const message = str(err.message) ?? "turn failed";
        st.turnFailed = message;
        return [{ kind: "error", ts, detail: clip(message) }];
      }
      case "error": {
        const message = str(msg.message) ?? "error";
        st.errors.push(message);
        return [{ kind: "error", ts, detail: clip(message) }];
      }
      default:
        return []; // thread.started, turn.started, unknown
    }
  } catch {
    return [];
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * Parses the reset time from a codex usage-limit message ("Try again at 3:05 PM." or
 * "Try again at Nov 8th, 2026 3:05 PM."). Codex prints it in the machine's local time zone,
 * with no date when the reset is today. Returns ISO UTC or undefined.
 */
export function parseResetAt(message: string, now: Date): string | undefined {
  const m =
    /try again at\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\s+)?(\d{1,2}):(\d{2})\s*([AP]M)/i.exec(
      message,
    );
  if (!m) return undefined;
  const [, mon, day, year, hh, mm, ampm] = m;
  let hour = Number(hh) % 12;
  if (ampm?.toUpperCase() === "PM") hour += 12;
  const minute = Number(mm);
  if (minute > 59 || Number(hh) > 12) return undefined;
  if (mon && day && year) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    if (month < 0) return undefined;
    return new Date(Number(year), month, Number(day), hour, minute).toISOString();
  }
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute);
  if (at.getTime() < now.getTime()) at.setDate(at.getDate() + 1);
  return at.toISOString();
}

function usageOf(st: CodexRunState): Usage | undefined {
  if (st.turns === 0) return undefined;
  const u = st.usage;
  return {
    // codex `input_tokens` already includes cached reads (OpenAI semantics).
    inputTokens: u.input,
    // `reasoning_output_tokens` is a subset of `output_tokens`.
    outputTokens: u.output,
    cachedTokens: u.cached + u.cacheWrite,
    raw: {
      input_tokens: u.input,
      cached_input_tokens: u.cached,
      cache_write_input_tokens: u.cacheWrite,
      output_tokens: u.output,
      reasoning_output_tokens: u.reasoning,
      turns: st.turns,
    },
  };
}

/**
 * Classifies a finished `codex exec` run. Order: timeout, quota (usage-limit message in
 * `turn.failed`, `error` or stderr), failed (turn.failed, non-zero exit, signal, or denied
 * actions with no output), success. Summary: `ctx.scratch.outputFileContent`, else the last
 * `agent_message`.
 */
export function finalizeCodex(
  result: SpawnResult & { durationMs: number },
  ctx: AdapterRunContext,
): AdapterOutcome {
  const st = state(ctx);
  const file = ctx.scratch.outputFileContent;
  const fromFile = typeof file === "string" && file.trim() ? file.trim() : null;
  const summary = fromFile ?? st.lastAgentMessage?.trim() ?? "";
  const usage = usageOf(st);
  const base = {
    summary,
    deniedActions: [...st.denied],
    durationMs: Math.max(0, result.durationMs),
    ...(usage ? { usage } : {}),
  };

  if (result.timedOut) return { ...base, outcome: "timeout" };

  const candidates = [st.turnFailed, ...st.errors, ...st.stderrTail].filter(
    (s): s is string => typeof s === "string",
  );
  const quota = candidates.find((s) => CODEX_QUOTA_PATTERN.test(s));
  if (quota) {
    const resetAt = parseResetAt(quota, clockOf(ctx).now());
    return {
      ...base,
      outcome: "quota_exhausted",
      nativeError: quota,
      quotaSignal: { source: "codex.turn_failed.usage_limit", raw: quota },
      ...(resetAt ? { resetAt } : {}),
    };
  }

  const nativeError =
    st.turnFailed ??
    st.errors.at(-1) ??
    (result.signal ? `killed by ${result.signal}` : undefined) ??
    (result.exitCode !== 0 ? (st.stderrTail.at(-1) ?? `exit code ${result.exitCode}`) : undefined);
  if (st.turnFailed || result.exitCode !== 0 || result.signal) {
    return {
      ...base,
      outcome: "failed",
      summary: summary || (nativeError ?? ""),
      ...(nativeError ? { nativeError } : {}),
    };
  }
  if (st.denied.length > 0 && !summary) {
    return { ...base, outcome: "failed", nativeError: "all useful actions were denied" };
  }
  return { ...base, outcome: "success" };
}
