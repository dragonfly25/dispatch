/**
 * `doctor --live`: one minimal real task per provider instance, run through the same
 * `executeTask` path as `dispatch run`, in a throwaway git repository. It spends a small amount
 * of quota, so the command asks first.
 */
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../app/context.js";
import { forceProvider } from "../app/force-provider.js";
import { runnerDeps } from "../app/runner.js";
import type { ExecutionInstance } from "../config/load.js";
import type { Adapter, ProbeResult, RunResult, Task } from "../core/contracts.js";
import { type ResolveFs, resolveBinary } from "../platform/resolve.js";
import { ProbeCache, type SignalTarget } from "../runner/lifecycle.js";
import { executeTask, type RunnerDeps } from "../runner/orchestrate.js";
import { git } from "../sandbox/git.js";
import { type DoctorLine, mkLine } from "./types.js";

/** Marker file the edit task creates. */
export const LIVE_FILE = "DISPATCH_OK";
/** Prompt of the edit task. */
export const LIVE_EDIT_PROMPT = `Create a file named ${LIVE_FILE} containing the word ok`;
/** Prompt of the read-only task (agy). */
export const LIVE_READ_PROMPT = "Reply with the word ok";
/** Per-task timeout. */
export const LIVE_TIMEOUT_MS = 120_000;

/** One instance the live test will exercise. */
export interface LiveTarget {
  instance: ExecutionInstance;
  adapter: Adapter;
  probe: ProbeResult;
  /** True when the instance cannot edit (agy, or an autonomy ceiling of read-only). */
  readOnly: boolean;
}

/** Collaborators of {@link runLive}. */
export interface LiveDeps {
  /** Replaces wired runner dependencies (`CliDeps.runner`, tests). */
  overrides?: Partial<RunnerDeps> | undefined;
  resolveFs?: ResolveFs | undefined;
  signals?: SignalTarget | null | undefined;
}

/** Whether `inst` has to be tested read-only. */
export function needsReadOnly(ctx: AppContext, inst: ExecutionInstance, adapter: Adapter): boolean {
  const canEdit =
    adapter.caps.autonomy.includes("worktree") &&
    inst.maxAutonomy !== "read-only" &&
    ctx.config.routing.maxAutonomy !== "read-only";
  return !canEdit;
}

/** The lines printed before the confirmation: what will run and that it costs quota. */
export function livePlan(targets: readonly LiveTarget[]): string[] {
  return [
    "doctor --live will run one minimal real task per provider; this consumes a small amount of quota:",
    ...targets.map(
      (t) =>
        `  ${t.instance.id}: "${t.readOnly ? LIVE_READ_PROMPT : LIVE_EDIT_PROMPT}" (${t.readOnly ? "read-only" : "worktree"}, tier fast, effort low, timeout ${LIVE_TIMEOUT_MS / 1000} s)`,
    ),
  ];
}

/** Files a patch touches, from its `diff --git` headers. */
export function patchFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)].map((m) => m[2] ?? "");
}

function judge(t: LiveTarget, result: RunResult, patch: string | null): string | null {
  if (result.status !== "completed" || result.outcome !== "success") {
    return `status ${result.status}, outcome ${result.outcome ?? "none"}: ${result.summary.slice(0, 300)}`;
  }
  if (result.externalAgent?.instance !== t.instance.id) {
    return `the task ran on ${result.externalAgent?.instance ?? "no provider"}, not ${t.instance.id}`;
  }
  if (t.readOnly) {
    return /\bok\b/i.test(result.summary)
      ? null
      : `the reply does not contain "ok": ${result.summary.slice(0, 300)}`;
  }
  if (patch === null) return "the run produced no patch";
  const files = patchFiles(patch);
  if (files.length !== 1 || files[0] !== LIVE_FILE) {
    return `expected a patch adding only ${LIVE_FILE}, got: ${files.join(", ") || "nothing"}`;
  }
  const added = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  return added.some((l) => /\bok\b/i.test(l)) ? null : `${LIVE_FILE} does not contain "ok"`;
}

async function makeRepo(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "dispatch-doctor-")));
  await git(dir, ["init", "-q", "-b", "main"]);
  await writeFile(join(dir, "README.md"), "# dispatch doctor\n");
  await git(dir, ["add", "-A"]);
  await git(dir, [
    "-c",
    "user.name=Dispatch Doctor",
    "-c",
    "user.email=doctor@dispatch.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    "init",
  ]);
  return dir;
}

/** Runs the live task for each target, one after the other. */
export async function runLive(
  ctx: AppContext,
  targets: readonly LiveTarget[],
  deps: LiveDeps,
): Promise<DoctorLine[]> {
  const lines: DoctorLine[] = [];
  const repo = await makeRepo();
  const probes = new ProbeCache();
  for (const t of targets) probes.set(t.adapter.caps.id, t.instance.id, t.probe);
  const fs = deps.resolveFs;
  try {
    for (const t of targets) {
      const id = t.instance.id;
      // The same flag-level pin as `run --provider`: it beats any rule of the user's profile.
      const wired = runnerDeps(ctx, {
        config: forceProvider(ctx.config, t.instance.id),
        probes,
        ...(fs
          ? {
              resolveBinary: async (name, instance) =>
                resolveBinary(name, { configured: instance.binary, env: ctx.env, fs })?.path ??
                null,
            }
          : {}),
        ...deps.overrides,
      });
      const task: Task = {
        id: ctx.newId(),
        prompt: t.readOnly ? LIVE_READ_PROMPT : LIVE_EDIT_PROMPT,
        paths: [],
        tier: "fast",
        effort: "low",
        autonomy: t.readOnly ? "read-only" : "worktree",
        timeoutMs: LIVE_TIMEOUT_MS,
      };
      try {
        const result = await executeTask(wired, task, {
          repoPath: repo,
          ...(deps.signals === undefined ? {} : { signals: deps.signals }),
        });
        const patch = result.patch
          ? await readFile(result.patch.path, "utf8").catch(() => null)
          : null;
        const problem = judge(t, result, patch);
        const data = {
          runId: result.runId,
          status: result.status,
          outcome: result.outcome,
          durationMs: result.durationMs,
          log: result.log.path,
        };
        lines.push(
          problem === null
            ? mkLine(
                "ok",
                "live",
                `live.${id}`,
                `${id}: ${t.readOnly ? "replied ok" : `produced a patch adding only ${LIVE_FILE}`} in ${Math.round(result.durationMs / 100) / 10} s`,
                { data },
              )
            : mkLine("fail", "live", `live.${id}`, `${id}: ${problem}`, {
                fix: `see the run log ${result.log.path}`,
                data,
              }),
        );
      } catch (err) {
        lines.push(
          mkLine(
            "fail",
            "live",
            `live.${id}`,
            `${id}: the live task crashed: ${(err as Error).message}`,
          ),
        );
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  return lines;
}
