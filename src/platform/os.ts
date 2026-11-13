/**
 * OS differences in one place (Windows support).
 *
 * Every POSIX/Windows branch in Dispatch goes through these helpers so the decision is testable
 * with an injected `platform` instead of `process.platform`. Callers pass `platform` explicitly
 * when they already have one (doctor, CLI context); otherwise the running platform is used.
 */
import type { Stats } from "node:fs";

/** `process.platform` values Dispatch distinguishes. */
export type OsPlatform = NodeJS.Platform;

type Env = Readonly<Record<string, string | undefined>>;

/** True on native Windows (`win32`). WSL reports `linux` and takes the POSIX paths. */
export function isWindows(platform: OsPlatform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Reads `key` from `env`. On Windows env names are case-insensitive (`Path` vs `PATH`), so a
 * plain-object copy of `process.env` must be searched without regard to case; on POSIX the lookup
 * is exact. Empty values count as unset.
 */
export function envGet(
  env: Env,
  key: string,
  platform: OsPlatform = process.platform,
): string | undefined {
  const exact = env[key];
  if (exact !== undefined && exact !== "") return exact;
  if (!isWindows(platform)) return undefined;
  const upper = key.toUpperCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toUpperCase() === upper && v !== undefined && v !== "") return v;
  }
  return undefined;
}

/**
 * The actual name of `key` in `env` (Windows: the first case-insensitive match, e.g. `Path`),
 * or `key` itself when absent. Use it when writing a variable back into a copied env, so the
 * child never receives both `Path` and `PATH`.
 */
export function envKey(env: Env, key: string, platform: OsPlatform = process.platform): string {
  if (!isWindows(platform) || key in env) return key;
  const upper = key.toUpperCase();
  return Object.keys(env).find((k) => k.toUpperCase() === upper) ?? key;
}

/**
 * The user's home directory from env: `HOME`, else (Windows) `USERPROFILE`, else
 * `HOMEDRIVE`+`HOMEPATH`. Undefined when none is set. Never calls `os.homedir()`, so tests and
 * children stay env-driven.
 */
export function homeDir(env: Env, platform: OsPlatform = process.platform): string | undefined {
  const home = envGet(env, "HOME", platform);
  if (home !== undefined) return home;
  if (!isWindows(platform)) return undefined;
  const profile = envGet(env, "USERPROFILE", platform);
  if (profile !== undefined) return profile;
  const drive = envGet(env, "HOMEDRIVE", platform);
  const path = envGet(env, "HOMEPATH", platform);
  return drive !== undefined && path !== undefined ? `${drive}${path}` : undefined;
}

/**
 * Windows variables a child process needs to start at all (system DLL lookup, temp dirs, the
 * user profile, `PATHEXT` for tool lookup). Forwarded in addition to the POSIX base allow-list
 * on Windows only; none of them carries a secret.
 */
export const WINDOWS_BASE_ENV: readonly string[] = [
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
];

/**
 * True when a file Dispatch wrote for the current user only is still private: owned by this uid
 * and with no group/other permission bits. Windows has no uid and `stat.mode` does not reflect
 * ACLs (files under the user profile inherit a user-only ACL), so the check passes there; the
 * caller's other checks (regular file, not a symlink, name format) still apply.
 */
export function isOwnerOnly(
  st: Pick<Stats, "uid" | "mode">,
  platform: OsPlatform = process.platform,
  uid: number | undefined = process.getuid?.(),
): boolean {
  if (isWindows(platform)) return true;
  if (uid !== undefined && st.uid !== uid) return false;
  return (st.mode & 0o077) === 0;
}

/** Name of the launcher file under `<dispatchHome>/bin`: `dispatch` (sh) or `dispatch.cmd`. */
export function launcherFileName(platform: OsPlatform = process.platform): string {
  return isWindows(platform) ? "dispatch.cmd" : "dispatch";
}
