/**
 * `dispatch logs`: recent runs, or one run's decisions and events as stored (already redacted).
 * `--follow` tails the events of running runs by polling the store (replaces `watch`, spec §10).
 */
import type { Command } from "commander";
import type { AppContext } from "../../app/context.js";
import {
  type DecisionRecord,
  ExitCode,
  type NormalizedEvent,
  type RunRecord,
} from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import type { RunResultWithNetwork } from "../../runner/orchestrate.js";
import { describeNetwork } from "../../sandbox/network.js";
import { formatLocal, formatLocalTime, formatSpan } from "../time.js";
import { type CliDeps, printJson, realSleep, withContext } from "./shared.js";

const usage = (message: string) => new DispatchError(message, ExitCode.USAGE, "cli.usage");

/** Poll interval of `--follow`. */
export const FOLLOW_INTERVAL_MS = 500;
const EPOCH = "1970-01-01T00:00:00.000Z";
const SUMMARY_MAX = 300;

/** One line of the run list. */
export interface RunRow {
  runId: string;
  createdAt: string;
  status: RunRecord["status"];
  instance: string | null;
  /** The outcome, or the status while the run has none yet. */
  outcome: string;
  durationMs: number | null;
  /** Whether the produced patch applies to the working tree; null without a patch. */
  patchApplies: boolean | null;
}

function toRow(r: RunRecord): RunRow {
  return {
    runId: r.runId,
    createdAt: r.createdAt,
    status: r.status,
    instance: r.instance,
    outcome: r.result?.outcome ?? r.status,
    durationMs: r.result && r.status !== "running" ? r.result.durationMs : null,
    patchApplies: r.result?.patch ? r.result.patch.applies : null,
  };
}

/** The most recent runs, newest first. */
export function listRunRows(ctx: AppContext, limit: number): RunRow[] {
  return ctx.store.listRuns({ limit }).map(toRow);
}

/** Everything stored about one run. */
export interface RunDetail {
  run: RunRecord;
  decisions: DecisionRecord[];
  events: NormalizedEvent[];
}

/** @throws DispatchError (exit 2) when the run does not exist. */
export async function runDetail(ctx: AppContext, runId: string): Promise<RunDetail> {
  const run = await ctx.store.getRun(runId);
  if (!run) throw usage(`no such run: ${runId} (see \`dispatch logs\` for recent runs)`);
  const decisions = (await ctx.store.listDecisions(EPOCH)).filter((d) => d.runId === runId);
  return { run, decisions, events: ctx.store.listEvents(runId) };
}

const yesNo = (v: boolean | null): string => (v === null ? "-" : v ? "yes" : "no");

function renderRows(rows: readonly RunRow[]): string {
  if (rows.length === 0) return "no recorded runs\n";
  const head = ["run", "started", "instance", "outcome", "duration", "patch applies"];
  const body = rows.map((r) => [
    r.runId,
    formatLocal(r.createdAt),
    r.instance ?? "-",
    r.outcome,
    r.durationMs === null ? "-" : formatSpan(r.durationMs),
    yesNo(r.patchApplies),
  ]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => (b[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return `${[line(head), ...body.map(line)].join("\n")}\n`;
}

/** One event as a log line. */
export function renderEvent(e: NormalizedEvent): string {
  const what = [e.kind.padEnd(8), e.path, e.detail].filter((x) => x !== undefined && x !== "");
  return `${formatLocalTime(e.ts)}  ${what.join("  ")}`.trimEnd();
}

function renderDetail(d: RunDetail): string {
  const { run } = d;
  const r: RunResultWithNetwork | null = run.result;
  const lines = [
    `Run ${run.runId}: ${run.status}${r?.outcome ? ` (${r.outcome})` : ""}`,
    `  started ${formatLocal(run.createdAt)}, updated ${formatLocal(run.updatedAt)}`,
    `  instance ${run.instance ?? "-"}${r && run.status !== "running" ? `, duration ${formatSpan(r.durationMs)}` : ""}`,
  ];
  if (r?.sandboxNetwork) lines.push(`  sandbox network ${describeNetwork(r.sandboxNetwork)}`);
  if (r?.patch) {
    lines.push(
      `  patch ${r.patch.path} (applies: ${yesNo(r.patch.applies)}${r.patch.needsReview ? ", needs review" : ""})`,
    );
  }
  if (r?.summary) {
    const text = r.summary.length > SUMMARY_MAX ? `${r.summary.slice(0, SUMMARY_MAX)}…` : r.summary;
    lines.push(`  summary (untrusted external output): ${text.replace(/\s+/g, " ")}`);
  }
  lines.push("", `Decisions (${d.decisions.length}):`);
  for (const rec of d.decisions) {
    const x = rec.decision;
    const targets = x.targets.map((t) => t.instance).join(", ");
    lines.push(
      `  ${formatLocal(rec.createdAt)}  ${rec.id}  ${x.action}${x.action === "delegate" ? ` ${x.mode} -> ${targets}` : ""}: ${x.reason}`,
    );
  }
  lines.push("", `Events (${d.events.length}):`, ...d.events.map((e) => `  ${renderEvent(e)}`));
  return `${lines.join("\n")}\n`;
}

interface FollowSink {
  event(runId: string, e: NormalizedEvent): void;
  finished(run: RunRecord): void;
}

/**
 * Prints new events of the given run (or of every running run) until none is left running.
 * Polls the store; a run that is already finished prints its stored events once and ends.
 */
export async function follow(
  ctx: AppContext,
  runId: string | undefined,
  sink: FollowSink,
  sleep: (ms: number) => Promise<void>,
): Promise<void> {
  const seen = new Map<string, number>();
  const done = new Set<string>();
  const drain = (id: string) => {
    const events = ctx.store.listEvents(id);
    for (const e of events.slice(seen.get(id) ?? 0)) sink.event(id, e);
    seen.set(id, events.length);
  };
  for (;;) {
    const ids =
      runId !== undefined
        ? [runId]
        : [
            ...new Set([
              ...seen.keys(),
              ...ctx.store.listRuns({ status: "running", limit: 1000 }).map((r) => r.runId),
            ]),
          ];
    let active = 0;
    for (const id of ids) {
      if (done.has(id)) continue;
      drain(id);
      const run = await ctx.store.getRun(id);
      if (run === null) throw usage(`no such run: ${id}`);
      if (run.status === "running") {
        active++;
      } else {
        drain(id); // events appended between the first drain and the status change
        done.add(id);
        sink.finished(run);
      }
    }
    if (active === 0) return;
    await sleep(FOLLOW_INTERVAL_MS);
  }
}

interface LogsOptions {
  task?: string;
  follow?: boolean;
  json?: boolean;
  limit?: string;
}

function parseLimit(text: string | undefined): number {
  if (text === undefined) return 20;
  const n = Number(text);
  if (!Number.isInteger(n) || n <= 0)
    throw usage(`--limit must be a positive integer, got "${text}"`);
  return n;
}

/** Registers `logs`. */
export function registerLogs(program: Command, deps: CliDeps): void {
  program
    .command("logs")
    .description("list recent runs, or show one run's decisions and events; --follow tails them")
    .option("--task <runId>", "show the decisions and events of this run")
    .option("--follow", "keep printing new events until the running run(s) finish")
    .option("--json", "machine-readable output (one JSON object per line with --follow)")
    .option("--limit <n>", "how many runs to list (default 20)")
    .action(async (opts: LogsOptions) => {
      const { io } = deps;
      const limit = parseLimit(opts.limit);
      await withContext(
        deps,
        async (ctx) => {
          if (opts.follow) {
            await follow(
              ctx,
              opts.task,
              {
                event: (runId, e) =>
                  io.out(
                    opts.json
                      ? `${JSON.stringify({ runId, event: e })}\n`
                      : `${runId}  ${renderEvent(e)}\n`,
                  ),
                finished: (run) =>
                  io.out(
                    opts.json
                      ? `${JSON.stringify({ runId: run.runId, finished: toRow(run) })}\n`
                      : `${run.runId}  finished: ${run.result?.outcome ?? run.status}\n`,
                  ),
              },
              deps.sleep ?? realSleep,
            );
            return;
          }
          if (opts.task !== undefined) {
            const detail = await runDetail(ctx, opts.task);
            if (opts.json) printJson(io, detail);
            else io.out(renderDetail(detail));
            return;
          }
          const rows = listRunRows(ctx, limit);
          if (opts.json) printJson(io, rows);
          else io.out(renderRows(rows));
        },
        { readOnly: true },
      );
    });
}
