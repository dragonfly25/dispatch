/**
 * Canonical JSON and input hashing for the pure router.
 *
 * Two inputs that differ only in object key order (or in `undefined`-valued keys) produce the same
 * canonical text and therefore the same hash, which is what `explain --replay` compares.
 */
import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonicalize(v)));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

/**
 * Serialises `value` as JSON with object keys sorted recursively. `undefined` object members are
 * dropped and `undefined` array items become `null`, exactly like `JSON.stringify`.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "null";
}

/** SHA-256 (lowercase hex) of {@link canonicalJson}; used as `Decision.inputHash`. */
export function inputHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
