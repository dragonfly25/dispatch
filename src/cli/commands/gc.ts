/**
 * `dispatch gc`: reclaims what finished runs left behind. Worktrees of terminal runs older than
 * `--older-than`, history older than the configured retention, and leases whose process is gone.
 * Worktrees of runs that are still running are never touched.
 */
import type { Command } from "commander";
import type { AppContext } from "../../app/context.js";
import { WorktreeSandbox } from "../../sandbox/worktree.js";
import { LEASE_STALE_MS, type LeaseRecord, type PruneCounts } from "../../state/store.js";
import { formatLocal, parseDuration } from "../time.js";
import { type CliDeps, pidAlive, printJson, withContext } from "./shared.js";

const DEFAULT_OLDER_THAN = "24h";

/** What `gc` removed (or, with `dryRun`, would remove). */
export interface GcReport {
  dryRun: boolean;
  olderThanMs: number;
  retentionDays: number;
  worktrees: string[];
  leases: Pick<LeaseRecord, "runId" | "instanceId" | "pid" | "heartbeatAt">[];
  /** Rows deleted per table; null for a dry run (the store has no counting mode). */
  pruned: PruneCounts | null;
}

/** Runs the collection. */
export async function runGc(
  ctx: AppContext,
  opts: { olderThanMs: number; dryRun: boolean },
  isAlive: (pid: number) => boolean,
): Promise<GcReport> {
  const now = ctx.clock.now();
  const store = ctx.store;
  const retentionDays = ctx.config.execution.retentionDays;

  // Unknown runs (no record) count as terminal: nothing can be running behind them.
  const terminal = new Map<string, boolean>();
  for (const r of store.listRuns({ limit: 100_000 })) terminal.set(r.runId, r.status !== "running");
  const worktrees = await new WorktreeSandbox().gc({
    dispatchHome: ctx.dispatchHome,
    isTerminal: (runId) => terminal.get(runId) ?? true,
    olderThanMs: opts.olderThanMs,
    now: now.getTime(),
    dryRun: opts.dryRun,
  });

  const live = (l: LeaseRecord): boolean =>
    now.getTime() - Date.parse(l.heartbeatAt) <= LEASE_STALE_MS && isAlive(l.pid);
  const dead = opts.dryRun
    ? store.listLeases().filter((l) => !live(l))
    : store.reapStaleLeases(now, (pid) => isAlive(pid));
  const pruned = opts.dryRun ? null : store.prune({ olderThanDays: retentionDays, now });

  return {
    dryRun: opts.dryRun,
    olderThanMs: opts.olderThanMs,
    retentionDays,
    worktrees,
    leases: dead.map(({ runId, instanceId, pid, heartbeatAt }) => ({
      runId,
      instanceId,
      pid,
      heartbeatAt,
    })),
    pruned,
  };
}

/** Text form of a {@link GcReport}. */
export function renderGc(r: GcReport): string {
  const verb = r.dryRun ? "Would remove" : "Removed";
  const lines = [
    `${verb} ${r.worktrees.length} worktree(s)${r.worktrees.length > 0 ? ":" : ""}`,
    ...r.worktrees.map((p) => `  ${p}`),
    `${r.dryRun ? "Would reap" : "Reaped"} ${r.leases.length} stale lease(s)${r.leases.length > 0 ? ":" : ""}`,
    ...r.leases.map(
      (l) =>
        `  run ${l.runId} on ${l.instanceId} (pid ${l.pid}, last heartbeat ${formatLocal(l.heartbeatAt)})`,
    ),
  ];
  if (r.pruned === null) {
    lines.push(
      `Would prune history older than ${r.retentionDays} day(s) (not counted in a dry run)`,
    );
  } else {
    const rows = Object.entries(r.pruned).filter(([, n]) => n > 0);
    lines.push(
      rows.length === 0
        ? `Pruned nothing older than ${r.retentionDays} day(s)`
        : `Pruned history older than ${r.retentionDays} day(s): ${rows.map(([k, n]) => `${k} ${n}`).join(", ")}`,
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Registers `gc`. */
export function registerGc(program: Command, deps: CliDeps): void {
  program
    .command("gc")
    .description("remove worktrees of finished runs, old history and stale leases")
    .option("--older-than <duration>", "only worktrees at least this old (default 24h)")
    .option("--dry-run", "show what would be removed, remove nothing")
    .option("--json", "machine-readable output")
    .action(async (opts: { olderThan?: string; dryRun?: boolean; json?: boolean }) => {
      const olderThanMs = parseDuration(opts.olderThan ?? DEFAULT_OLDER_THAN, "--older-than");
      await withContext(deps, async (ctx) => {
        const report = await runGc(
          ctx,
          { olderThanMs, dryRun: opts.dryRun === true },
          deps.isAlive ?? pidAlive,
        );
        if (opts.json) printJson(deps.io, report);
        else deps.io.out(renderGc(report));
      });
    });
}
