/**
 * Dry run: routes a task on a fresh quota snapshot without executing, recording or spawning
 * anything. Backs `explain --task` and `run --dry-run`.
 */
import type { Decision, DecisionInput, Task } from "../core/contracts.js";
import { decide, decideForProfiles, renderExplain } from "../router/index.js";
import { type AppContext, buildDecisionInput, type DecisionInputOptions } from "./context.js";

export interface DryRunResult {
  /** The exact input the router saw (what `explain --replay` would re-run). */
  input: DecisionInput;
  decision: Decision;
  /** What every other profile would have decided on the same snapshot, by profile name. */
  alternatives: Record<string, Decision>;
  /** Human-readable rendering (`renderExplain`), including the alternatives. */
  explain: string;
}

/** Runs the router for `task` with the active profile and, for comparison, every other profile. */
export async function dryRun(
  ctx: AppContext,
  task: Task,
  options: DecisionInputOptions = {},
): Promise<DryRunResult> {
  const input = await buildDecisionInput(ctx, task, options);
  const decision = decide(input);
  const { activeProfile, profiles } = ctx.config.routing;
  const others = Object.keys(profiles).filter((name) => name !== activeProfile);
  const alternatives = decideForProfiles(input, others);
  return { input, decision, alternatives, explain: renderExplain(input, decision, alternatives) };
}
