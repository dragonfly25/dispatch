/**
 * [UC7] Second opinion (spec §11 UC7). Verifica: two worktrees, two logs, no patch applied
 * automatically. A `review` rule fans the task out to `codex` and a second Claude account
 * (`claude-alt`) while the host is Claude Code; the orchestrator receives two results, each tagged
 * with its provider, and nothing is merged or applied.
 *
 * Lower-level proofs: test/unit/runner-multi.test.ts ([UC7] x5), router/decide.test.ts (fanout).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createWorld, snapshotTree, THREE_PROVIDERS, useBundles } from "./harness.js";

useBundles();

const PROFILE = `version: 1
description: Reviews on two accounts.
rules:
  - id: second-opinion
    match: { task_type: [review] }
    action: { type: fanout, instances: [codex, claude-alt] }
  - id: default
    action: { type: fallback, instances: [codex, claude-alt] }
`;

describe("[UC7] second opinion", () => {
  // claude-alt is a claude account, never a target on native Windows (by design); the fanout
  // itself runs there in runner-multi.test.ts with two codex instances.
  it.skipIf(process.platform === "win32")(
    "[UC7] a review runs on two providers in two worktrees and returns two tagged results",
    () => {
      const w = createWorld({
        env: { CLAUDECODE: "1" },
        scenarios: {
          codex: [
            { scenario: "success_edit", file: "review-codex.md", content: "codex: looks fine\n" },
          ],
          claude: [{ scenario: "success_edit", file: "review-alt.md", content: "alt: one nit\n" }],
        },
      });
      w.writeGlobal(
        `${THREE_PROVIDERS}  claude-alt: { adapter: claude, config_dir: ${JSON.stringify(join(w.home.home, ".claude-alt"))}, plan: pro }\nprofile: second-opinion\n`,
      );
      // The rule is a user profile, so the repo is left exactly as it was committed.
      w.writeDispatchFile("profiles/second-opinion.yaml", PROFILE);
      const before = snapshotTree(w.repo.dir);

      const r = w.run(["--task-type", "review", "--autonomy", "worktree"], {
        task: "review math.js",
      });
      expect(r.code, r.stderr).toBe(0);
      const res = r.result;
      expect(res?.status).toBe("completed");
      expect(res?.decisions[0]).toMatchObject({ action: "delegate", mode: "fanout" });
      expect(res?.summary).toContain("2 independent results, nothing merged");

      // Two results, each tagged with the provider it came from.
      const results = res?.results ?? [];
      expect(results.map((x) => x.externalAgent?.instance)).toEqual(["codex", "claude-alt"]);
      expect(results.map((x) => x.externalAgent?.provider)).toEqual(["codex", "claude"]);
      for (const x of results) {
        expect(x.externalAgent?.marker).toBe("EXTERNAL_AGENT_OUTPUT");
        expect(x.status).toBe("completed");
      }
      // Two logs and two patches, all distinct.
      const logs = results.map((x) => x.log?.path);
      const patches = results.map((x) => x.patch?.path);
      expect(new Set(logs).size).toBe(2);
      expect(new Set(patches).size).toBe(2);
      expect(readFileSync(patches[0] ?? "", "utf8")).toContain("review-codex.md");
      expect(readFileSync(patches[1] ?? "", "utf8")).toContain("review-alt.md");
      for (const x of results) expect(x.patch?.applies).toBe(true);

      // Two worktrees, neither the working copy; both gone afterwards (keep is off).
      const cwds = w.fakes.readLog({ kind: "run" }).map((c) => c.cwd);
      expect(cwds).toHaveLength(2);
      expect(new Set(cwds).size).toBe(2);
      for (const cwd of cwds) {
        expect(cwd).not.toBe(w.repo.dir);
        expect(cwd.startsWith(join(w.home.dispatchHome, "worktrees"))).toBe(true);
      }
      expect(w.repo.git("worktree", "list").split("\n")).toHaveLength(1);

      // No patch was applied: the working copy is byte-identical and git sees nothing new.
      expect(snapshotTree(w.repo.dir)).toEqual(before);
      expect(w.repo.git("status", "--porcelain")).toBe("");

      // The text the orchestrator reads names each provider and says Dispatch never applies patches.
      const text = w.dispatch(["run", "--task", "review math.js", "--task-type", "review"]).stdout;
      expect(text).toContain("Provider: codex (instance codex)");
      expect(text).toContain("Provider: claude (instance claude-alt)");
      expect(text).toContain("Dispatch never applies it");
    },
  );
});
