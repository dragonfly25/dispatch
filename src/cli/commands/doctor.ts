/** `dispatch doctor [--json] [--live] [--provider <ids>] [--from-host] [--yes]` (UC1, UC11). */
import type { Command } from "commander";
import type { AppContext } from "../../app/context.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { livePlan, runLive } from "../../doctor/live.js";
import { buildReport, renderLines, renderSummary } from "../../doctor/render.js";
import { collectChecks, selectLiveTargets } from "../../doctor/run.js";
import { type DoctorLine, mkLine } from "../../doctor/types.js";
import { builtinRegistry } from "../../hosts/index.js";
import { defaultSetupDeps } from "../setup.js";
import { type CliDeps, printJson } from "./shared.js";

interface DoctorOptions {
  json?: boolean;
  live?: boolean;
  provider?: string;
  fromHost?: boolean;
  yes?: boolean;
}

const usage = (message: string) => new DispatchError(message, ExitCode.USAGE, "cli.usage");

type Collected = Awaited<ReturnType<typeof collectChecks>>;

/** The `--live` part: pick targets, show the plan, confirm, run. `ran` is false when nothing was started. */
async function liveStep(
  deps: CliDeps,
  opts: DoctorOptions,
  ctx: AppContext,
  collected: Collected,
  wanted: string[] | undefined,
): Promise<{ lines: DoctorLine[]; ran: boolean }> {
  const extras = deps.doctor ?? {};
  const { targets, skipped } = selectLiveTargets(ctx, collected.reports, wanted);
  if (targets.length === 0) {
    const none = mkLine(
      "warn",
      "live",
      "live",
      "no provider to test (enable one, or pass --provider)",
    );
    return { lines: [...skipped, none], ran: false };
  }
  // With --json stdout carries only the report, so the plan goes to stderr.
  const say = opts.json ? deps.io.err : deps.io.out;
  say(`\n${livePlan(targets).join("\n")}\n`);
  if (!opts.yes) {
    const ask = extras.ask ?? defaultSetupDeps().ask;
    if (!/^y(es)?$/i.test((await ask("Run it? [y/N] ")).trim())) {
      return {
        lines: [...skipped, mkLine("warn", "live", "live", "cancelled: nothing was run")],
        ran: false,
      };
    }
  }
  const results = await runLive(ctx, targets, {
    overrides: deps.runner,
    resolveFs: extras.resolveFs,
    signals: extras.signals,
  });
  return { lines: [...skipped, ...results], ran: true };
}

/** Registers `doctor`. Exit 0 when nothing failed, 4 otherwise. */
export function registerDoctor(program: Command, deps: CliDeps): void {
  program
    .command("doctor")
    .description("check the installation, the provider CLIs and the quota channels")
    .option("--json", "machine-readable output")
    .option("--live", "also run one minimal real task per provider (uses a little quota)")
    .option("--provider <ids>", "with --live: comma-separated instance ids to test")
    .option("--from-host", "check what a call made from inside Claude Code or Codex needs")
    .option("-y, --yes", "with --live: do not ask for confirmation")
    .action(async (opts: DoctorOptions) => {
      const extras = deps.doctor ?? {};
      if (opts.provider !== undefined && !opts.live) throw usage("--provider needs --live");
      const interactive = extras.interactive ?? process.stdin.isTTY === true;
      if (opts.live && !opts.yes && !interactive) {
        throw usage(
          "doctor --live uses provider quota and needs confirmation; pass --yes to run it non-interactively",
        );
      }
      const wanted = opts.provider
        ?.split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      const collected = await collectChecks({
        cwd: deps.cwd,
        env: deps.env,
        load: {
          ...(deps.clock ? { clock: deps.clock } : {}),
          ...(deps.newId ? { newId: deps.newId } : {}),
          ...(deps.assetsDir ? { assetsDir: deps.assetsDir } : {}),
          ...(deps.spawner ? { spawner: deps.spawner } : {}),
          ...(deps.quotaReaders ? { quotaReaders: deps.quotaReaders } : {}),
          ...(opts.live ? {} : { readOnly: true }),
        },
        registry: extras.registry ?? builtinRegistry(),
        fromHost: opts.fromHost === true,
        resolveFs: extras.resolveFs,
      });
      const { ctx } = collected;
      const lines = [...collected.lines];
      let liveRan = false;
      try {
        if (!opts.json) deps.io.out(`dispatch doctor\n${renderLines(lines)}`);
        if (opts.live) {
          const step = ctx
            ? await liveStep(deps, opts, ctx, collected, wanted)
            : {
                lines: [
                  mkLine("fail", "live", "live", "skipped: the configuration could not be loaded"),
                ],
                ran: false,
              };
          liveRan = step.ran;
          lines.push(...step.lines);
          if (!opts.json) deps.io.out(renderLines(step.lines));
        }
      } finally {
        ctx?.close();
      }
      const report = buildReport(lines, liveRan);
      if (opts.json) printJson(deps.io, report);
      else deps.io.out(renderSummary(lines));
      if (!report.ok) {
        throw new DispatchError(
          `doctor found ${report.summary.fail} failing check(s)`,
          ExitCode.FAILED,
          "doctor.failed",
        );
      }
    });
}
