/**
 * `dispatch apply <runId>` (UC2, Claude hard mode for custom agents): applies the patch of a run
 * that the Dispatch relay started from a handoff, so the caller receives modified files as with a
 * native sub-agent. A deliberate, narrow exception to "Dispatch never applies patches": only for
 * handoff runs with `autoApply`, a successful outcome, a patch that applies, no review flag and no
 * dropped paths, in the repo the run started from. `git apply` touches the working tree only (no
 * index, no commit). Every refusal changes nothing and exits 3 with the reason.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { readHandoffRun, writeHandoffRun } from "../../app/handoff.js";
import { dispatchHome, globalConfigPath, parseYaml } from "../../config/index.js";
import { GlobalConfigFileSchema } from "../../config/schema.js";
import { systemClock } from "../../core/clock.js";
import { ExitCode, type RunResult } from "../../core/contracts.js";
import { applyCheck } from "../../sandbox/applycheck.js";
import { gitRaw, repoRoot } from "../../sandbox/git.js";
import { SqliteStateStore } from "../../state/store.js";
import { ExitRequest } from "../exit.js";
import { type CliDeps, printJson } from "./shared.js";

/** The answer of `apply`. */
export type ApplyReport =
  | { runId: string; applied: true; patch: string; diffstat: string }
  | { runId: string; applied: false; reason: string };

/** `hosts.claude-code.auto_apply` of the global file; false only when set to false. */
function autoApplyAllowed(env: CliDeps["env"]): boolean {
  const path = globalConfigPath(env);
  if (!existsSync(path)) return true;
  try {
    const g = parseYaml(readFileSync(path, "utf8"), path, GlobalConfigFileSchema);
    return g.hosts?.["claude-code"]?.auto_apply !== false;
  } catch {
    return false; // an unreadable global config never loosens anything
  }
}

/** Why the result of a run cannot be applied; null when it can. */
export function refusal(r: RunResult | null): string | null {
  if (r === null) return "the run has no result yet";
  if (r.status !== "completed" || r.outcome !== "success") {
    return `the run did not succeed (${r.status}${r.outcome ? `, ${r.outcome}` : ""})`;
  }
  const p = r.patch;
  if (p === null || p.diffstat.trim() === "") return "the run produced no patch";
  if (p.needsReview) return "the patch needs review (secret scan hit or dirty base)";
  if (p.rejectedPaths.length > 0) return `the run dropped paths: ${p.rejectedPaths.join(", ")}`;
  if (!p.applies) return "the patch did not apply cleanly when the run ended";
  return null;
}

/** Applies the patch of handoff run `runId` in the repo of `cwd`, or says why not. */
export async function applyRun(deps: CliDeps, runId: string): Promise<ApplyReport> {
  const home = dispatchHome(deps.env);
  const no = (reason: string): ApplyReport => ({ runId, applied: false, reason });
  const rec = readHandoffRun(home, runId);
  if (rec === null) return no("not a run started from a Dispatch handoff");
  if (!rec.autoApply || !autoApplyAllowed(deps.env)) {
    return no("auto-apply is off (hosts.claude-code.auto_apply)");
  }
  if (rec.appliedAt !== null) return no(`already applied at ${rec.appliedAt}`);
  const root = await repoRoot(deps.cwd).catch(() => null);
  if (root !== rec.repoRoot) return no(`run from another repository (${rec.repoRoot})`);
  const clock = deps.clock ?? systemClock;
  const store = SqliteStateStore.open(join(home, "state", "dispatch.db"), { clock });
  let result: RunResult | null;
  try {
    result = (await store.getRun(runId))?.result ?? null;
  } finally {
    store.close();
  }
  const why = refusal(result);
  if (why !== null) return no(why);
  const patch = (result as RunResult).patch as NonNullable<RunResult["patch"]>;
  if (!existsSync(patch.path)) return no(`the patch file is gone: ${patch.path}`);
  const check = await applyCheck(root, patch.path);
  if (!check.applies) return no(`the patch no longer applies: ${check.conflict ?? "conflict"}`);
  const r = await gitRaw(root, ["apply", "--binary", "--whitespace=nowarn", patch.path]);
  if (r.code !== 0) return no(`git apply failed: ${(r.stderr || r.stdout).trim()}`);
  writeHandoffRun(home, { ...rec, appliedAt: clock.now().toISOString() });
  return { runId, applied: true, patch: patch.path, diffstat: patch.diffstat };
}

/** Registers `apply`. */
export function registerApply(program: Command, deps: CliDeps): void {
  program
    .command("apply")
    .description(
      "apply the clean patch of a run started for an intercepted Claude Code custom agent",
    )
    .argument("<runId>", "id printed by `run --detach --handoff`")
    .option("--json", "machine-readable output")
    .action(async (runId: string, opts: { json?: boolean }) => {
      const report = await applyRun(deps, runId);
      if (opts.json) printJson(deps.io, report);
      else if (report.applied) {
        deps.io.out(`Applied ${report.patch}\n${report.diffstat.trimEnd()}\n`);
      } else deps.io.out(`Not applied: ${report.reason}\n`);
      if (!report.applied) throw new ExitRequest(ExitCode.REJECTED);
    });
}
