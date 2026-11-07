/**
 * [UC13] Timeout and a patch that does not apply (spec §11 UC13). Verifica: worktrees are kept
 * only when configured; the working copy is never modified.
 *
 * - A task that exceeds its timeout comes back with outcome `timeout` and the partial patch.
 * - A patch that no longer applies to the current tree comes back `failed` with the conflict.
 *
 * Lower-level proofs: test/unit/runner-orchestrate.test.ts ([UC13] x3), runner-proc.test.ts
 * (process-group kill, hang_ignore_term), sandbox*.test.ts, cli-gc.test.ts.
 */
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_QUOTA_UNREAD,
  createWorld,
  HELP,
  MATH_JS,
  snapshotTree,
  THREE_PROVIDERS,
  useBundles,
  type World,
} from "./harness.js";

useBundles();

/** Linked worktrees of the repo (the main one is not counted). */
const worktreeCount = (w: World): number => w.repo.git("worktree", "list").split("\n").length - 1;

describe("[UC13] timeout and a patch that does not apply", () => {
  it("[UC13] a task over its timeout returns outcome timeout with the partial patch", () => {
    const w = createWorld({
      global: THREE_PROVIDERS,
      // The fake agent writes a file in its worktree, then hangs past the timeout.
      scenarios: {
        codex: [{ scenario: "recurse", command: "echo half done > partial.txt; sleep 60" }],
      },
    });
    const before = snapshotTree(w.repo.dir);
    const started = Date.now();
    const r = w.run(["--timeout", "3"]);
    expect(Date.now() - started).toBeLessThan(40_000); // the 60 s sleep was cut at the timeout
    expect(r.code, r.stderr).toBe(6);
    expect(r.result).toMatchObject({ status: "completed", outcome: "timeout" });
    expect(r.result?.patch?.diffstat).toContain("partial.txt");
    expect(readFileSync(r.result?.patch?.path ?? "", "utf8")).toContain("+half done");
    // Nothing was applied, and the worktree is gone (keep is off by default).
    expect(snapshotTree(w.repo.dir)).toEqual(before);
    expect(existsSync(join(w.repo.dir, "partial.txt"))).toBe(false);
    expect(worktreeCount(w)).toBe(0);
    // The log is there for the orchestrator.
    expect(existsSync(r.result?.log?.path ?? "")).toBe(true);
  });

  it("[UC13] a timeout with no work at all goes back to the host", () => {
    const w = createWorld({
      global: `${THREE_PROVIDERS}allowed_providers: [codex]\n`,
      scenarios: { codex: [{ scenario: "slow", delayMs: 20_000 }] },
    });
    const r = w.run(["--timeout", "2"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ status: "returned_to_host", outcome: "timeout" });
    expect(worktreeCount(w)).toBe(0);
  });

  it("[UC13] a patch that does not apply is failed with the conflict; the working copy is untouched", () => {
    const w = createWorld({ global: THREE_PROVIDERS });
    // While the agent works in its worktree, the user edits the same file in the working copy.
    const userEdit = "// edited by the user meanwhile\n";
    const mine = join(w.repo.dir, "math.js");
    w.fakes.setScenarios({
      ...HELP,
      codex: [
        {
          scenario: "recurse",
          command: `printf 'agent version\\n' > math.js; printf '${userEdit.trim()}\\n' > '${mine}'`,
        },
      ],
    });

    const r = w.run();
    expect(r.code, r.stderr).toBe(4);
    expect(r.result).toMatchObject({ status: "completed", outcome: "failed" });
    expect(r.result?.patch?.applies).toBe(false);
    expect(r.result?.summary).toContain("patch does not apply");
    expect(r.result?.summary).toContain("math.js");
    // The conflicting diff is attached so the orchestrator can resolve it by hand.
    expect(readFileSync(r.result?.patch?.path ?? "", "utf8")).toContain("+agent version");

    // Dispatch left the working copy exactly as the user's edit made it.
    expect(readFileSync(mine, "utf8")).toBe(userEdit);
    expect(w.repo.git("status", "--porcelain")).toBe("M math.js");
    expect(worktreeCount(w)).toBe(0);
  });

  it("[UC13] worktrees are kept only when configured, and gc removes them", () => {
    const edit = { scenario: "success_edit" as const, file: "math.js", content: "x\n" };
    const keep = createWorld({
      global: `${THREE_PROVIDERS}worktree: { keep: true }\n`,
      scenarios: { codex: [edit], ...CLAUDE_QUOTA_UNREAD },
    });
    const kept = keep.run();
    expect(kept.result?.status).toBe("completed");
    expect(worktreeCount(keep)).toBe(1);
    expect(keep.repo.git("worktree", "list")).toContain(join(keep.home.dispatchHome, "worktrees"));
    // Even a kept worktree never touches the working copy.
    expect(readFileSync(join(keep.repo.dir, "math.js"), "utf8")).toBe(MATH_JS);
    expect(keep.repo.git("status", "--porcelain")).toBe("");

    const dropped = createWorld({
      global: THREE_PROVIDERS,
      scenarios: { codex: [edit], ...CLAUDE_QUOTA_UNREAD },
    });
    expect(dropped.run().result?.status).toBe("completed");
    expect(worktreeCount(dropped)).toBe(0);
    // gc removes a kept worktree of a finished run once it is old enough (and not before).
    const path = keep.repo
      .git("worktree", "list", "--porcelain")
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length))
      .find((p) => p.startsWith(keep.home.dispatchHome));
    expect(path).toBeDefined();
    expect(keep.dispatch(["gc"]).stdout).toContain("Removed 0 worktree(s)");
    expect(worktreeCount(keep)).toBe(1);
    const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000);
    utimesSync(path ?? "", threeDaysAgo, threeDaysAgo);
    const gc = keep.dispatch(["gc"]);
    expect(gc.code, gc.stderr).toBe(0);
    expect(gc.stdout).toContain("Removed 1 worktree(s)");
    expect(worktreeCount(keep)).toBe(0);
    expect(keep.repo.git("status", "--porcelain")).toBe("");
  });
});
