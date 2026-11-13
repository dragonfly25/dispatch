import { isAbsolute, relative, sep } from "node:path";
import type {
  AdapterRunContext,
  NormalizedEvent,
  QuotaObservation,
  QuotaSignal,
} from "../../core/contracts.js";

/** Reader id stamped on passive quota windows (`QuotaWindow.source`). */
export const CLAUDE_QUOTA_SOURCE = "claude-passive";

/** Mutable per-run parse state, kept in `ctx.scratch.claude`. */
export interface ClaudeRunState {
  sawInit: boolean;
  /** Model reported by `system/init`; also mirrored to `ctx.scratch.model`. */
  model: string | null;
  lastText: string;
  /** The final `result` event, if one arrived. */
  result: Record<string, unknown> | null;
  /** Denied actions keyed by tool_use_id (or a running counter when there is none). */
  denied: Map<string, string>;
  quotaSignal: QuotaSignal | null;
  /** Reset time announced by a `rejected` rate_limit_event (ISO). */
  resetAt: string | null;
  /** Last `system/api_retry` description, for `nativeError`. */
  lastRetry: string | null;
  /** Tail of stderr and non-JSON stdout lines. */
  stderrTail: string[];
  /** tool_use_id → short action label, used to describe denials. */
  tools: Map<string, string>;
}

const STDERR_TAIL = 20;
const DETAIL_MAX = 200;
/** "You've hit your session limit · resets 3:45pm" and its weekly/Opus/Sonnet variants. */
export const QUOTA_TEXT = /\bhit your (?:[\w-]+ ){0,3}limit\b/i;
const DENIAL_TEXT =
  /denied by your permission settings|haven't granted it yet|<sandbox_violations>|permission to use .* has been denied/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const clip = (s: string): string => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);

/** Returns (creating on first use) the run state stored in `ctx.scratch.claude`. */
export function runState(ctx: AdapterRunContext): ClaudeRunState {
  const existing = ctx.scratch.claude as ClaudeRunState | undefined;
  if (existing) return existing;
  const state: ClaudeRunState = {
    sawInit: false,
    model: null,
    lastText: "",
    result: null,
    denied: new Map(),
    quotaSignal: null,
    resetAt: null,
    lastRetry: null,
    stderrTail: [],
    tools: new Map(),
  };
  ctx.scratch.claude = state;
  return state;
}

/** Epoch seconds → ISO UTC, or null when not a plausible timestamp. */
export function epochToIso(v: unknown): string | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const d = new Date(v * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Claude window keys (`five_hour`, `seven_day`, `seven_day_opus`) → Dispatch kinds (`5h`, `7d`). */
export function windowKind(key: string): string {
  const m = /^(five_hour|seven_day)(?:_(.+))?$/.exec(key);
  if (!m) return key;
  const base = m[1] === "five_hour" ? "5h" : "7d";
  return m[2] ? `${base}-${m[2]}` : base;
}

function nowIso(): string {
  return new Date().toISOString();
}

function eventTs(o: Obj): string {
  const t = str(o.timestamp);
  return t && !Number.isNaN(Date.parse(t)) ? new Date(t).toISOString() : nowIso();
}

/**
 * Worktree-relative path when `p` is inside the worktree (`/`-separated on every OS, like the
 * codex adapter), otherwise `p` unchanged.
 */
export function relPath(worktree: string, p: string): string {
  if (!isAbsolute(p)) return p;
  const r = relative(worktree, p);
  return r === "" ? "." : r.startsWith("..") || isAbsolute(r) ? p : r.split(sep).join("/");
}

function setSignal(st: ClaudeRunState, source: QuotaSignal["source"], raw: string): void {
  if (!st.quotaSignal) st.quotaSignal = { source, raw: clip(raw) };
}

function pushStderr(st: ClaudeRunState, line: string): void {
  st.stderrTail.push(line);
  if (st.stderrTail.length > STDERR_TAIL) st.stderrTail.shift();
}

function observations(ctx: AdapterRunContext): QuotaObservation[] {
  const list = ctx.scratch.quotaObservations;
  if (Array.isArray(list)) return list as QuotaObservation[];
  const fresh: QuotaObservation[] = [];
  ctx.scratch.quotaObservations = fresh;
  return fresh;
}

/**
 * Turns a `rate_limit_event` into passive quota readings. `unifiedWindows` (seen live, not in the
 * SDK types) wins; otherwise the single `rateLimitType` window is used. Observations are only
 * recorded when the runner put the instance id in `ctx.scratch.instanceId`.
 */
function onRateLimit(o: Obj, st: ClaudeRunState, ctx: AdapterRunContext): void {
  const info = o.rate_limit_info;
  if (!isObj(info)) return;
  const status = str(info.status);
  if (status === "rejected" && info.overageStatus !== "allowed") {
    setSignal(st, "claude.rate_limit_event.rejected", JSON.stringify(info));
    st.resetAt ??= epochToIso(info.resetsAt);
  }
  const instanceId = str(ctx.scratch.instanceId);
  if (!instanceId) return;
  const at = nowIso();
  const windows: [string, unknown, unknown][] = isObj(info.unifiedWindows)
    ? Object.entries(info.unifiedWindows).flatMap(([k, w]) =>
        isObj(w) ? [[k, w.utilization, w.resetsAt] as [string, unknown, unknown]] : [],
      )
    : typeof info.rateLimitType === "string"
      ? [[info.rateLimitType, info.utilization, info.resetsAt]]
      : [];
  for (const [key, utilization, resetsAt] of windows) {
    const usedPct =
      typeof utilization === "number" && Number.isFinite(utilization)
        ? Math.min(100, Math.max(0, Math.round(utilization * 10_000) / 100))
        : status === "rejected" && key === info.rateLimitType
          ? 100
          : null;
    observations(ctx).push({
      instanceId,
      at,
      window: {
        kind: windowKind(key),
        usedPct,
        resetAt: epochToIso(resetsAt),
        source: CLAUDE_QUOTA_SOURCE,
        readAt: at,
        reliability: "real",
      },
    });
  }
}

function toolEvent(block: Obj, ts: string, st: ClaudeRunState, wt: string): NormalizedEvent {
  const name = str(block.name) ?? "tool";
  const input = isObj(block.input) ? block.input : {};
  const target = str(input.file_path) ?? str(input.path) ?? str(input.notebook_path);
  const id = str(block.id);
  const command = str(input.command);
  const pattern = str(input.pattern);
  st.tools.set(id ?? "", `${name}: ${clip(command ?? target ?? pattern ?? "")}`);
  if (name === "Read" || name === "Grep" || name === "Glob") {
    const ev: NormalizedEvent = { kind: "reading", ts, detail: clip(pattern ?? name) };
    if (target) ev.path = relPath(wt, target);
    return ev;
  }
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    const ev: NormalizedEvent = { kind: "editing", ts, detail: name };
    if (target) ev.path = relPath(wt, target);
    return ev;
  }
  return { kind: "running", ts, detail: clip(command ?? name) };
}

function onAssistant(o: Obj, st: ClaudeRunState, ctx: AdapterRunContext): NormalizedEvent[] {
  const ts = eventTs(o);
  const msg = isObj(o.message) ? o.message : {};
  const out: NormalizedEvent[] = [];
  const synthetic = msg.model === "<synthetic>" || o.error !== undefined;
  if (o.error === "rate_limit") setSignal(st, "claude.assistant.error", "rate_limit");
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!isObj(block)) continue;
    if (block.type === "tool_use") out.push(toolEvent(block, ts, st, ctx.worktree));
    else if (block.type === "text" && typeof block.text === "string") {
      st.lastText = block.text;
      if (synthetic && QUOTA_TEXT.test(block.text)) setSignal(st, "claude.text", block.text);
      out.push({ kind: "thinking", ts, detail: clip(block.text) });
    } else if (block.type === "thinking") {
      out.push({ kind: "thinking", ts, detail: clip(str(block.thinking) ?? "") });
    }
  }
  if (typeof o.error === "string" && o.error !== "rate_limit") {
    out.push({ kind: "error", ts, detail: clip(o.error) });
  }
  return out;
}

function deny(st: ClaudeRunState, key: string | undefined, label: string): boolean {
  const k = key ?? `#${st.denied.size}`;
  if (st.denied.has(k)) return false;
  st.denied.set(k, label);
  return true;
}

function onUser(o: Obj, st: ClaudeRunState): NormalizedEvent[] {
  const msg = isObj(o.message) ? o.message : {};
  const out: NormalizedEvent[] = [];
  for (const block of Array.isArray(msg.content) ? msg.content : []) {
    if (!isObj(block) || block.type !== "tool_result" || block.is_error !== true) continue;
    const text = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
    if (!DENIAL_TEXT.test(text)) continue;
    const id = str(block.tool_use_id);
    const label = st.tools.get(id ?? "") ?? "tool";
    if (deny(st, id, label)) out.push({ kind: "denied", ts: eventTs(o), detail: clip(text) });
  }
  return out;
}

function onSystem(o: Obj, st: ClaudeRunState, ctx: AdapterRunContext): NormalizedEvent[] {
  const ts = eventTs(o);
  switch (o.subtype) {
    case "init": {
      st.sawInit = true;
      const model = str(o.model);
      if (model) {
        st.model = model;
        ctx.scratch.model = model;
      }
      return [];
    }
    case "permission_denied": {
      const id = str(o.tool_use_id);
      const label = st.tools.get(id ?? "") ?? str(o.tool_name) ?? "tool";
      const detail = clip(str(o.message) ?? str(o.decision_reason) ?? label);
      return deny(st, id, label) ? [{ kind: "denied", ts, detail }] : [];
    }
    case "api_retry": {
      const status = o.error_status ?? "?";
      st.lastRetry = `api retry ${String(o.attempt ?? "?")}/${String(o.max_retries ?? "?")} (status ${String(status)}${o.error ? `: ${String(o.error)}` : ""})`;
      return [{ kind: "thinking", ts, detail: clip(st.lastRetry) }];
    }
    default:
      return [];
  }
}

function onResult(o: Obj, st: ClaudeRunState): NormalizedEvent[] {
  st.result = o;
  const text = str(o.result) ?? "";
  if (o.api_error_status === 429) setSignal(st, "claude.api_error_status_429", "429");
  if (o.is_error === true && QUOTA_TEXT.test(text)) setSignal(st, "claude.text", text);
  for (const d of Array.isArray(o.permission_denials) ? o.permission_denials : []) {
    if (!isObj(d)) continue;
    const input = isObj(d.tool_input) ? d.tool_input : {};
    const what = str(input.file_path) ?? str(input.command) ?? str(input.path) ?? "";
    deny(st, str(d.tool_use_id), `${str(d.tool_name) ?? "tool"}: ${clip(what)}`);
  }
  const failed = o.is_error === true || o.subtype !== "success";
  return [
    {
      kind: failed ? "error" : "done",
      ts: eventTs(o),
      detail: clip(failed ? `${String(o.subtype)}: ${text}` : String(o.subtype)),
    },
  ];
}

/** Parses one output line of `claude -p --output-format stream-json`. Never throws. */
export function parseClaudeLine(
  stream: "stdout" | "stderr",
  line: string,
  ctx: AdapterRunContext,
): NormalizedEvent[] {
  try {
    const st = runState(ctx);
    const trimmed = line.trim();
    if (!trimmed) return [];
    let o: unknown;
    try {
      o = stream === "stdout" && trimmed.startsWith("{") ? JSON.parse(trimmed) : undefined;
    } catch {
      o = undefined;
    }
    if (!isObj(o)) {
      pushStderr(st, clip(trimmed));
      if (QUOTA_TEXT.test(trimmed)) setSignal(st, "claude.text", trimmed);
      return [];
    }
    switch (o.type) {
      case "system":
        return onSystem(o, st, ctx);
      case "assistant":
        return onAssistant(o, st, ctx);
      case "user":
        return onUser(o, st);
      case "rate_limit_event":
        onRateLimit(o, st, ctx);
        return [];
      case "result":
        return onResult(o, st);
      default:
        return [];
    }
  } catch (err) {
    return [{ kind: "error", ts: nowIso(), detail: clip(`parse error: ${String(err)}`) }];
  }
}
