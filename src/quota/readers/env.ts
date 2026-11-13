/**
 * Child environment of the quota readers: an allow-list, never the whole parent environment
 * (plan §2 "Child isolation"). Credentials are not copied; the CLI finds its own login through
 * HOME / its config-dir variable (on Windows: USERPROFILE / APPDATA).
 */
import type { ProviderInstance } from "../../core/contracts.js";
import { isWindows, type OsPlatform, WINDOWS_BASE_ENV } from "../../platform/os.js";

const ALLOWED = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"]);
/** Windows: names compared upper-cased (env names are case-insensitive there). */
const ALLOWED_WIN32 = new Set([...ALLOWED, ...WINDOWS_BASE_ENV]);

/** True when `key` may be copied into a reader's child env on `platform`. */
export function readerEnvAllowed(key: string, platform: OsPlatform = process.platform): boolean {
  if (isWindows(platform)) {
    const upper = key.toUpperCase();
    return ALLOWED_WIN32.has(upper) || upper.startsWith("LC_");
  }
  return ALLOWED.has(key) || key.startsWith("LC_");
}

/**
 * Builds the child env from `base` (usually `process.env`): allow-listed variables only,
 * `TERM=dumb`, plus `configVar=instance.configDir` when the instance has its own config dir.
 * On Windows the allow-list also holds {@link WINDOWS_BASE_ENV} and matches names without regard
 * to case; each variable keeps the parent's spelling (`Path`), and only the first spelling of a
 * name is copied, so the child never gets both `Path` and `PATH`.
 */
export function buildReaderEnv(
  base: Readonly<Record<string, string | undefined>>,
  instance: ProviderInstance,
  configVar?: string,
  platform: OsPlatform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  const seen = new Set<string>();
  const win = isWindows(platform);
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined || !readerEnvAllowed(key, platform)) continue;
    if (win) {
      const upper = key.toUpperCase();
      if (seen.has(upper)) continue;
      seen.add(upper);
    }
    env[key] = value;
  }
  env.TERM = "dumb";
  if (configVar && instance.configDir) env[configVar] = instance.configDir;
  return env;
}
