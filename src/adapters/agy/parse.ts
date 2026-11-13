import { isAbsolute, relative, sep } from "node:path";
import type { AdapterRunContext, NormalizedEvent } from "../../core/contracts.js";

/** A denied tool action as reported in `result.denied_actions`. */
export interface AgyDeniedAction {
  action: string;
  displayName?: string;
}

/** The `result` event of a stream-json run (only the fields the adapter reads). */
export interface AgyResult {
  status: string;
  response: string;
  durationSeconds?: number;
  usage?: Record<string, unknown>;
  deniedActions: AgyDeniedAction[];
  /** Free-form error text, if the result carries one. */
  error?: string;
}

/**
 * Per-run parse state, kept in `ctx.scratch.agy`. Runner conventions for agy:
 * - `ctx.scratch.now`: optional `() => Date` used to stamp events (falls back to the system clock).
 * - `ctx.scratch.endedAt`: ISO time at which the child ended, set by the runner BEFORE `finalize`
 *   so that relative resets ("Resets in 2h39m") resolve without finalize reading a clock.
 */
export interface AgyState {
  model?: string;
  result?: AgyResult;
  /** `short_error` texts of `AGY_ERROR:` stderr lines, in order. */
  errors: string[];
  /** Last non-AGY_ERROR stderr lines (bounded), used for `nativeError` and timeout detection. */
  stderrTail: string[];
  /** Tool names denied by the permission layer, in order of appearance. */
  denied: string[];
  /** Step indexes for which a tool event was already emitted. */
  seenSteps: Set<number>;
}

const STDERR_TAIL = 20;
const DENIED_MESSAGE = /permission check failed|user denied permission|denied permission/i;
const PATH_KEYS = [
  "Path",
  "AbsolutePath",
  "TargetFile",
  "File",
  "SearchPath",
  "DirectoryPath",
  "path",
  "file_path",
];

/** Returns (creating on first use) the agy parse state of a run. */
export function agyState(ctx: AdapterRunContext): AgyState {
  const existing = ctx.scratch.agy as AgyState | undefined;
  if (existing) return existing;
  const fresh: AgyState = { errors: [], stderrTail: [], denied: [], seenSteps: new Set() };
  ctx.scratch.agy = fresh;
  return fresh;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const clip = (s: string, n = 200): string => (s.length > n ? `${s.slice(0, n)}...` : s);

function stamp(ctx: AdapterRunContext): string {
  const now = ctx.scratch.now;
  if (typeof now === "function") {
    const d = (now as () => unknown)();
    if (d instanceof Date && !Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/**
 * Worktree-relative form of `p` (`/`-separated on every OS, like the codex adapter), or undefined
 * when it lies outside the worktree.
 */
function inWorktree(p: string, worktree: string): string | undefined {
  const rel = isAbsolute(p) ? relative(worktree, p) : p;
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

function toolKind(name: string): NormalizedEvent["kind"] {
  if (/write|replace|edit|delete|sed_file/.test(name)) return "editing";
  if (/^(view|list|grep|find|read|search|get|capture)_/.test(name)) return "reading";
  return "running";
}

function toolParamPath(params: unknown): string | undefined {
  if (!isObj(params)) return undefined;
  for (const k of PATH_KEYS) {
    const v = str(params[k]);
    if (v) return v;
  }
  return undefined;
}

function parseStep(step: Obj, ctx: AdapterRunContext, st: AgyState): NormalizedEvent[] {
  const ts = stamp(ctx);
  const type = str(step.step_type);
  if (type === "agent_response") return [{ kind: "thinking", ts }];
  if (type !== "tool") return [];
  const info = isObj(step.tool_info) ? step.tool_info : {};
  const name = str(step.tool_name) ?? str(info.name) ?? "tool";
  const state = str(step.state);
  const index = typeof step.step_index === "number" ? step.step_index : undefined;

  if (state === "ERROR") {
    const message = isObj(info.error) ? (str(info.error.message) ?? "") : "";
    if (DENIED_MESSAGE.test(message)) {
      if (!st.denied.includes(name)) st.denied.push(name);
      return [{ kind: "denied", ts, detail: `denied: ${name}` }];
    }
    return [{ kind: "error", ts, detail: clip(`${name} failed: ${message}`) }];
  }
  if (state !== "ACTIVE" && state !== "DONE") return [];
  if (index !== undefined) {
    if (st.seenSteps.has(index)) return [];
    st.seenSteps.add(index);
  }
  const kind = toolKind(name);
  const raw = toolParamPath(info.parameters);
  const path = raw === undefined ? undefined : inWorktree(raw, ctx.worktree);
  const detail = raw !== undefined && path === undefined ? `${name} ${clip(raw)}` : name;
  return [{ kind, ts, detail, ...(path !== undefined ? { path } : {}) }];
}

function parseResult(res: Obj, ctx: AdapterRunContext, st: AgyState): NormalizedEvent[] {
  const ts = stamp(ctx);
  const denied: AgyDeniedAction[] = [];
  if (Array.isArray(res.denied_actions)) {
    for (const d of res.denied_actions) {
      const action = isObj(d) ? str(d.action) : undefined;
      if (action) {
        const displayName = isObj(d) ? str(d.display_name) : undefined;
        denied.push({ action, ...(displayName ? { displayName } : {}) });
      }
    }
  }
  const error = str(res.error) ?? (isObj(res.error) ? str(res.error.message) : undefined);
  st.result = {
    status: str(res.status) ?? "",
    response: str(res.response) ?? "",
    deniedActions: denied,
    ...(typeof res.duration_seconds === "number" ? { durationSeconds: res.duration_seconds } : {}),
    ...(isObj(res.usage) ? { usage: res.usage } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  const events: NormalizedEvent[] = denied
    .filter((d) => !st.denied.includes(d.action))
    .map((d) => ({ kind: "denied" as const, ts, detail: `denied: ${d.action}` }));
  if (st.result.status === "SUCCESS") events.push({ kind: "done", ts });
  else {
    events.push({ kind: "error", ts, detail: clip(error ?? `status ${st.result.status || "?"}`) });
  }
  return events;
}

function parseStdout(line: string, ctx: AdapterRunContext, st: AgyState): NormalizedEvent[] {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isObj(obj)) return [];
  switch (obj.event) {
    case "init": {
      const init = isObj(obj.init) ? obj.init : {};
      st.model = str(init.model) ?? st.model;
      return [
        { kind: "thinking", ts: stamp(ctx), detail: st.model ? `model ${st.model}` : "init" },
      ];
    }
    case "step_update":
      return isObj(obj.step_update) ? parseStep(obj.step_update, ctx, st) : [];
    case "result":
      return isObj(obj.result) ? parseResult(obj.result, ctx, st) : [];
    default:
      return [];
  }
}

function parseStderr(line: string, ctx: AdapterRunContext, st: AgyState): NormalizedEvent[] {
  const m = /^\s*AGY_ERROR:\s*(.*)$/.exec(line);
  if (!m) {
    if (line.trim()) {
      st.stderrTail.push(line.trim());
      if (st.stderrTail.length > STDERR_TAIL) st.stderrTail.shift();
    }
    return [];
  }
  let text = m[1] ?? "";
  try {
    const j: unknown = JSON.parse(text);
    if (isObj(j)) text = str(j.short_error) ?? str(j.error) ?? str(j.message) ?? text;
  } catch {
    // Keep the raw text: an unparsable AGY_ERROR line is still evidence.
  }
  st.errors.push(text);
  return [{ kind: "error", ts: stamp(ctx), detail: clip(text) }];
}

/** Parses one output line of an `agy` run; never throws. */
export function parseAgyLine(
  stream: "stdout" | "stderr",
  line: string,
  ctx: AdapterRunContext,
): NormalizedEvent[] {
  try {
    const st = agyState(ctx);
    return stream === "stdout" ? parseStdout(line, ctx, st) : parseStderr(line, ctx, st);
  } catch {
    return [];
  }
}
