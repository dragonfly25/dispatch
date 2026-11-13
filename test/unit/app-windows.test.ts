/** Windows rules of the app layer: host matching, handoff prompt paths (injected platform). */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveHost, samePath } from "../../src/app/context.js";
import { HANDOFF_RUNS_DIR, handoffPromptText, readHandoffRun } from "../../src/app/handoff.js";
import type { ProviderInstance } from "../../src/core/contracts.js";
import type { Handoff } from "../../src/hosts/claude-code/handoff.js";

const W = "win32" as const;

describe("samePath / resolveHost on Windows", () => {
  const env = { USERPROFILE: "C:\\Users\\me" };

  it("compares ignoring case and separators, and expands ~\\ against USERPROFILE", () => {
    expect(samePath("C:/Users/ME/.claude-alt/", "c:\\users\\me\\.claude-alt", env, W)).toBe(true);
    expect(samePath("~\\.claude-alt", "C:\\Users\\me\\.claude-alt", env, W)).toBe(true);
    expect(samePath("~/.claude-alt", "C:\\Users\\me\\.claude-other", env, W)).toBe(false);
    expect(samePath("/a/B", "/a/b", {}, "linux")).toBe(false);
  });

  it("maps CLAUDE_CONFIG_DIR to the instance with the same config dir", () => {
    const instances: ProviderInstance[] = [
      { id: "claude", adapter: "claude", pool: "subscription" },
      { id: "alt", adapter: "claude", pool: "subscription", configDir: "~\\.claude-alt" },
    ];
    const hostEnv = { ...env, CLAUDECODE: "1", CLAUDE_CONFIG_DIR: "c:/users/me/.CLAUDE-ALT" };
    expect(resolveHost(hostEnv, instances, W).self).toBe("alt");
    expect(resolveHost(hostEnv, instances, "linux").self).toBe("claude");
  });
});

describe("handoff prompt paths on Windows", () => {
  const h = (source: "project" | "user", path: string): Handoff =>
    ({
      agent: { name: "a", source, path },
      instructions: "i",
      task: "t",
    }) as Handoff;

  it("shows project agents repo-relative and user agents under ~\\", () => {
    expect(
      handoffPromptText(h("project", "c:\\Repo\\.claude\\agents\\a.md"), "C:\\repo", "", [], W),
    ).toContain("(from .claude\\agents\\a.md)");
    expect(
      handoffPromptText(
        h("user", "C:\\Users\\me\\.claude\\agents\\a.md"),
        "C:\\r",
        "c:/users/ME",
        [],
        W,
      ),
    ).toContain("(from ~\\.claude\\agents\\a.md)");
    expect(handoffPromptText(h("user", "D:\\x\\a.md"), "C:\\r", "C:\\Users\\me", [], W)).toContain(
      "(from D:\\x\\a.md)",
    );
  });
});

describe("handoff-run records on Windows", () => {
  it("skips the POSIX mode check but still refuses a symlinked record", () => {
    const home = mkdtempSync(join(tmpdir(), "dispatch-hr-"));
    try {
      const dir = join(home, HANDOFF_RUNS_DIR);
      mkdirSync(dir);
      const rec = {
        version: 1,
        runId: "R1",
        repoRoot: "C:\\r",
        agent: "a",
        autoApply: true,
        createdAt: "x",
        appliedAt: null,
      };
      writeFileSync(join(dir, "real.json"), JSON.stringify({ ...rec, runId: "R2" }), {
        mode: 0o644,
      });
      writeFileSync(join(dir, "R1.json"), JSON.stringify(rec), { mode: 0o644 });
      symlinkSync(join(dir, "real.json"), join(dir, "R2.json"));
      expect(readHandoffRun(home, "R1", W)).toMatchObject({ runId: "R1" });
      expect(readHandoffRun(home, "R2", W)).toBeNull();
      if (process.platform !== "win32") expect(readHandoffRun(home, "R1", "linux")).toBeNull();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
