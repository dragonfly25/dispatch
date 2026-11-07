/**
 * `dispatch status`: what the user sees about quota (spec §8). One row per provider instance with
 * its pool, per-window remaining %, reset, source and reliability; exhaustion (UC4) and broken
 * reading channels (UC11) are called out. `--set` corrects a value by hand, `--compare` aggregates
 * the recorded decisions of every profile (UC8).
 */
import type { Command } from "commander";
import { adapterCapabilities } from "../../app/adapters.js";
import type { AppContext } from "../../app/context.js";
import { ExitCode, type Pool, type QuotaWindow } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { INTERACTIVE_READER_TIMEOUT_MS } from "../../quota/provider.js";
import { compareFromStore, renderCompare } from "../../shadow/index.js";
import { formatLocal, formatRelative, formatWhen, parseDuration } from "../time.js";
import { columns, meter, outUi, plainUi, type Status, type Ui } from "../ui.js";
import { type CliDeps, printJson, reportIssues, withContext } from "./shared.js";

const usage = (message: string) => new DispatchError(message, ExitCode.USAGE, "cli.usage");

/** One quota window as shown. */
export interface StatusWindow {
  kind: string;
  usedPct: number | null;
  remainingPct: number | null;
  resetAt: string | null;
  source: string;
  readAt: string;
  reliability: QuotaWindow["reliability"];
}

/** A reading channel that is failing (UC11). */
export interface ReaderProblem {
  readerId: string;
  channel: string;
  error: string;
  at: string;
}

/** One provider instance as shown. */
export interface StatusRow {
  id: string;
  adapter: string;
  enabled: boolean;
  pool: Pool;
  plan: string | null;
  /**
   * The instance of the calling host. Its interactive usage is visible only through an account-wide
   * reader (`claude-usage`); otherwise Dispatch sees just its own delegated runs.
   */
  host: boolean;
  experimental: boolean;
  windows: StatusWindow[];
  /** Set while a `quota_exhausted` signal is active (UC4). */
  unavailableUntil: string | null;
  lastQuotaError: string | null;
  /** Latest `readAt` among the stale windows: the last time a channel really delivered. */
  lastGoodReading: string | null;
  readerProblems: ReaderProblem[];
}

export interface StatusReport {
  generatedAt: string;
  profile: string;
  repo: { status: string; trusted: boolean };
  host: { client: string | null; self: string | null };
  instances: StatusRow[];
}

function toWindow(w: QuotaWindow): StatusWindow {
  return {
    kind: w.kind,
    usedPct: w.usedPct,
    remainingPct: w.usedPct === null ? null : Math.round((100 - w.usedPct) * 10) / 10,
    resetAt: w.resetAt,
    source: w.source,
    readAt: w.readAt,
    reliability: w.reliability,
  };
}

/**
 * Takes a fresh quota snapshot (re-reading the channels whose cache is cold) and shapes it for
 * display. Disabled instances are listed but never read.
 */
export async function buildStatus(ctx: AppContext): Promise<StatusReport> {
  const all = ctx.config.execution.instances;
  const enabled = all.filter((i) => i.enabled);
  const snap = await ctx.quota.snapshot(enabled, {
    hostInstanceId: ctx.host.self,
    readerTimeoutMs: INTERACTIVE_READER_TIMEOUT_MS,
  });
  const instances = all.map((inst): StatusRow => {
    const q = snap.instances[inst.id];
    const windows = (q?.windows ?? []).map(toWindow);
    const stale = windows.filter((w) => w.reliability === "stale").map((w) => w.readAt);
    return {
      id: inst.id,
      adapter: inst.adapter,
      enabled: inst.enabled,
      pool: inst.pool,
      plan: inst.plan ?? null,
      host: ctx.host.self === inst.id,
      experimental: adapterCapabilities(inst.adapter)?.experimental === true,
      windows,
      unavailableUntil: q?.unavailableUntil ?? null,
      lastQuotaError: q?.lastQuotaError ?? null,
      lastGoodReading: stale.sort().at(-1) ?? null, // ISO strings sort by time
      readerProblems: inst.enabled
        ? ctx.quota
            .readerHealth(inst.id)
            .filter((h) => !h.ok)
            .map((h) => ({
              readerId: h.readerId,
              channel: h.channel,
              error: h.error ?? "unknown error",
              at: h.at,
            }))
        : [],
    };
  });
  const trust = ctx.config.trust.status;
  return {
    generatedAt: snap.takenAt,
    profile: ctx.config.routing.activeProfile,
    repo: { status: trust, trusted: ctx.config.trusted },
    host: { client: ctx.host.detection.host, self: ctx.host.self },
    instances,
  };
}

const REPO_LINE: Record<string, string> = {
  none: "no repo policy",
  trusted: "repo policy trusted",
  untrusted: "repo policy NOT trusted, ignored (run `dispatch trust` to review and accept it)",
  changed: "repo policy changed since it was trusted, ignored (run `dispatch trust`)",
  symlink: "repo policy contains a symlink, ignored",
};

const EXPERIMENTAL_NOTE =
  "experimental and read-only; wrapping agy under a consumer plan is not supported by Google's terms";

/** Presentation options of {@link renderStatus}. */
export interface StatusRenderOptions {
  /** Colors and symbols (default: plain text). */
  ui?: Ui;
  /** Remaining-% thresholds per instance id, for the meter color (default soft 50, hard 20). */
  thresholds?: Readonly<Record<string, { soft: number; hard: number }>>;
}

const METER_WIDTH = 10;
/** Sources that read the whole account (interactive sessions included), not only Dispatch's runs. */
const ACCOUNT_WIDE = /^(claude-usage|codex-app-server|agy-usage|manual)/;
const FALLBACK = { soft: 50, hard: 20 };

/** One aligned row per window: kind, meter, remaining %, reset, reliability, source. */
function windowRows(r: StatusRow, now: Date, opts: StatusRenderOptions): string[][] {
  const ui = opts.ui ?? plainUi;
  const limits = opts.thresholds?.[r.id] ?? FALLBACK;
  return r.windows.map((w) => {
    let bar: string;
    let left: string;
    if (w.remainingPct === null) {
      bar = ui.dim((ui.enabled ? "░" : ".").repeat(METER_WIDTH));
      left = ui.dim("unknown");
    } else {
      const status: Status =
        w.remainingPct < limits.hard ? "fail" : w.remainingPct < limits.soft ? "warn" : "ok";
      bar = ui.tone(status, meter(w.remainingPct, METER_WIDTH, ui.enabled));
      left = ui.tone(status, `${w.remainingPct}% remaining`);
    }
    const reset =
      w.resetAt === null
        ? ui.dim("reset unknown")
        : `resets ${formatRelative(w.resetAt, now)} ${ui.dim(`(${formatLocal(w.resetAt)})`)}`;
    const tag = w.reliability === "real" ? ui.dim("[real]") : ui.yellow(`[${w.reliability}]`);
    return [
      `  ${w.kind}`,
      ui.enabled ? bar : `[${bar}]`,
      left,
      reset,
      tag,
      ui.dim(`source ${w.source}`),
    ];
  });
}

/** `rows`: the instance's window rows, already aligned across every instance. */
function instanceLines(
  r: StatusRow,
  now: Date,
  opts: StatusRenderOptions,
  rows: readonly string[],
): string[] {
  const ui = opts.ui ?? plainUi;
  const head = [
    `${ui.bold(r.id)}  ${ui.dim(`(${r.adapter})`)}`,
    r.enabled ? ui.green("enabled") : ui.dim("disabled"),
    `pool ${r.pool}`,
    ...(r.plan ? [`plan ${r.plan}`] : []),
    ...(r.experimental ? [ui.yellow("experimental")] : []),
  ].join("  ");
  const accountWide = r.windows.some((w) => ACCOUNT_WIDE.test(w.source) && w.usedPct !== null);
  const hostNote = accountWide
    ? "(host — includes interactive usage)"
    : "(host — interactive usage not visible)";
  const lines = [r.host ? `${head}  ${ui.dim(hostNote)}` : head];
  if (!r.enabled) return [...lines, ui.dim("  disabled: not read")];
  if (r.unavailableUntil !== null) {
    lines.push(
      ui.red(
        `  ${ui.enabled ? `${ui.sym.fail} ` : ""}unavailable until ${formatWhen(r.unavailableUntil, now)}${
          r.lastQuotaError ? ` — ${r.lastQuotaError}` : ""
        }`,
      ),
    );
  }
  lines.push(...rows);
  const last = r.lastGoodReading === null ? null : formatLocal(r.lastGoodReading);
  for (const p of r.readerProblems) {
    lines.push(
      ui.yellow(
        last
          ? `  reader ${p.readerId}: stale — last good reading ${last}, channel error: ${p.error}`
          : `  reader ${p.readerId}: no reading — channel error: ${p.error}`,
      ),
    );
  }
  if (last && r.readerProblems.length === 0) {
    lines.push(ui.yellow(`  stale — last good reading ${last}`));
  }
  return lines;
}

/** Text form of a {@link StatusReport}. */
export function renderStatus(report: StatusReport, opts: StatusRenderOptions = {}): string {
  const ui = opts.ui ?? plainUi;
  const now = new Date(report.generatedAt);
  const host = report.host.client
    ? `host ${report.host.client}${report.host.self ? ` (instance ${report.host.self})` : ""}`
    : "no host detected";
  const repo = REPO_LINE[report.repo.status] ?? report.repo.status;
  const lines = [
    `${ui.dim("Profile:")} ${ui.bold(report.profile)}   ${host}`,
    `${ui.dim("Repo:")} ${report.repo.status === "none" || report.repo.trusted ? repo : ui.yellow(repo)}`,
  ];
  for (const r of report.instances.filter((i) => i.enabled && i.experimental)) {
    lines.push(ui.yellow(`Experimental: ${r.id} is enabled — ${EXPERIMENTAL_NOTE}.`));
  }
  // Window rows are aligned across all instances, so the meters line up.
  const perInstance = report.instances.map((r) => (r.enabled ? windowRows(r, now, opts) : []));
  const aligned = columns(perInstance.flat());
  let next = 0;
  report.instances.forEach((r, i) => {
    const count = perInstance[i]?.length ?? 0;
    lines.push("", ...instanceLines(r, now, opts, aligned.slice(next, next + count)));
    next += count;
  });
  return `${lines.join("\n")}\n`;
}

/** Parses `40` / `40%` into a percentage in 0..100. */
export function parsePct(text: string): number {
  const m = /^(\d+(?:\.\d+)?)%?$/.exec(text.trim());
  const pct = m ? Number(m[1]) : Number.NaN;
  if (!(pct >= 0 && pct <= 100)) {
    throw usage(`<pct> must be a percentage between 0 and 100, got "${text}"`);
  }
  return pct;
}

interface StatusOptions {
  json?: boolean;
  set?: string;
  window?: string;
  ttl?: string;
  compare?: boolean;
  since?: string;
}

/**
 * `status --set`: pins the REMAINING percentage (what `status` shows) of one instance until the
 * override expires. Returns what was stored.
 */
export function setStatus(
  ctx: AppContext,
  instanceId: string,
  pctArg: string,
  opts: StatusOptions,
) {
  const known = ctx.config.execution.instances.map((i) => i.id);
  if (!known.includes(instanceId)) {
    throw usage(`unknown instance "${instanceId}" (known: ${known.join(", ")})`);
  }
  const remaining = parsePct(pctArg);
  const record = ctx.quota.setOverride(instanceId, 100 - remaining, {
    ...(opts.window === undefined ? {} : { window: opts.window }),
    ...(opts.ttl === undefined ? {} : { ttlMs: parseDuration(opts.ttl, "--ttl") }),
  });
  return { ...record, remainingPct: remaining };
}

/** Registers `status`. */
export function registerStatus(program: Command, deps: CliDeps): void {
  program
    .command("status")
    .description(
      "show quota per provider instance, with reliability; correct it or compare profiles",
    )
    .argument("[pct]", "with --set: the remaining percentage, e.g. 40 or 40%")
    .option("--json", "machine-readable output")
    .option("--set <instance>", "correct the remaining % of an instance by hand (until it expires)")
    .option("--window <kind>", "with --set: only this window (default: every window)")
    .option("--ttl <duration>", "with --set: how long the correction lasts (default 6h)")
    .option("--compare", "compare what every profile would have done on the recorded decisions")
    .option("--since <duration>", "with --compare: look back this far (default: everything)")
    .action(async (pct: string | undefined, opts: StatusOptions) => {
      const { io } = deps;
      if (opts.set !== undefined && opts.compare) throw usage("use either --set or --compare");
      if (opts.set !== undefined && pct === undefined) {
        throw usage("--set needs a percentage: dispatch status --set <instance> <pct>");
      }
      if (opts.set === undefined && pct !== undefined && !/^\d+(\.\d+)?%?$/.test(pct)) {
        throw usage(
          `status shows quota, not runs: to see a run use \`dispatch logs --task ${pct}\` or \`dispatch wait ${pct}\``,
        );
      }
      if (opts.set === undefined && (pct !== undefined || opts.window || opts.ttl)) {
        throw usage("a percentage, --window and --ttl only make sense with --set");
      }
      if (!opts.compare && opts.since !== undefined) throw usage("--since needs --compare");
      const sinceMs = opts.since === undefined ? undefined : parseDuration(opts.since, "--since");

      const readOnly = opts.set === undefined;
      await withContext(
        deps,
        async (ctx) => {
          reportIssues(io, ctx.config.issues);
          if (opts.set !== undefined) {
            const r = setStatus(ctx, opts.set, pct as string, opts);
            if (opts.json) return printJson(io, r);
            io.out(
              `${r.instanceId}: ${r.remainingPct}% remaining (${r.window === "*" ? "all windows" : `window ${r.window}`}) until ${formatLocal(r.expiresAt)}\n`,
            );
            return;
          }
          if (opts.compare) {
            const since =
              sinceMs === undefined
                ? undefined
                : new Date(ctx.clock.now().getTime() - sinceMs).toISOString();
            const result = await compareFromStore(ctx.store, since === undefined ? {} : { since });
            if (opts.json) printJson(io, result);
            else io.out(renderCompare(result));
            return;
          }
          const report = await buildStatus(ctx);
          if (opts.json) printJson(io, report);
          else {
            const thresholds = Object.fromEntries(
              ctx.config.routing.instances.map((i) => [i.id, i.thresholds]),
            );
            io.out(renderStatus(report, { ui: outUi(io), thresholds }));
          }
        },
        { readOnly },
      );
    });
}
