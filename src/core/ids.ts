import { randomBytes } from "node:crypto";
import { systemClock } from "./clock.js";
import type { Clock } from "./contracts.js";

/** Crockford base32 (no I, L, O, U), as used by ULID. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LEN = 10;
const RANDOM_LEN = 16;

/** Matches ids produced by {@link newRunId}. */
export const RUN_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * Returns a 26-char ULID-style id: 48-bit millisecond timestamp + 80 random bits.
 * Ids sort lexicographically by creation time (ties within one millisecond are random).
 */
export function newRunId(
  clock: Clock = systemClock,
  random: (n: number) => Uint8Array = randomBytes,
): string {
  let ms = clock.now().getTime();
  if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError(`invalid timestamp: ${ms}`);
  let time = "";
  for (let i = 0; i < TIME_LEN; i++) {
    time = ALPHABET.charAt(ms % 32) + time;
    ms = Math.floor(ms / 32);
  }
  let rand = "";
  for (const byte of random(RANDOM_LEN)) rand += ALPHABET.charAt(byte % 32);
  return time + rand;
}

/** Decodes the creation time embedded in a run id. */
export function runIdTime(id: string): Date {
  if (!RUN_ID_PATTERN.test(id)) throw new RangeError(`not a run id: ${id}`);
  let ms = 0;
  for (const ch of id.slice(0, TIME_LEN)) ms = ms * 32 + ALPHABET.indexOf(ch);
  return new Date(ms);
}
