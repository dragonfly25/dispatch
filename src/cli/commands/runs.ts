/**
 * Detached-run commands (WP23, UC3): `wait`, `cancel`, the hidden `__supervise`, and
 * {@link detachRun}, the body of `run --detach` (wired by the `run` command).
 */
import { join } from "node:path";
import { Command } from "commander";
import { type AppContext, loadAppContext } from "../../app/context.js";
import { runnerDeps } from "../../app/runner.js";
import { dispatchHome } from "../../config/index.js";
import { systemClock } from "../../core/clock.js";
import { ExitCode, type RunResult, type Task } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { detectHost } from "../../platform/host.js";
import {
  type DetachOptions,
  recordSupervisorFailure,
  SUPERVISE_COMMAND,
  startDetached,
  superviseRun,
} from "../../runner/detach.js";
import {
  cancelRun,
  defaultWaitSeconds,
  findRunDir,
  type RunningStatus,
  type WaitDeps,
  waitForRun,
} from "../../runner/wait.js";
import { repoRoot } from "../../sandbox/git.js";
import { SqliteStateStore } from "../../state/store.js";
import { ExitRequest } from "../exit.js";
import { renderRunResult } from "./run.js";
import { type CliDeps, printJson } from "./shared.js";

/** Starts `task` detached and prints `{ "runId": ... }` (the body of `run --detach`). */
export async function detachRun(
  deps: CliDeps,
  ctx: AppContext,
  task: Task,
  opts: Omit<DetachOptions, "repoPath"> & { cli?: readonly string[] },
): Promise<string> {
  const { cli: explicit, ...rest } = opts;
  const cli = explicit ?? deps.detachCli;
  const { runId } = await startDetached(
    {
      store: ctx.store,
      clock: ctx.clock,
      env: ctx.env,
      dispatchHome: ctx.dispatchHome,
      host: ctx.host.detection,
      ...(cli ? { cli } : {}),
    },
    task,
    { ...rest, repoPath: ctx.cwd },
  );
  printJson(deps.io, { runId });
  return runId;
}

/** Opens the state store directly (no config load: `wait` must work whatever the config). */
async function withStore<T>(
  deps: CliDeps,
  fn: (w: WaitDeps, store: SqliteStateStore) => Promise<T>,
): Promise<T> {
  const home = dispatchHome(deps.env);
  const clock = deps.clock ?? systemClock;
  const store = SqliteStateStore.open(join(home, "state", "dispatch.db"), { clock });
  const root = await repoRoot(deps.cwd).catch(() => null);
  try {
    return await fn({ store, clock, runDir: (id) => findRunDir(root, home, id) }, store);
  } finally {
    store.close();
  }
}

/**
 * Human-readable form of a `wait` / `cancel` answer: a finished run prints exactly like `run`;
 * a run still going lists its latest events.
 */
export function renderRun(r: RunResult | RunningStatus): string {
  if (!("progress" in r)) return renderRunResult(r);
  const lines = [`Run ${r.runId}: running`];
  for (const e of r.progress) lines.push(`  ${e.ts} ${e.kind}${e.detail ? ` ${e.detail}` : ""}`);
  return `${lines.join("\n")}\n`;
}

function parseTimeout(raw: string | undefined, deps: CliDeps): number | null {
  if (raw === undefined) {
    const s = defaultWaitSeconds(detectHost(deps.env).host);
    return s === null ? null : s * 1000;
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    throw new DispatchError(
      `--timeout must be a non-negative number of seconds, got "${raw}"`,
      ExitCode.USAGE,
      "cli.usage",
    );
  }
  return Math.ceil(seconds * 1000);
}

/** Registers `wait`, `cancel` and the hidden `__supervise`. */
export function registerRunCommands(program: Command, deps: CliDeps): void {
  const { io } = deps;
  program
    .command("wait")
    .description("wait for a detached run; exits 75 while it is still running")
    .argument("<runId>", "id printed by `run --detach`")
    .option(
      "--timeout <seconds>",
      "give up after this long (default: 100 in Claude Code, 280 in Codex, none outside a host)",
    )
    .option("--json", "machine-readable output")
    .action(async (runId: string, opts: { timeout?: string; json?: boolean }) => {
      const timeoutMs = parseTimeout(opts.timeout, deps);
      const { result, exitCode } = await withStore(deps, (w) => waitForRun(w, runId, timeoutMs));
      if (opts.json) printJson(io, result);
      else io.out(renderRun(result));
      if (exitCode !== ExitCode.OK) throw new ExitRequest(exitCode);
    });

  program
    .command("cancel")
    .description("cancel a detached run (its agent is stopped, nothing is applied)")
    .argument("<runId>", "id printed by `run --detach`")
    .option("--json", "machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const result = await withStore(deps, (w) => cancelRun(w, runId));
      if (opts.json) printJson(io, result);
      else io.out(renderRun(result));
    });

  program.addCommand(
    new Command(SUPERVISE_COMMAND)
      .description("run a detached task (internal)")
      .argument("<runId>")
      .requiredOption("--run-dir <dir>")
      .action(async (runId: string, opts: { runDir: string }) => {
        const env = deps.env;
        try {
          await superviseRun(
            {
              build: async (payload) => {
                const ctx = loadAppContext({
                  cwd: payload.repoPath,
                  env,
                  ...(payload.provider === undefined ? {} : { provider: payload.provider }),
                  ...(deps.clock ? { clock: deps.clock } : {}),
                  ...(deps.spawner ? { spawner: deps.spawner } : {}),
                  ...(deps.quotaReaders ? { quotaReaders: deps.quotaReaders } : {}),
                });
                return { ...runnerDeps(ctx, deps.runner), close: () => ctx.close() };
              },
            },
            runId,
            opts.runDir,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          io.err(`dispatch: supervisor: ${message}\n`);
          await withStore(deps, async (_w, store) => {
            if ((await store.getRun(runId))?.status !== "running") return;
            const why = `dispatch could not run the task: ${message}`;
            await recordSupervisorFailure(store, runId, opts.runDir, why);
          });
        }
      }),
    { hidden: true },
  );
}
