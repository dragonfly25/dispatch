/** Helpers shared by the CLI commands. */
import { type AppContext, type AppEnv, loadAppContext } from "../../app/context.js";
import { refreshHookCacheSafely } from "../../app/hook-cache.js";
import type { Issue } from "../../config/index.js";
import type { Clock, Spawner } from "../../core/contracts.js";
import type { HostRegistry } from "../../hosts/_framework/registry.js";
import type { ResolveFs } from "../../platform/resolve.js";
import type { QuotaReaderRegistry } from "../../quota/reader.js";
import type { SignalTarget } from "../../runner/lifecycle.js";
import type { RunnerDeps } from "../../runner/orchestrate.js";
import { pidExists } from "../../runner/tree.js";
import type { CliIo } from "../io.js";

/** Test seams of `dispatch doctor`. */
export interface DoctorExtras {
  /** Doctor checks to run (default: the built-in registry). */
  registry?: HostRegistry;
  /** True when a person can answer the `--live` confirmation (default: stdin is a TTY). */
  interactive?: boolean;
  /** Answers the confirmation question. */
  ask?: (question: string) => Promise<string>;
  /** File access used to find the provider CLIs. */
  resolveFs?: ResolveFs;
  /** Where SIGINT/SIGTERM are trapped during `--live` (default: `process`; null disables). */
  signals?: SignalTarget | null;
}

/** What the commands need from the process; injectable for tests. */
export interface CliDeps {
  io: CliIo;
  cwd: string;
  env: AppEnv;
  clock?: Clock;
  /** Task id source (tests). */
  newId?: () => string;
  /** Built-in assets directory override (tests). */
  assetsDir?: string;
  /** Spawner for the default quota readers (default: a `ProcessSpawner`). */
  spawner?: Spawner;
  /** Quota readers override (tests pass an empty registry so no CLI is ever spawned). */
  quotaReaders?: QuotaReaderRegistry;
  /** `dispatch doctor` seams. */
  doctor?: DoctorExtras;
  /** Pause used by `logs --follow` between polls (tests inject a fake). */
  sleep?: (ms: number) => Promise<void>;
  /** Whether the process `pid` exists, for lease reaping in `gc` (tests inject a fake). */
  isAlive?: (pid: number) => boolean;
  /** Replaces runner dependencies, e.g. a per-test probe cache (tests). */
  runner?: Partial<RunnerDeps>;
  /** Command that starts this CLI for `run --detach`'s supervisor (default: this process's). */
  detachCli?: readonly string[];
}

/** Default {@link CliDeps.sleep}. */
export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default {@link CliDeps.isAlive}: signal 0 (a process we may not signal still exists). Node maps
 * signal 0 to an existence check on Windows too (EPERM there likewise means "exists").
 */
export function pidAlive(pid: number): boolean {
  return pidExists(pid);
}

/** Per-command options of {@link withContext}. */
export interface ContextOptions {
  /** `--provider <instance>`: see `LoadAppContextOptions.provider`. */
  provider?: string | undefined;
  /** The command only reads state: never creates the database (see `LoadAppContextOptions.readOnly`). */
  readOnly?: boolean;
}

/** Loads the app context, runs `fn` and always closes the context. */
export async function withContext<T>(
  deps: CliDeps,
  fn: (ctx: AppContext) => Promise<T> | T,
  options: ContextOptions = {},
): Promise<T> {
  const ctx = loadAppContext({
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    ...(options.readOnly ? { readOnly: true } : {}),
    cwd: deps.cwd,
    env: deps.env,
    ...(deps.clock ? { clock: deps.clock } : {}),
    ...(deps.newId ? { newId: deps.newId } : {}),
    ...(deps.assetsDir ? { assetsDir: deps.assetsDir } : {}),
    ...(deps.spawner ? { spawner: deps.spawner } : {}),
    ...(deps.quotaReaders ? { quotaReaders: deps.quotaReaders } : {}),
  });
  try {
    return await fn(ctx);
  } finally {
    ctx.close();
  }
}

/** Prints `value` as pretty JSON on stdout. */
export function printJson(io: CliIo, value: unknown): void {
  io.out(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Rewrites the hook cache for the policy now in effect (after `trust`, `use`, `install`, ...).
 * Best effort: a failure is a warning on stderr, never a failed command.
 */
export function refreshCache(
  deps: Pick<CliDeps, "io" | "cwd" | "env" | "clock" | "assetsDir">,
): void {
  refreshHookCacheSafely(
    {
      cwd: deps.cwd,
      env: deps.env,
      ...(deps.clock ? { clock: deps.clock } : {}),
      ...(deps.assetsDir ? { assetsDir: deps.assetsDir } : {}),
    },
    (message) => deps.io.err(`warning: ${message}\n`),
  );
}

/** Prints the loader's issues (untrusted repo policy, loosening attempts, ...) on stderr. */
export function reportIssues(io: CliIo, issues: readonly Issue[]): void {
  for (const i of issues) io.err(`${i.level}: ${i.key}: ${i.message}\n`);
}
