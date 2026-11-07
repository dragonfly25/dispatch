/** Minimal semver helpers for the adapter's `cliRange` (comparators joined by spaces). */

/** Parses `major.minor[.patch]` (any suffix ignored) into numbers; null when not a version. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)];
}

function compare(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True when `version` satisfies every comparator of `range`, e.g. `">=1.5.2 <1.6"`. Supports
 * `>=`, `>`, `<=`, `<` and `=`. An unparsable version or comparator never satisfies the range.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (!v) return false;
  const comparators = range.split(/\s+/).filter(Boolean);
  if (comparators.length === 0) return false;
  return comparators.every((c) => {
    const m = /^(>=|<=|>|<|=)?(.+)$/.exec(c);
    const bound = m?.[2] ? parseVersion(m[2]) : null;
    if (!m || !bound) return false;
    const d = compare(v, bound);
    switch (m[1]) {
      case ">=":
        return d >= 0;
      case ">":
        return d > 0;
      case "<=":
        return d <= 0;
      case "<":
        return d < 0;
      default:
        return d === 0;
    }
  });
}
