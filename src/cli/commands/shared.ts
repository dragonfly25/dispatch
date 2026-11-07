/** Helpers shared by the CLI commands. */
import { type AppContext, type AppEnv, loadAppContext } from "../../app/context.js";
import type { Issue } from "../../config/index.js";
import type { Clock, Spawner } from "../../core/contracts.js";
import type { QuotaReaderRegistry } from "../../quota/reader.js";
import type { CliIo } from "../io.js";

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
}

/** Loads the app context, runs `fn` and always closes the context. */
export async function withContext<T>(
  deps: CliDeps,
  fn: (ctx: AppContext) => Promise<T> | T,
): Promise<T> {
  const ctx = loadAppContext({
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

/** Prints the loader's issues (untrusted repo policy, loosening attempts, ...) on stderr. */
export function reportIssues(io: CliIo, issues: readonly Issue[]): void {
  for (const i of issues) io.err(`${i.level}: ${i.key}: ${i.message}\n`);
}
