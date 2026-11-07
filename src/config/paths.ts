/**
 * Where Dispatch config files live (plan §2 "Config", spec §10).
 *
 * - Global: `$DISPATCH_HOME` or `$HOME/.dispatch`, holding `config.yaml` and optional
 *   user-wide `profiles/*.yaml` and `mappings/*.yaml`.
 * - Repo: `<worktree>/.dispatch/{config.yaml,profiles/*.yaml,mappings/*.yaml}`.
 * - Built-in defaults: `assets/` at the package root (works from `src/` and from `dist/`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Environment variables Dispatch reads to locate its home. */
export type PathEnv = Readonly<Record<string, string | undefined>>;

/** Directory name of the per-repo policy folder. */
export const REPO_DIR = ".dispatch";
/** File name of the main config file (global and repo). */
export const CONFIG_FILE = "config.yaml";
/** Sub-directories holding one YAML document per profile / mapping. */
export const PROFILES_DIR = "profiles";
export const MAPPINGS_DIR = "mappings";

/** Dispatch's global home: `$DISPATCH_HOME`, else `$HOME/.dispatch`. */
export function dispatchHome(env: PathEnv): string {
  const explicit = env.DISPATCH_HOME;
  if (explicit) return explicit;
  const home = env.HOME;
  if (!home) {
    throw new DispatchError(
      "cannot locate the Dispatch home: neither DISPATCH_HOME nor HOME is set",
      ExitCode.USAGE,
      "config.no_home",
    );
  }
  return join(home, REPO_DIR);
}

/** Path of the global config file. */
export function globalConfigPath(env: PathEnv): string {
  return join(dispatchHome(env), CONFIG_FILE);
}

/** Paths of the repo policy folder and its parts, given the worktree root. */
export function repoPaths(worktreeRoot: string): {
  dir: string;
  config: string;
  profiles: string;
  mappings: string;
} {
  const dir = join(worktreeRoot, REPO_DIR);
  return {
    dir,
    config: join(dir, CONFIG_FILE),
    profiles: join(dir, PROFILES_DIR),
    mappings: join(dir, MAPPINGS_DIR),
  };
}

const PACKAGE_NAME = "@dragonfly25/dispatch";

/**
 * Package root: the nearest ancestor of `fromDir` whose package.json is Dispatch's own.
 * Defaults to this module's directory, so it resolves from `src/config/` and `dist/` alike.
 */
export function packageRoot(fromDir = dirname(fileURLToPath(import.meta.url))): string {
  let dir = fromDir;
  for (;;) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: unknown }).name;
      if (name === PACKAGE_NAME) return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new DispatchError(`cannot find the ${PACKAGE_NAME} package root`, ExitCode.FAILED);
    }
    dir = parent;
  }
}

/** Directory of the built-in default profiles, mappings and model tables. */
export function assetsDir(): string {
  return join(packageRoot(), "assets");
}
