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
import { compareFromStore, renderCompare } from "../../shadow/index.js";
import { formatLocal, formatWhen, parseDuration } from "../time.js";
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
  /** The instance of the calling host: its interactive usage is not visible to Dispatch. */
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
  const snap = await ctx.quota.snapshot(enabled, { hostInstanceId: ctx.host.self });
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

function windowLine(w: StatusWindow, now: Date, kindWidth: number): string {
  const left = w.remainingPct === null ? "unknown" : `${w.remainingPct}% remaining`;
  const reset = w.resetAt === null ? "reset unknown" : `resets ${formatWhen(w.resetAt, now)}`;
  return `  ${w.kind.padEnd(kindWidth)} ${left.padEnd(15)} ${reset}  [${w.reliability}]  source ${w.source}`;
}

function instanceLines(r: StatusRow, now: Date): string[] {
  const head = [
    `${r.id}  (${r.adapter})`,
    r.enabled ? "enabled" : "disabled",
    `pool ${r.pool}`,
    ...(r.plan ? [`plan ${r.plan}`] : []),
    ...(r.experimental ? ["experimental"] : []),
  ].join("  ");
  const lines = [r.host ? `${head}  (host — interactive usage not visible)` : head];
  if (!r.enabled) return [...lines, "  disabled: not read"];
  if (r.unavailableUntil !== null) {
    lines.push(
      `  unavailable until ${formatWhen(r.unavailableUntil, now)}${
        r.lastQuotaError ? ` — ${r.lastQuotaError}` : ""
      }`,
    );
  }
  const kindWidth = Math.max(...r.windows.map((w) => w.kind.length));
  for (const w of r.windows) lines.push(windowLine(w, now, kindWidth));
  const last = r.lastGoodReading === null ? null : formatLocal(r.lastGoodReading);
  for (const p of r.readerProblems) {
    lines.push(
      last
        ? `  reader ${p.readerId}: stale — last good reading ${last}, channel error: ${p.error}`
        : `  reader ${p.readerId}: no reading — channel error: ${p.error}`,
    );
  }
  if (last && r.readerProblems.length === 0) lines.push(`  stale — last good reading ${last}`);
  return lines;
}

/** Text form of a {@link StatusReport}. */
export function renderStatus(report: StatusReport): string {
  const now = new Date(report.generatedAt);
  const host = report.host.client
    ? `host ${report.host.client}${report.host.self ? ` (instance ${report.host.self})` : ""}`
    : "no host detected";
  const lines = [
    `Profile: ${report.profile}   ${host}`,
    `Repo: ${REPO_LINE[report.repo.status] ?? report.repo.status}`,
  ];
  for (const r of report.instances.filter((i) => i.enabled && i.experimental)) {
    lines.push(`Experimental: ${r.id} is enabled — ${EXPERIMENTAL_NOTE}.`);
  }
  for (const r of report.instances) lines.push("", ...instanceLines(r, now));
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
      if (opts.set === undefined && (pct !== undefined || opts.window || opts.ttl)) {
        throw usage("a percentage, --window and --ttl only make sense with --set");
      }
      if (!opts.compare && opts.since !== undefined) throw usage("--since needs --compare");
      const sinceMs = opts.since === undefined ? undefined : parseDuration(opts.since, "--since");

      await withContext(deps, async (ctx) => {
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
        else io.out(renderStatus(report));
      });
    });
}
