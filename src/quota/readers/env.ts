/**
 * Child environment of the quota readers: an allow-list, never the whole parent environment
 * (plan §2 "Child isolation"). Credentials are not copied; the CLI finds its own login through
 * HOME / its config-dir variable.
 */
import type { ProviderInstance } from "../../core/contracts.js";

const ALLOWED = new Set(["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"]);

/**
 * Builds the child env from `base` (usually `process.env`): allow-listed variables only,
 * `TERM=dumb`, plus `configVar=instance.configDir` when the instance has its own config dir.
 */
export function buildReaderEnv(
  base: Readonly<Record<string, string | undefined>>,
  instance: ProviderInstance,
  configVar?: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && (ALLOWED.has(key) || key.startsWith("LC_"))) env[key] = value;
  }
  env.TERM = "dumb";
  if (configVar && instance.configDir) env[configVar] = instance.configDir;
  return env;
}
