import type {
  AdapterOutcome,
  AdapterRunContext,
  SpawnResult,
  Usage,
} from "../../core/contracts.js";
import { runState } from "./parse.js";

const SANDBOX_TEXT = /sandbox/i;

const int = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;

/**
 * Maps `result.usage` to {@link Usage}: `inputTokens` counts fresh input plus cache writes and
 * cache reads (everything billed as input), `cachedTokens` the cache reads alone.
 */
export function claudeUsage(result: Record<string, unknown>): Usage | undefined {
  const u = result.usage;
  if (typeof u !== "object" || u === null) return undefined;
  const raw = u as Record<string, unknown>;
  const cached = int(raw.cache_read_input_tokens);
  const usage: Usage = {
    inputTokens: int(raw.input_tokens) + int(raw.cache_creation_input_tokens) + cached,
    outputTokens: int(raw.output_tokens),
    cachedTokens: cached,
    raw: u,
  };
  const cost = result.total_cost_usd;
  if (typeof cost === "number" && Number.isFinite(cost) && cost >= 0) usage.costUsd = cost;
  return usage;
}

function exitText(result: SpawnResult): string {
  if (result.signal) return `killed by ${result.signal}`;
  return `exit code ${String(result.exitCode)}`;
}

/** Classifies a finished claude child from the state collected by `parseLine`. */
export function finalizeClaude(
  result: SpawnResult & { durationMs: number },
  ctx: AdapterRunContext,
): AdapterOutcome {
  const st = runState(ctx);
  const res = st.result;
  const resultText = typeof res?.result === "string" ? res.result : "";
  const summary = resultText || st.lastText;
  const base = {
    summary,
    deniedActions: [...st.denied.values()],
    durationMs: Math.max(0, result.durationMs),
  };
  const usage = res ? claudeUsage(res) : undefined;
  const withUsage = <T extends AdapterOutcome>(o: T): T => (usage ? { ...o, usage } : o);
  const stderr = st.stderrTail.join("\n");

  if (st.quotaSignal) {
    const out: AdapterOutcome = {
      ...base,
      outcome: "quota_exhausted",
      quotaSignal: st.quotaSignal,
      nativeError: st.quotaSignal.raw,
    };
    if (st.resetAt) out.resetAt = st.resetAt;
    return withUsage(out);
  }
  if (result.timedOut) {
    return withUsage({ ...base, outcome: "timeout", nativeError: "timed out" });
  }
  // failIfUnavailable: Claude refuses to start when the OS sandbox is missing (fail closed).
  if (!st.sawInit && result.exitCode !== 0 && SANDBOX_TEXT.test(`${stderr}\n${resultText}`)) {
    return {
      ...base,
      outcome: "rejected",
      nativeError: `claude refused to start because its OS sandbox is unavailable (sandbox.failIfUnavailable); on Linux install bubblewrap and socat. ${(stderr || resultText).trim()}`,
    };
  }
  const ok =
    res !== null &&
    res.subtype === "success" &&
    res.is_error !== true &&
    result.exitCode === 0 &&
    !result.signal;
  if (ok && !(summary.trim() === "" && base.deniedActions.length > 0)) {
    return withUsage({ ...base, outcome: "success" });
  }
  const reason = res
    ? `${String(res.subtype)}${resultText ? `: ${resultText}` : ""}`
    : `no result event (${exitText(result)})`;
  const extra = [st.lastRetry, stderr].filter(Boolean).join("\n");
  return withUsage({
    ...base,
    outcome: "failed",
    nativeError: extra ? `${reason}\n${extra}` : reason,
  });
}
