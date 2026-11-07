/** `dispatch explain`: a dry-run decision, or the replay of a recorded one (UC5, UC6, AC3). */

import type { Command } from "commander";
import { buildTask, type TaskFlags } from "../../app/context.js";
import { dryRun } from "../../app/dry-run.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { renderExplain } from "../../router/index.js";
import { type ReplayResult, replayDecision } from "../../shadow/index.js";
import { addTaskOptions } from "../options.js";
import { type CliDeps, printJson, reportIssues, withContext } from "./shared.js";

interface ExplainOptions extends TaskFlags {
  sessionModel?: string;
  replay?: string;
  withCurrentConfig?: boolean;
  json?: boolean;
}

/** Text of a replay: verdict, the differing fields, then the replayed decision explained. */
function renderReplay(r: ReplayResult): string {
  const lines = [
    `Replay of decision ${r.decisionId} (profile ${r.profile}${r.configSubstituted ? ", current configuration" : ""}): ${
      r.identical ? "IDENTICAL" : `DIFFERS in ${r.diff.length} field(s)`
    }`,
  ];
  for (const d of r.diff) {
    lines.push(`  ${d.field}:`, `    recorded: ${d.recorded}`, `    replayed: ${d.replayed}`);
  }
  return `${lines.join("\n")}\n\n${renderExplain(r.input, r.replayed)}`;
}

/** Registers `explain`. */
export function registerExplain(program: Command, deps: CliDeps): void {
  addTaskOptions(
    program
      .command("explain")
      .description(
        "show the routing decision for a task, with the rule chain (nothing is executed)",
      )
      .option(
        "--session-model <model>",
        "pretend the host session runs this model (matters for unspecified_model: inherit)",
      )
      .option("--replay <decisionId>", "re-run the router on a recorded decision and diff it")
      .option(
        "--with-current-config",
        "with --replay: use today's configuration instead of the recorded one",
      )
      .option("--json", "machine-readable output"),
  ).action(async (opts: ExplainOptions) => {
    const { io } = deps;
    await withContext(
      deps,
      async (ctx) => {
        reportIssues(io, ctx.config.issues);
        if (opts.replay !== undefined) {
          if (opts.task !== undefined || opts.taskFile !== undefined) {
            throw new DispatchError(
              "use either --replay or --task, not both",
              ExitCode.USAGE,
              "cli.usage",
            );
          }
          const result = await replayDecision(ctx.store, opts.replay, {
            ...(opts.withCurrentConfig
              ? { withConfig: ctx.config.routing as unknown as Record<string, unknown> }
              : {}),
          });
          if (opts.json) printJson(io, result);
          else io.out(renderReplay(result));
          return;
        }
        if (opts.withCurrentConfig) {
          throw new DispatchError(
            "--with-current-config needs --replay",
            ExitCode.USAGE,
            "cli.usage",
          );
        }
        const result = await dryRun(ctx, buildTask(ctx, opts), {
          ...(opts.sessionModel
            ? { sessionModel: { value: opts.sessionModel, observed: true } }
            : {}),
        });
        if (opts.json) {
          printJson(io, {
            input: result.input,
            decision: result.decision,
            alternatives: result.alternatives,
            explain: result.explain,
            issues: ctx.config.issues,
          });
        } else io.out(result.explain);
      },
      { readOnly: true },
    );
  });
}
