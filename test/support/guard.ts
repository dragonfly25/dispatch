import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envGet, isWindows, type OsPlatform } from "../../src/platform/os.js";

/** The three CLIs Dispatch drives; tests must only ever reach their fakes. */
export const FAKE_CLIS = ["claude", "codex", "agy"] as const;
export type FakeCli = (typeof FAKE_CLIS)[number];

const here = dirname(fileURLToPath(import.meta.url));
/** Absolute path of `test/fakes`. */
export const FAKES_DIR = join(here, "..", "fakes");
/** Absolute path of `test/fakes/bin` (the committed shims). */
export const FAKES_BIN = join(FAKES_DIR, "bin");
/** Absolute path of the fake CLI implementation. */
export const FAKE_CLI_JS = join(FAKES_DIR, "fake-cli.mjs");

/**
 * Committed files that make up the fake `cli` on `platform`: the sh shim on POSIX; on Windows the
 * npm cmd-shim `<cli>.cmd` and the `<cli>.mjs` entry it unwraps to. The first one is what PATH
 * lookup finds.
 */
export function fakeShimFiles(cli: FakeCli, platform: OsPlatform = process.platform): string[] {
  return isWindows(platform) ? [`${cli}.cmd`, `${cli}.mjs`] : [cli];
}

const pathDelimiter = (platform: OsPlatform): string => (isWindows(platform) ? ";" : ":");

/** Extensions Windows tries for a bare command name, from `PATHEXT` (lower-cased). */
function pathExts(pathext: string | undefined): string[] {
  return (pathext || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean)
    .map((e) => e.toLowerCase());
}

/**
 * First executable `name` on `pathValue`, or null (what a shell's `which` would pick). On Windows
 * each directory is tried with every `PATHEXT` extension and the exec bit is not checked.
 */
export function resolveOnPath(
  name: string,
  pathValue: string | undefined,
  platform: OsPlatform = process.platform,
  pathext: string | undefined = process.env.PATHEXT,
): string | null {
  const win = isWindows(platform);
  const names = win ? pathExts(pathext).map((ext) => `${name}${ext}`) : [name];
  for (const dir of (pathValue ?? "").split(pathDelimiter(platform))) {
    if (!dir) continue;
    for (const candidateName of names) {
      const candidate = join(dir, candidateName);
      try {
        if (!statSync(candidate).isFile()) continue;
        if (!win) accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** True when `found` is (a copy of) the committed fake `cli` for `platform`. */
function isFakeShim(found: string, cli: FakeCli, platform: OsPlatform): boolean {
  if (!isWindows(platform)) {
    return realpathSync(found) === join(realpathSync(FAKES_BIN), cli);
  }
  // Windows: symlinks need privileges, so fakes.ts copies the shim and its entry. Both copies must
  // be byte-identical to the committed files.
  const dir = dirname(found);
  return fakeShimFiles(cli, platform).every((file) => {
    try {
      return readFileSync(join(dir, file)).equals(readFileSync(join(FAKES_BIN, file)));
    } catch {
      return false;
    }
  });
}

/**
 * Throws unless `claude`, `codex` and `agy` all resolve, via the env's PATH, to a shim in
 * `test/fakes/bin` (symlinks are followed; on Windows a byte-identical copy counts). Called by
 * `createFakes`/`withFakes` so a test can never reach a real CLI through the PATH it hands to
 * Dispatch.
 */
export function assertNoRealCli(
  env: Record<string, string | undefined>,
  platform: OsPlatform = process.platform,
): void {
  const bad: string[] = [];
  const pathValue = envGet(env, "PATH", platform);
  const pathext = envGet(env, "PATHEXT", platform) ?? process.env.PATHEXT;
  for (const cli of FAKE_CLIS) {
    const found = resolveOnPath(cli, pathValue, platform, pathext);
    if (found === null) {
      bad.push(`${cli}: not on PATH`);
      continue;
    }
    if (!isFakeShim(found, cli, platform)) {
      bad.push(`${cli}: resolves to ${found} (${realpathSync(found)})`);
    }
  }
  if (bad.length > 0) {
    throw new Error(
      `Real CLI reachable from test PATH; only test/fakes/bin may provide it:\n  ${bad.join("\n  ")}`,
    );
  }
}

/**
 * Throws unless the committed shims and fake-cli.mjs exist (and, on POSIX, the shims are
 * executable; Windows has no exec bit, the `.cmd` extension makes them runnable).
 */
export function assertFakeShimsInstalled(platform: OsPlatform = process.platform): void {
  const files = FAKE_CLIS.flatMap((c) => fakeShimFiles(c, platform).map((f) => join(FAKES_BIN, f)));
  for (const file of [FAKE_CLI_JS, ...files]) {
    try {
      accessSync(file, constants.R_OK);
    } catch {
      throw new Error(`missing fake CLI file: ${file}`);
    }
  }
  if (isWindows(platform)) return;
  for (const cli of FAKE_CLIS) {
    try {
      accessSync(join(FAKES_BIN, cli), constants.X_OK);
    } catch {
      throw new Error(
        `fake shim is not executable: ${join(FAKES_BIN, cli)} (git update-index --chmod=+x)`,
      );
    }
  }
}
