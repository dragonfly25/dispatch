import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { envGet, homeDir, isWindows, type OsPlatform } from "./os.js";

// The POSIX lookup uses POSIX path rules whatever the host (identical to node:path there), so an
// injected non-Windows platform behaves the same on a Windows host; Windows uses `win32` below.
const { delimiter, dirname, isAbsolute, join } = posix;

/** Filesystem access used by {@link resolveBinary}; injectable for tests. */
export interface ResolveFs {
  /**
   * True when `path` is a regular file (after symlinks) that the user may execute. On Windows
   * `X_OK` is the same as `F_OK`, so this means "an existing regular file"; the extension check
   * is done by {@link resolveBinary}.
   */
  isExecutableFile(path: string): boolean;
  /** Canonical path with symlinks resolved. */
  realpath(path: string): string;
}

/** Default implementation over `node:fs` (no child processes). */
export const nodeResolveFs: ResolveFs = {
  isExecutableFile(path) {
    try {
      if (!statSync(path).isFile()) return false;
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  realpath: (path) => realpathSync(path),
};

/** Where a binary was found. */
export type BinarySource = "config" | "path" | "well-known";

/** A resolved executable. `realpath` exposes versioned dirs behind symlinks (e.g. Caskroom). */
export interface ResolvedBinary {
  path: string;
  realpath: string;
  source: BinarySource;
}

/** Options of {@link resolveBinary}. */
export interface ResolveOptions {
  /** `binary:` from config; must be an absolute path to an executable file. */
  configured?: string | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** Extra directories searched after the well-known ones. */
  extraDirs?: readonly string[];
  fs?: ResolveFs;
  /** Node binary used to derive its sibling bin dir; defaults to `process.execPath`. */
  execPath?: string;
  /** Platform whose lookup rules apply; defaults to `process.platform`. */
  platform?: OsPlatform;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/** Well-known install dirs, in order. The npm global prefix is derived from env, never spawned. */
function wellKnownDirs(opts: ResolveOptions): string[] {
  const { env } = opts;
  const dirs = ["/opt/homebrew/bin", "/usr/local/bin"];
  if (env.HOME) dirs.push(join(env.HOME, ".local", "bin"));
  for (const prefix of [env.npm_config_prefix, env.NPM_CONFIG_PREFIX]) {
    if (prefix) dirs.push(join(prefix, "bin"));
  }
  // node installed as <prefix>/bin/node: npm's global bin is that same directory.
  dirs.push(dirname(opts.execPath ?? process.execPath));
  dirs.push(...(opts.extraDirs ?? []));
  return dirs;
}

function configuredError(name: string, reason: string): DispatchError {
  return new DispatchError(
    `configured binary for ${name} ${reason}`,
    ExitCode.USAGE,
    "binary.configured_invalid",
  );
}

/**
 * Extensions Dispatch can start on Windows without a shell: `.exe`/`.com` directly, `.cmd`/`.bat`
 * only as npm shims unwrapped by `toSpawnCommand`. Never `.ps1`, never an extensionless file
 * (npm puts a POSIX sh script named `codex` next to `codex.cmd`).
 */
export const WINDOWS_BINARY_EXTENSIONS: readonly string[] = [".com", ".exe", ".bat", ".cmd"];

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/**
 * Absolute on Windows means drive-qualified (`C:\x`) or UNC (`\\server\share`). Root-relative
 * (`\x`) and drive-relative (`C:x`) paths depend on the current drive/directory and are refused.
 */
export function isWindowsAbsolute(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path);
}

/** True when `path` ends in one of {@link WINDOWS_BINARY_EXTENSIONS} (case-insensitive). */
function hasWindowsBinaryExtension(path: string): boolean {
  return WINDOWS_BINARY_EXTENSIONS.includes(win32.extname(path).toLowerCase());
}

/**
 * Lowercased extensions to try, in `PATHEXT` order, restricted to
 * {@link WINDOWS_BINARY_EXTENSIONS}; the default order when `PATHEXT` names none of them.
 */
export function windowsExtensions(env: ResolveOptions["env"]): string[] {
  const listed = (envGet(env, "PATHEXT", "win32") ?? DEFAULT_PATHEXT)
    .split(";")
    .map((e) => e.trim().toLowerCase())
    .filter((e) => WINDOWS_BINARY_EXTENSIONS.includes(e));
  const unique = [...new Set(listed)];
  return unique.length > 0 ? unique : DEFAULT_PATHEXT.toLowerCase().split(";");
}

/** `PATH` entries on Windows: `;`-separated, surrounding quotes stripped, empty ones dropped. */
export function windowsPathEntries(env: ResolveOptions["env"]): string[] {
  return (envGet(env, "PATH", "win32") ?? "")
    .split(win32.delimiter)
    .map((e) => e.trim().replace(/^"(.*)"$/, "$1"))
    .filter((e) => e !== "");
}

/**
 * Well-known install dirs on Windows, in order: `%USERPROFILE%\.local\bin` (Claude Code native
 * installer), `%APPDATA%\npm` (npm global bin), the npm prefix itself (on Windows the global bin
 * is the prefix dir, not `<prefix>\bin`), node's own dir, `extraDirs`.
 */
function windowsWellKnownDirs(opts: ResolveOptions): string[] {
  const { env } = opts;
  const dirs: string[] = [];
  const home = homeDir(env, "win32");
  if (home !== undefined) dirs.push(win32.join(home, ".local", "bin"));
  const appData = envGet(env, "APPDATA", "win32");
  if (appData !== undefined) dirs.push(win32.join(appData, "npm"));
  // envGet is case-insensitive on Windows: npm_config_prefix and NPM_CONFIG_PREFIX are one name.
  const prefix = envGet(env, "npm_config_prefix", "win32");
  if (prefix !== undefined) dirs.push(prefix);
  dirs.push(win32.dirname(opts.execPath ?? process.execPath));
  dirs.push(...(opts.extraDirs ?? []));
  return dirs;
}

/** {@link resolveBinary} with Windows rules (see there). */
function resolveWindows(
  name: string,
  opts: ResolveOptions,
  fs: ResolveFs,
  make: (path: string, source: BinarySource) => ResolvedBinary,
): ResolvedBinary | null {
  const configured = opts.configured;
  if (configured !== undefined) {
    if (!isWindowsAbsolute(configured)) {
      throw configuredError(
        name,
        `must be an absolute path (e.g. C:\\...\\${name}.exe): ${JSON.stringify(configured)}`,
      );
    }
    if (!hasWindowsBinaryExtension(configured)) {
      throw configuredError(
        name,
        `must be a .exe, .com, .cmd or .bat file: ${JSON.stringify(configured)}`,
      );
    }
    if (!fs.isExecutableFile(configured)) {
      throw configuredError(name, `is missing or not executable: ${configured}`);
    }
    return make(configured, "config");
  }

  const exts = windowsExtensions(opts.env);
  const search = (dirs: readonly string[], source: BinarySource): ResolvedBinary | null => {
    for (const dir of dirs) {
      if (!isWindowsAbsolute(dir)) continue;
      for (const ext of exts) {
        const candidate = win32.join(dir, `${name}${ext}`);
        if (fs.isExecutableFile(candidate)) return make(candidate, source);
      }
    }
    return null;
  };
  return (
    search(windowsPathEntries(opts.env), "path") ?? search(windowsWellKnownDirs(opts), "well-known")
  );
}

/**
 * Finds the executable `name` for a child CLI. Order: configured absolute path (an error when it
 * is not an executable file) → `PATH` → well-known dirs (`/opt/homebrew/bin`, `/usr/local/bin`,
 * `~/.local/bin`, npm prefix bin, node's own bin dir, `extraDirs`). Relative PATH entries are
 * ignored. Returns null when nothing is found.
 *
 * On Windows (`platform: "win32"`) each directory is tried with `name` plus each extension of
 * `PATHEXT` limited to `.com/.exe/.bat/.cmd` (see {@link windowsExtensions}); an extensionless
 * or `.ps1` file never matches. `PATH` is `;`-separated and read case-insensitively, absolute
 * means drive-qualified or UNC, the well-known dirs are `%USERPROFILE%\.local\bin`,
 * `%APPDATA%\npm`, the npm prefix and node's dir, and a configured binary must be an absolute
 * path with one of those extensions. A resolved `.cmd` must go through `toSpawnCommand`.
 */
export function resolveBinary(name: string, opts: ResolveOptions): ResolvedBinary | null {
  if (!NAME.test(name)) {
    throw new DispatchError(
      `invalid binary name ${JSON.stringify(name)}`,
      ExitCode.USAGE,
      "binary.invalid_name",
    );
  }
  const fs = opts.fs ?? nodeResolveFs;
  const make = (path: string, source: BinarySource): ResolvedBinary => ({
    path,
    realpath: fs.realpath(path),
    source,
  });
  if (isWindows(opts.platform ?? process.platform)) return resolveWindows(name, opts, fs, make);

  const configured = opts.configured;
  if (configured !== undefined) {
    if (!isAbsolute(configured)) {
      throw configuredError(name, `must be an absolute path: ${JSON.stringify(configured)}`);
    }
    if (!fs.isExecutableFile(configured)) {
      throw configuredError(name, `is missing or not executable: ${configured}`);
    }
    return make(configured, "config");
  }

  const search = (dirs: readonly string[], source: BinarySource): ResolvedBinary | null => {
    for (const dir of dirs) {
      if (!isAbsolute(dir)) continue;
      const candidate = join(dir, name);
      if (fs.isExecutableFile(candidate)) return make(candidate, source);
    }
    return null;
  };

  return (
    search((opts.env.PATH ?? "").split(delimiter), "path") ??
    search(wellKnownDirs(opts), "well-known")
  );
}
