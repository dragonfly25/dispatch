import type {
  AdapterOutcome,
  AdapterRunContext,
  QuotaSignal,
  SpawnResult,
  Usage,
} from "../../core/contracts.js";
import { type AgyState, agyState } from "./parse.js";

const QUOTA = /RESOURCE_EXHAUSTED|exhausted your quota|\b429\b/i;
const PRINT_TIMEOUT = /print[- ]?timeout|timed out/i;
const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1_000 } as const;

/**
 * Parses a relative reset such as "Resets in 2h39m" / "resets in 1 hour 5 minutes" into
 * milliseconds; null when the text carries none.
 */
export function parseResetDelayMs(text: string): number | null {
  const m = /resets?\s+in\s+((?:\d+\s*[dhms]\w*[\s,]*(?:and\s+)?)+)/i.exec(text);
  if (!m?.[1]) return null;
  let total = 0;
  for (const part of m[1].matchAll(/(\d+)\s*([dhms])/gi)) {
    total += Number(part[1]) * UNIT_MS[(part[2] ?? "s").toLowerCase() as keyof typeof UNIT_MS];
  }
  return total > 0 ? total : null;
}

function toUsage(raw: Record<string, unknown> | undefined): Usage | undefined {
  if (!raw) return undefined;
  const n = (k: string): number | undefined => {
    const v = raw[k];
    return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : undefined;
  };
  const input = n("input_tokens");
  const output = n("output_tokens");
  const cached = n("cache_read_tokens");
  return {
    ...(input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    raw,
  };
}

function quotaEvidence(st: AgyState): string | undefined {
  const texts = [...st.errors, ...(st.result?.error ? [st.result.error] : [])];
  return texts.find((t) => QUOTA.test(t));
}

function resetAtFrom(text: string, endedAt: unknown): string | undefined {
  const delay = parseResetDelayMs(text);
  const base = typeof endedAt === "string" ? Date.parse(endedAt) : Number.NaN;
  if (delay === null || Number.isNaN(base)) return undefined;
  return new Date(base + delay).toISOString();
}

/**
 * Classifies an ended `agy` run. Pure: relative quota resets are resolved against
 * `ctx.scratch.endedAt` (ISO), which the runner sets before calling this.
 *
 * Order: quota (AGY_ERROR / RESOURCE_EXHAUSTED / 429) -> timeout (runner kill or `--print-timeout`)
 * -> `ERROR`/`CANCELED` or a missing result -> `SUCCESS` with `denied_actions` (failed: read-only
 * enforcement was visible) -> success.
 */
export function finalizeAgy(
  result: SpawnResult & { durationMs: number },
  ctx: AdapterRunContext,
): AdapterOutcome {
  const st = agyState(ctx);
  const res = st.result;
  const denied = res?.deniedActions.map((d) => d.action) ?? [...st.denied];
  const usage = toUsage(res?.usage);
  const base = {
    summary: res?.response ?? "",
    deniedActions: denied,
    durationMs: result.durationMs,
    ...(usage ? { usage } : {}),
  };
  const errorText = [...st.errors, ...(res?.error ? [res.error] : [])].join("; ");

  const quotaText = quotaEvidence(st);
  if (quotaText !== undefined) {
    const resetAt = resetAtFrom([...st.errors, res?.error ?? ""].join(" "), ctx.scratch.endedAt);
    const quotaSignal: QuotaSignal = { source: "agy.agy_error.quota", raw: quotaText };
    return {
      ...base,
      outcome: "quota_exhausted",
      nativeError: quotaText,
      quotaSignal,
      ...(resetAt ? { resetAt } : {}),
    };
  }

  if (result.timedOut || [...st.errors, ...st.stderrTail].some((t) => PRINT_TIMEOUT.test(t))) {
    return {
      ...base,
      outcome: "timeout",
      nativeError:
        errorText || (result.timedOut ? "killed by the runner timeout" : "print timeout"),
    };
  }

  if (!res) {
    const tail = st.stderrTail.at(-1);
    return {
      ...base,
      outcome: "failed",
      nativeError:
        errorText ||
        tail ||
        (result.signal
          ? `killed by ${result.signal}`
          : `no result event (exit ${result.exitCode})`),
    };
  }
  if (res.status !== "SUCCESS") {
    return {
      ...base,
      outcome: "failed",
      nativeError: errorText || `agy status ${res.status || "unknown"}`,
    };
  }
  if (denied.length > 0) {
    return { ...base, outcome: "failed", nativeError: `denied: ${denied.join(", ")}` };
  }
  if (result.exitCode !== 0) {
    return {
      ...base,
      outcome: "failed",
      nativeError: errorText || `agy exited with code ${result.exitCode}`,
    };
  }
  return { ...base, outcome: "success" };
}
