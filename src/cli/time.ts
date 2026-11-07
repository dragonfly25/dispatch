/** Time helpers for the CLI: duration flags, local timestamps and relative times. */
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 7 * 86_400_000,
};

/**
 * Parses a duration such as `90s`, `30m`, `24h`, `7d` or `2w` (units: ms s m h d w) into
 * milliseconds. `flag` names the option in the error message.
 *
 * @throws DispatchError (exit 2) for anything else, including zero.
 */
export function parseDuration(text: string, flag: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h|d|w)$/.exec(text.trim());
  const ms = m ? Number(m[1]) * (UNIT_MS[m[2] as string] as number) : 0;
  if (!(ms > 0)) {
    throw new DispatchError(
      `${flag} must be a duration like 90s, 30m, 24h or 7d, got "${text}"`,
      ExitCode.USAGE,
      "cli.usage",
    );
  }
  return ms;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** `YYYY-MM-DD HH:mm` in the machine's local time zone. */
export function formatLocal(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `HH:mm:ss` in the machine's local time zone. */
export function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** Compact length: `45s`, `12m`, `3h 20m`, `2d 4h`. */
export function formatSpan(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`;
}

/** `in 3h 20m`, `5m ago` or `now`, relative to `now`. */
export function formatRelative(iso: string, now: Date): string {
  const diff = Date.parse(iso) - now.getTime();
  if (Number.isNaN(diff)) return iso;
  if (Math.abs(diff) < 1000) return "now";
  return diff > 0 ? `in ${formatSpan(diff)}` : `${formatSpan(-diff)} ago`;
}

/** Local time plus relative time: `2026-11-07 13:00 (in 3h)`. */
export function formatWhen(iso: string, now: Date): string {
  return `${formatLocal(iso)} (${formatRelative(iso, now)})`;
}
