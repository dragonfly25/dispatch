import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Filesystem access used by {@link resolveBinary}; injectable for tests. */
export interface ResolveFs {
  /** True when `path` is a regular file (after symlinks) that the user may execute. */
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
 * Finds the executable `name` for a child CLI. Order: configured absolute path (an error when it
 * is not an executable file) → `PATH` → well-known dirs (`/opt/homebrew/bin`, `/usr/local/bin`,
 * `~/.local/bin`, npm prefix bin, node's own bin dir, `extraDirs`). Relative PATH entries are
 * ignored. Returns null when nothing is found.
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
