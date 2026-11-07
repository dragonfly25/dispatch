import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** First executable `name` on `pathValue`, or null (what a shell's `which` would pick). */
export function resolveOnPath(name: string, pathValue: string | undefined): string | null {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return null;
}

/**
 * Throws unless `claude`, `codex` and `agy` all resolve, via `env.PATH`, to a shim in
 * `test/fakes/bin` (symlinks are followed). Called by `createFakes`/`withFakes` so a test can
 * never reach a real CLI through the PATH it hands to Dispatch.
 */
export function assertNoRealCli(env: Record<string, string | undefined>): void {
  const bad: string[] = [];
  const binReal = realpathSync(FAKES_BIN);
  for (const cli of FAKE_CLIS) {
    const found = resolveOnPath(cli, env.PATH);
    if (found === null) {
      bad.push(`${cli}: not on PATH`);
      continue;
    }
    const real = realpathSync(found);
    if (real !== join(binReal, cli)) bad.push(`${cli}: resolves to ${found} (${real})`);
  }
  if (bad.length > 0) {
    throw new Error(
      `Real CLI reachable from test PATH; only test/fakes/bin may provide it:\n  ${bad.join("\n  ")}`,
    );
  }
}

/** Throws unless the committed shims and fake-cli.mjs exist and are executable. */
export function assertFakeShimsInstalled(): void {
  for (const file of [FAKE_CLI_JS, ...FAKE_CLIS.map((c) => join(FAKES_BIN, c))]) {
    try {
      accessSync(file, constants.R_OK);
    } catch {
      throw new Error(`missing fake CLI file: ${file}`);
    }
  }
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
