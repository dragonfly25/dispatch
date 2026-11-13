/**
 * Shared harness of the security suite (WP28): builds the real entry points once per test file,
 * then runs them as separate processes against fake CLIs, a temp HOME and temp repos.
 *
 * Bundles go to `node_modules/.cache/` inside the package (not `dist/`, which other tests rebuild
 * concurrently): `packageRoot()` must find this package's package.json above the bundle so the
 * built-in assets resolve, and the external dependencies resolve from `node_modules/`.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "tsup";
import { envGet, isWindows, type OsPlatform, WINDOWS_BASE_ENV } from "../../src/platform/os.js";

export const ROOT = resolve(import.meta.dirname, "../..");
export const FS_TRACE = join(import.meta.dirname, "fs-trace.cjs");

/** Paths of the bundles built by {@link buildBundles}. */
export interface Bundles {
  dir: string;
  /** `dispatch` CLI (src/cli/main.ts), like dist/cli.mjs. */
  cli: string;
  /** Hook entry (src/hook/entry.ts), like dist/hook.mjs. */
  hook: string;
  cleanup(): void;
}

/** Builds the CLI and the hook entry into a fresh cache directory. */
export async function buildBundles(): Promise<Bundles> {
  const parent = join(ROOT, "node_modules", ".cache", "dispatch-security");
  mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, "b-"));
  await build({
    entry: {
      cli: "src/cli/main.ts",
      hook: "src/hook/entry.ts",
    },
    outDir: dir,
    format: ["esm"],
    outExtension: () => ({ js: ".mjs" }),
    platform: "node",
    target: "node22",
    splitting: false,
    removeNodeProtocol: false,
    silent: true,
    clean: false,
    dts: false,
    config: false,
  });
  return {
    dir,
    cli: join(dir, "cli.mjs"),
    hook: join(dir, "hook.mjs"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export interface NodeRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * `env` plus, on Windows, the `WINDOWS_BASE_ENV` system variables of this process that `env` does
 * not set (node cannot start without SYSTEMROOT & co.). Unchanged on POSIX.
 */
export function withWindowsBase(
  env: Record<string, string>,
  platform: OsPlatform = process.platform,
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  if (!isWindows(platform)) return env;
  const out = { ...env };
  for (const key of WINDOWS_BASE_ENV) {
    const value = envGet(source, key, platform);
    if (value !== undefined && envGet(out, key, platform) === undefined) out[key] = value;
  }
  return out;
}

/**
 * Runs `node [--require fs-trace.cjs] <script> ...args` with exactly `env` (nothing inherited;
 * on Windows the system variables of {@link withWindowsBase} are added).
 * `trace` names the file the fs-trace preload writes to.
 */
export function runNode(
  script: string,
  args: readonly string[],
  opts: { cwd: string; env: Record<string, string>; trace?: string; input?: string },
): NodeRun {
  const pre = opts.trace ? ["--require", FS_TRACE] : [];
  const env = withWindowsBase(opts.trace ? { ...opts.env, FS_TRACE_OUT: opts.trace } : opts.env);
  const r: SpawnSyncReturns<string> = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", ...pre, script, ...args],
    { cwd: opts.cwd, env, encoding: "utf8", input: opts.input ?? "", timeout: 60_000 },
  );
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
