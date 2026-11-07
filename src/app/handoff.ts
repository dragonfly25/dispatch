/**
 * Runs started from a Claude hard-mode handoff (`dispatch run --handoff <id>`, UC2): the task
 * built from the handoff, the per-run record that `dispatch apply` checks, and the passthrough
 * written when the run hands the task back.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { browserNote, type LaunchConfig, readLaunchConfigs } from "../browser/note.js";
import type { RunResult, Task } from "../core/contracts.js";
import { addPassthrough, type Handoff } from "../hosts/claude-code/handoff.js";
import type { DetachHandoff } from "../runner/detach.js";
import { type AppContext, buildTask } from "./context.js";

/** Directory of per-run handoff records inside the Dispatch home. */
export const HANDOFF_RUNS_DIR = "handoff-runs";

/** What `apply` needs to know about a run started from a handoff. */
export interface HandoffRun {
  version: 1;
  runId: string;
  /** Repository the run was started in (the patch is applied there only). */
  repoRoot: string;
  agent: string;
  autoApply: boolean;
  createdAt: string;
  /** Set once `dispatch apply` applied the patch. */
  appliedAt: string | null;
}

/** Where the agent file is, for the task text: repo-relative or `~`-relative when possible. */
function shownPath(h: Handoff, repoRoot: string, home: string | undefined): string {
  const p = h.agent.path;
  if (h.agent.source === "project" && p.startsWith(`${repoRoot}/`)) return relative(repoRoot, p);
  return home && p.startsWith(`${home}/`) ? `~/${relative(home, p)}` : p;
}

/**
 * The prompt of a handoff run: the agent's instructions, then (for a browser agent) the
 * {@link browserNote} built from `launch` (the repo's `.claude/launch.json`), then the task.
 */
export function handoffPromptText(
  h: Handoff,
  repoRoot: string,
  home?: string,
  launch: readonly LaunchConfig[] = [],
): string {
  const parts = [
    `The task below was given to the "${h.agent.name}" sub-agent of the user's Claude Code ` +
      "setup. Act as that agent: follow its instructions, then do the task.",
  ];
  if (h.instructions.trim() !== "") {
    parts.push(
      `## Agent instructions (from ${shownPath(h, repoRoot, home)})`,
      h.instructions.trim(),
    );
  }
  if (h.browser === true) parts.push(browserNote(launch));
  parts.push("## Task", h.task.trim());
  return parts.join("\n\n");
}

/**
 * The task of a handoff: model, effort and autonomy are requests (the router still applies the
 * reverse model table, the autonomy ceilings and every other security key).
 */
export function handoffTask(ctx: AppContext, h: Handoff, repoRoot: string): Task {
  return buildTask(ctx, {
    task: handoffPromptText(
      h,
      repoRoot,
      ctx.env.HOME,
      h.browser === true ? readLaunchConfigs(repoRoot) : [],
    ),
    ...(h.model === null ? {} : { model: h.model }),
    ...(h.effort === null || !ctx.config.routing.efforts.includes(h.effort)
      ? {}
      : { effort: h.effort }),
    autonomy: h.autonomy,
  });
}

/** The handoff facts that travel with a detached run. */
export function detachHandoff(h: Handoff): DetachHandoff {
  return {
    agent: h.agent.name,
    passthroughKey: h.passthroughKey,
    autoApply: h.autoApply,
    mcpServers: [...h.mcpServers],
    web: h.web,
    ...(h.webFetch === undefined ? {} : { webFetch: h.webFetch }),
    ...(h.browser === true ? { browser: true } : {}),
  };
}

const RUN_ID = /^[A-Za-z0-9_-]{1,100}$/;

function recordPath(dispatchHome: string, runId: string): string {
  if (!RUN_ID.test(runId)) throw new Error(`not a run id: ${runId.slice(0, 100)}`);
  return join(dispatchHome, HANDOFF_RUNS_DIR, `${runId}.json`);
}

/** Writes (or replaces) the record of a handoff run, atomically with mode 0600. */
export function writeHandoffRun(dispatchHome: string, rec: HandoffRun): void {
  const path = recordPath(dispatchHome, rec.runId);
  mkdirSync(join(dispatchHome, HANDOFF_RUNS_DIR), { recursive: true, mode: 0o700 });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(rec)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** The record of `runId`; null when it is missing, not a plain file of this user, or malformed. */
export function readHandoffRun(dispatchHome: string, runId: string): HandoffRun | null {
  try {
    const path = recordPath(dispatchHome, runId);
    const st = lstatSync(path);
    const uid = process.getuid?.();
    if (!st.isFile() || (uid !== undefined && st.uid !== uid) || (st.mode & 0o077) !== 0) {
      return null;
    }
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<HandoffRun>;
    if (
      v.version !== 1 ||
      v.runId !== runId ||
      typeof v.repoRoot !== "string" ||
      typeof v.agent !== "string" ||
      typeof v.autoApply !== "boolean" ||
      typeof v.createdAt !== "string" ||
      (v.appliedAt !== null && typeof v.appliedAt !== "string")
    ) {
      return null;
    }
    return v as HandoffRun;
  } catch {
    return null;
  }
}

/** True when a run did not do the task (the caller should do it itself). */
export function handedBack(r: Pick<RunResult, "status" | "outcome">): boolean {
  return !(r.status === "completed" && r.outcome === "success") && r.status !== "running";
}

/**
 * After a handoff run: when it handed the task back (returned to host, rejected, failed, quota,
 * timeout), lets the caller's identical retry through to Claude once (passthrough).
 */
export function finishHandoffRun(
  dispatchHome: string,
  h: Pick<DetachHandoff, "passthroughKey">,
  result: Pick<RunResult, "status" | "outcome">,
  nowMs: number,
): void {
  if (handedBack(result)) addPassthrough(dispatchHome, h.passthroughKey, nowMs);
}

/** Removes handoff-run records older than `olderThanMs`; returns their run ids. */
export function gcHandoffRuns(
  dispatchHome: string,
  nowMs: number,
  olderThanMs: number,
  dryRun: boolean,
): string[] {
  const dir = join(dispatchHome, HANDOFF_RUNS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const gone: string[] = [];
  for (const n of names) {
    const path = join(dir, n);
    try {
      if (nowMs - lstatSync(path).mtimeMs <= olderThanMs) continue;
      if (!dryRun) rmSync(path, { force: true });
      gone.push(n.replace(/\.json$/, ""));
    } catch {
      // vanished meanwhile
    }
  }
  return gone;
}
