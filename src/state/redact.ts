/**
 * Secret redaction. Pure functions: no I/O, no clock, no environment access.
 *
 * Every string that reaches the state database, a log or stdout passes through here first.
 * Matches are replaced by `[REDACTED:<kind>]`. Redaction is deliberately greedy: a false positive
 * costs a few characters of a log line, a false negative leaks a credential.
 */

/** A named pattern; `replace` may reference capture groups to keep non-secret context. */
interface Rule {
  kind: string;
  re: RegExp;
  /** Replacement template; defaults to the bare marker. */
  keep?: string;
}

const mark = (kind: string): string => `[REDACTED:${kind}]`;

/**
 * Ordered rules. More specific patterns come first so that, e.g., `sk-ant-…` is reported as
 * `anthropic-key` rather than `openai-key`, and a PEM block is removed before anything inside it
 * is looked at.
 */
const RULES: readonly Rule[] = [
  {
    // Complete block, or an unterminated one (truncated log): redact to the end of the text.
    kind: "private-key",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
  },
  {
    kind: "authorization",
    re: /(\bauthorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s"',;]+/gi,
    keep: "$1",
  },
  { kind: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { kind: "openai-key", re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{16,}/g },
  { kind: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { kind: "google-key", re: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { kind: "slack-token", re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: "aws-key-id", re: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/g },
  {
    kind: "aws-secret",
    re: /(\baws_secret_access_key["']?\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}/gi,
    keep: "$1",
  },
  { kind: "jwt", re: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g },
  { kind: "bearer", re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, keep: "$1" },
];

/**
 * The detection patterns behind {@link redact}, as `{kind, re}` pairs in priority order. Shared
 * with the patch secret scan so both agree on what a credential looks like. The regexes carry the
 * `g` flag: clone them before using `test`/`exec` to avoid shared `lastIndex` state.
 */
export const SECRET_PATTERNS: readonly { readonly kind: string; readonly re: RegExp }[] = RULES.map(
  ({ kind, re }) => ({ kind, re }),
);

/** Explicit secret values shorter than this are ignored: they would mangle ordinary text. */
export const MIN_SECRET_LENGTH = 4;

/** Longest first, so a secret containing another one is replaced whole. */
function usableSecrets(extraSecrets: readonly string[] | undefined): string[] {
  if (!extraSecrets) return [];
  const unique = new Set(extraSecrets.filter((s) => s.length >= MIN_SECRET_LENGTH));
  return [...unique].sort((a, b) => b.length - a.length);
}

/**
 * Masks secrets in `text`.
 * @param extraSecrets literal values to remove wherever they occur (e.g. the values of environment
 *   variables that are not on the pass-through allow-list). Values under {@link MIN_SECRET_LENGTH}
 *   characters are ignored.
 */
export function redact(text: string, extraSecrets?: readonly string[]): string {
  return scrub(text, usableSecrets(extraSecrets));
}

function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join(mark("secret"));
  for (const rule of RULES) {
    out = out.replace(rule.re, rule.keep ? `${rule.keep}${mark(rule.kind)}` : mark(rule.kind));
  }
  return out;
}

/**
 * Returns a deep copy of `value` with {@link redact} applied to every string, including object
 * keys. Arrays and plain objects are walked; `Date`s become ISO strings; other primitives pass
 * through. Cycles are replaced by `"[Circular]"`. Never mutates its input.
 */
export function redactDeep<T>(value: T, extraSecrets?: readonly string[]): T {
  const secrets = usableSecrets(extraSecrets);
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrub(v, secrets);
    if (v === null || typeof v !== "object") return v;
    if (v instanceof Date) return v.toISOString();
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    let out: unknown;
    if (Array.isArray(v)) {
      out = v.map(walk);
    } else {
      const obj: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v)) obj[scrub(k, secrets)] = walk(val);
      out = obj;
    }
    seen.delete(v);
    return out;
  };
  return walk(value) as T;
}
