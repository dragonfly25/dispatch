/**
 * Pure helpers of the `claude -p /usage` reader: trimming the output to its quota header (privacy),
 * the deterministic parser of `Current <label>: <n>% used · resets <when> (<IANA zone>)` lines,
 * reset-time resolution with `Intl` (no dependencies) and the grounding check of LLM readings.
 */

/** Marker of the local-usage breakdown that follows the quota lines; it is never kept. */
const BREAKDOWN = /what'?s contributing|approximate,|last \d+\s*h\b|top subagents|requests\s*·/i;
/** Upper bound of the kept header, against a changed layout without any marker. */
const MAX_HEADER_LINES = 12;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape sequences
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const CURRENT = /^\s*current\b/i;

/**
 * The quota header of `/usage` output: the lines before the first `Current …` line plus the
 * `Current …` block. Everything from the first other line after that block (the local-usage
 * breakdown) is dropped, and so is anything after a breakdown marker or past a small line cap.
 * Only this text may ever be stored, logged or sent to a model.
 */
export function trimUsageHeader(text: string): string {
  const kept: string[] = [];
  let inCurrent = false;
  for (const raw of text.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (BREAKDOWN.test(line)) break;
    if (CURRENT.test(line)) inCurrent = true;
    else if (line.trim() === "") {
      if (inCurrent && kept.at(-1)?.trim() === "") break;
    } else if (inCurrent) break;
    kept.push(line);
    if (kept.length >= MAX_HEADER_LINES) break;
  }
  return kept.join("\n").trim();
}

/** Window kind for a `/usage` label: `session` -> 5h, `week (all models)` -> 7d, `week (X)` -> 7d:x. */
export function kindOfLabel(label: string): string | null {
  const l = label.trim().replace(/\s+/g, " ").toLowerCase();
  if (/^(current )?session$/.test(l) || l === "5-hour" || l === "5h") return "5h";
  const week = /^(?:current )?week(?: \((.+)\))?$/.exec(l);
  if (!week) return null;
  const scope = week[1]?.trim();
  if (!scope || /^all( models)?$/.test(scope)) return "7d";
  const slug = scope.replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "");
  return slug ? `7d:${slug}` : null;
}

/** One parsed `Current …` line. */
export interface UsageLine {
  label: string;
  kind: string;
  usedPct: number;
  resetText: string | null;
  timeZone: string | null;
}

const LINE =
  /^\s*current\s+(.+?)\s*:\s*(\d{1,3}(?:\.\d+)?)\s*%\s*used\b\s*(?:[·•|\-–—,]\s*)?(?:resets?\s+(.+?))?\s*$/i;
const ZONE = /^(.*?)\s*\(([A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*)\)\s*$/;

/** Result of {@link parseUsageHeader}. `ok` is false when a fallback could do better. */
export interface ParsedUsage {
  lines: UsageLine[];
  ok: boolean;
  /** Why `ok` is false. */
  problem?: string;
}

/** Splits `<when> (<zone>)` into its parts. */
export function splitZone(when: string): { text: string; zone: string | null } {
  const m = ZONE.exec(when.trim());
  return m
    ? { text: (m[1] as string).trim(), zone: m[2] as string }
    : { text: when.trim(), zone: null };
}

/** Deterministic parser of the trimmed header. Unknown labels are skipped, not errors. */
export function parseUsageHeader(header: string): ParsedUsage {
  const lines: UsageLine[] = [];
  const current = header.split("\n").filter((l) => CURRENT.test(l));
  if (current.length === 0) return { lines, ok: false, problem: "no `Current …` line" };
  for (const raw of current) {
    const m = LINE.exec(raw);
    const used = m ? Number(m[2]) : Number.NaN;
    if (!m || !(used >= 0 && used <= 100)) {
      return { lines, ok: false, problem: `unparseable line "${raw.trim()}"` };
    }
    const kind = kindOfLabel(m[1] as string);
    if (!kind) continue;
    const when = m[3] ? splitZone(m[3]) : null;
    lines.push({
      label: (m[1] as string).trim(),
      kind,
      usedPct: used,
      resetText: when?.text || null,
      timeZone: when?.zone ?? null,
    });
  }
  if (lines.length === 0) return { lines, ok: false, problem: "no known window label" };
  return { lines, ok: true };
}

// ---------------------------------------------------------------------------
// Reset times
// ---------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const WHEN =
  /^(?:(?:on\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?\s*,?\s*(?:at\s+)?)?(?:(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?$/i;
const DAY_MS = 86_400_000;
/** How far in the past a reset may lie (clock skew, a window resetting right now). */
export const RESET_SKEW_MS = DAY_MS;

/** True when `zone` is an IANA zone `Intl` knows. */
export function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock fields of `ms` in `zone`. */
function wallClock(
  ms: number,
  zone: string,
): { y: number; mo: number; d: number; h: number; mi: number } {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const p: Record<string, string> = Object.fromEntries(
    fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]),
  );
  const n = (k: string) => Number(p[k]);
  return { y: n("year"), mo: n("month") - 1, d: n("day"), h: n("hour") % 24, mi: n("minute") };
}

/** UTC instant (ms) of a wall-clock time in `zone`. */
export function zonedToUtc(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  zone: string,
): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const offsetAt = (ms: number) => {
    const w = wallClock(ms, zone);
    return Date.UTC(w.y, w.mo, w.d, w.h, w.mi) - ms;
  };
  const first = guess - offsetAt(guess);
  return guess - offsetAt(first);
}

/** Result of {@link resolveReset}. */
export interface ResolvedReset {
  iso: string;
  zone: string;
  /** No zone in the text: the local zone was assumed. */
  zoneAssumed: boolean;
}

/**
 * Resolves `Nov 11 at 10am`, `Jan 2, 10:30pm`, `3pm` (next occurrence) or `Nov 11` (midnight) in
 * `zone` (else `localZone`) to the earliest matching instant not older than {@link RESET_SKEW_MS}.
 * Null when the text is not understood.
 */
export function resolveReset(
  text: string,
  zone: string | null,
  now: Date,
  localZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): ResolvedReset | null {
  const m = WHEN.exec(text.trim());
  if (!m || (!m[1] && !m[3])) return null;
  const tz = zone ?? localZone;
  if (!isTimeZone(tz)) return null;
  let hour = m[3] === undefined ? 0 : Number(m[3]);
  const minute = m[4] === undefined ? 0 : Number(m[4]);
  const ampm = m[5]?.toLowerCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const nowMs = now.getTime();
  const today = wallClock(nowMs, tz);
  const candidates: number[] = [];
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    const day = Number(m[2]);
    if (month < 0 || day < 1 || day > 31) return null;
    for (const y of [today.y - 1, today.y, today.y + 1]) {
      const ms = zonedToUtc(y, month, day, hour, minute, tz);
      if (wallClock(ms, tz).d === day) candidates.push(ms); // rejects Feb 30 and the like
    }
  } else {
    for (const add of [-1, 0, 1])
      candidates.push(zonedToUtc(today.y, today.mo, today.d + add, hour, minute, tz));
  }
  const skew = m[1] ? RESET_SKEW_MS : 0;
  const pick = candidates.filter((ms) => ms >= nowMs - skew).sort((a, b) => a - b)[0];
  if (pick === undefined) return null;
  return { iso: new Date(pick).toISOString(), zone: tz, zoneAssumed: zone === null };
}

// ---------------------------------------------------------------------------
// Grounding of LLM readings
// ---------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * True when every fact of an LLM-extracted window appears literally in `source`: the label, the
 * used percentage (as a whole number token), the zone, and each number / time token of the reset text.
 */
export function isGrounded(
  source: string,
  w: { label: string; usedPercent: number; resetText?: string | null; timeZone?: string | null },
): boolean {
  const hay = source.toLowerCase();
  if (!hay.includes(w.label.trim().toLowerCase())) return false;
  const pct = new RegExp(`(^|[^\\d.])${escapeRe(String(w.usedPercent))}(?![\\d]|\\.\\d)`);
  if (!pct.test(hay)) return false;
  if (w.timeZone && !hay.includes(w.timeZone.toLowerCase())) return false;
  const tokens = (w.resetText ?? "")
    .toLowerCase()
    .match(/\d{1,2}(?::\d{2})?\s*(?:am|pm)?|[a-z]{3,9}/g);
  for (const t of tokens ?? []) {
    if (t === "at" || t === "on") continue;
    if (!hay.includes(t)) return false;
  }
  return true;
}
