/**
 * Reliability rules (spec §8): when is a real reading trustworthy, when is it `stale`.
 * Pure functions of a reading, the current time and (optionally) the estimator's view.
 */
import { type QuotaWindow, QuotaWindowSchema } from "../core/contracts.js";

const MINUTE_MS = 60_000;

/** Tunables of the reliability rules. */
export interface ReliabilityConfig {
  /** Re-read a channel only when its newest reading is older than this (default 5). */
  cacheMinutes: number;
  /** A reading older than `cacheMinutes * staleFactor` is stale (default 3). */
  staleFactor: number;
  /**
   * An estimate at or above this used % makes a real reading of exactly 0% incoherent
   * (the channel claims nothing was used although Dispatch itself used it). Default 20.
   */
  significantEstimatePct: number;
}

export const DEFAULT_RELIABILITY: ReliabilityConfig = {
  cacheMinutes: 5,
  staleFactor: 3,
  significantEstimatePct: 20,
};

const ageMs = (w: QuotaWindow, now: Date): number => now.getTime() - Date.parse(w.readAt);

/** True when the reading is recent enough that no re-read is needed. */
export function isFresh(w: QuotaWindow, now: Date, cfg: ReliabilityConfig): boolean {
  return ageMs(w, now) <= cfg.cacheMinutes * MINUTE_MS && !hasRolledOver(w, now);
}

/** True when the reading is older than `cacheMinutes * staleFactor`. */
export function isOld(w: QuotaWindow, now: Date, cfg: ReliabilityConfig): boolean {
  return ageMs(w, now) > cfg.cacheMinutes * cfg.staleFactor * MINUTE_MS;
}

/** True when the window's announced reset has passed: the reading describes a finished window. */
export function hasRolledOver(w: QuotaWindow, now: Date): boolean {
  return w.resetAt !== null && Date.parse(w.resetAt) <= now.getTime();
}

/**
 * Why `w` cannot be believed, or `null` when it looks coherent. `estimatedPct` is the estimator's
 * value for the same window (null when unavailable, e.g. for the host).
 */
export function incoherence(
  w: QuotaWindow,
  estimatedPct: number | null,
  cfg: ReliabilityConfig,
): string | null {
  const parsed = QuotaWindowSchema.safeParse(w);
  if (!parsed.success) return "value out of range or malformed";
  if (w.usedPct === null) return "no used percentage";
  if (w.usedPct > 0 && w.resetAt === null) return "missing reset time";
  if (w.usedPct === 0 && estimatedPct !== null && estimatedPct >= cfg.significantEstimatePct) {
    return `reports 0% used while the estimator shows ${estimatedPct}%`;
  }
  return null;
}
