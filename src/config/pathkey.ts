/**
 * Path spelling helpers that differ between POSIX and Windows: comparison keys, containment,
 * `~` expansion and `~` shortening for display.
 *
 * POSIX behaviour is byte-exact (no normalisation), as before the Windows port. On Windows,
 * paths compare case-insensitively with `/` and `\` treated alike, because NTFS is
 * case-insensitive and git prints `C:/Users/...` while Node prints `C:\Users\...`.
 *
 * Imports node built-ins and `platform/os` only: the hook bundle uses it.
 */
import path from "node:path";
import { isWindows, type OsPlatform } from "../platform/os.js";

/** The `node:path` flavour of `platform`. */
export function pathApi(platform: OsPlatform = process.platform): typeof path.posix {
  return isWindows(platform) ? path.win32 : path.posix;
}

/**
 * A key under which two spellings of one path compare equal. POSIX: `p` unchanged. Windows:
 * normalised (`/` → `\`, `.`/`..` collapsed), without a trailing separator (except at a root
 * such as `C:\`), lower-cased.
 */
export function pathKey(p: string, platform: OsPlatform = process.platform): string {
  if (!isWindows(platform)) return p;
  let n = path.win32.normalize(p);
  while (n.length > 1 && n.endsWith("\\") && !/^[A-Za-z]:\\$/.test(n) && !/^\\\\$/.test(n)) {
    n = n.slice(0, -1);
  }
  return n.toLowerCase();
}

/** True when `a` and `b` name the same path (see {@link pathKey}). */
export function samePathKey(
  a: string,
  b: string,
  platform: OsPlatform = process.platform,
): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

/**
 * True when `child` is `parent` or lies below it. POSIX: plain string prefix with `/` (the
 * pre-port rule). Windows: compared on {@link pathKey}s.
 */
export function isPathInside(
  child: string,
  parent: string,
  platform: OsPlatform = process.platform,
): boolean {
  const sep = isWindows(platform) ? "\\" : "/";
  const c = pathKey(child, platform);
  const p = pathKey(parent, platform);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Expands a leading `~` (`~`, `~/x`; on Windows also `~\x`) against `home`. Anything else, or
 * an unknown home, returns `p` unchanged.
 */
export function expandTilde(
  p: string,
  home: string | undefined,
  platform: OsPlatform = process.platform,
): string {
  if (!home) return p;
  if (p === "~") return home;
  const tilde = p.startsWith("~/") || (isWindows(platform) && p.startsWith("~\\"));
  return tilde ? pathApi(platform).join(home, p.slice(2)) : p;
}

/**
 * `path` relative to `home`, spelled with the platform's separator (`a/b` or `a\b`); null when
 * `path` is not strictly below `home` or `home` is unknown or a root.
 */
export function relativeToHome(
  p: string,
  home: string | undefined,
  platform: OsPlatform = process.platform,
): string | null {
  if (!home) return null;
  const api = pathApi(platform);
  if (isWindows(platform)) {
    const base = api.normalize(home);
    if (api.parse(base).root === base || pathKey(p, platform) === pathKey(base, platform)) {
      return null;
    }
    return isPathInside(p, base, platform) ? api.relative(base, p) : null;
  }
  if (home === "/") return null;
  const base = home.endsWith("/") ? home.slice(0, -1) : home;
  return p.startsWith(`${base}/`) ? p.slice(base.length + 1) : null;
}
