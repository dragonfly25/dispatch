/**
 * [UC2] Automatic delegation from Claude Code (soft mode, spec §11 UC2). Verifica: the log has the
 * winning rule; `status` shows the consumption estimated on Codex; no `claude -p` call is made.
 *
 * The flow is the one the real host performs: the SessionStart hook injects the policy, then the
 * `dispatch` sub-agent runs the launcher (`run --detach --json`, then `wait`), exactly as its
 * rendered instructions say. The host is Claude Code (CLAUDECODE=1) with the `preserve` profile.
 *
 * Lower-level proofs: test/unit/cli-run.test.ts ([UC2] preserve + codex), test/unit/hosts/
 * claude-code-hook.test.ts, test/unit/runner-detach.test.ts. Real session: docs/manual-tests/UC2.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorld,
  parseJson,
  snapshotTree,
  THREE_PROVIDERS,
  useBundles,
  useClaudePluginShim,
} from "./harness.js";

useBundles();

const AUTH = "export function login(user: string): boolean {\n  return user.length > 0;\n}\n";
const TESTS =
  'import { login } from "./auth";\ntest("login", () => expect(login("a")).toBe(true));\n';

/** The Codex reader is switched off so `status` shows the estimate Dispatch keeps itself. */
const GLOBAL = `${THREE_PROVIDERS}quota:
  readers:
    codex: { enabled: false }
`;

describe("[UC2] automatic delegation from Claude Code", () => {
  it("[UC2] hook injects the preserve policy, the sub-agent delegates a test task to codex", () => {
    const w = createWorld({
      files: { "src/auth.ts": AUTH },
      global: GLOBAL,
      env: { CLAUDECODE: "1" },
      scenarios: {
        codex: [{ scenario: "success_edit", file: "src/auth.test.ts", content: TESTS }],
      },
    });
    useClaudePluginShim(w);
    expect(w.dispatch(["setup", "--yes"]).code).toBe(0);
    expect(w.dispatch(["install", "--yes", "--profile", "preserve"]).code).toBe(0);
    const launcher = join(w.home.dispatchHome, "bin", "dispatch");

    // 1. SessionStart (Claude Code runs the plugin's hook command with a GUI-like environment).
    const plugin = join(w.home.dispatchHome, "hosts", "claude-code", "plugins", "dispatch");
    const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command as string;
    const hook = w.exec(
      "/usr/bin/env",
      ["-i", "PATH=/usr/bin:/bin", `HOME=${w.home.home}`, "/bin/sh", "-c", command],
      {
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: w.repo.dir,
        }),
      },
    );
    expect(hook.code, hook.stderr).toBe(0);
    const context = JSON.parse(hook.stdout).hookSpecificOutput.additionalContext as string;
    expect(context).toContain("profile: preserve");
    expect(context).toContain("delegated to codex");
    expect(context).toContain("dispatch:dispatch");

    // 2. The sub-agent (rendered from assets/hosts) runs exactly this command shape.
    const agent = readFileSync(join(plugin, "agents", "dispatch.md"), "utf8");
    expect(agent).toContain(`${launcher} run --detach --json --task '<task>'`);
    const before = snapshotTree(w.repo.dir);
    const started = w.exec(launcher, [
      "run",
      "--detach",
      "--json",
      "--task",
      "write tests for auth",
      "--task-type",
      "test",
      "--path",
      "src/auth.ts",
    ]);
    expect(started.code, started.stderr).toBe(0);
    const { runId } = parseJson<{ runId: string }>(started);

    // 3. wait until the run is done (exit 75 = still running).
    let waited = w.exec(launcher, ["wait", runId, "--timeout", "100", "--json"]);
    for (let i = 0; waited.code === 75 && i < 30; i++) {
      waited = w.exec(launcher, ["wait", runId, "--timeout", "100", "--json"]);
    }
    expect(waited.code, waited.stderr).toBe(0);
    const result = parseJson<{
      status: string;
      outcome: string;
      externalAgent: { instance: string; marker: string };
      patch: { path: string; applies: boolean; needsReview: boolean };
      decisions: { reason: string; chain: { ruleId: string; matched: boolean }[] }[];
    }>(waited);
    expect(result).toMatchObject({
      status: "completed",
      outcome: "success",
      externalAgent: { instance: "codex", marker: "EXTERNAL_AGENT_OUTPUT" },
      patch: { applies: true, needsReview: false }, // clean tree: nothing to double-check
    });
    expect(readFileSync(result.patch.path, "utf8")).toContain("src/auth.test.ts");
    // Dispatch returned a patch; it applied nothing.
    expect(snapshotTree(w.repo.dir, { exclude: [".git/objects", ".dispatch"] })).toEqual(
      Object.fromEntries(Object.entries(before).filter(([p]) => !p.startsWith(".dispatch"))),
    );
    expect(existsSync(join(w.repo.dir, "src", "auth.test.ts"))).toBe(false);

    // Verifica 1: the log has the winning rule.
    const logs = w.dispatch(["logs", "--task", runId], { env: { CLAUDECODE: "1" } });
    expect(logs.code).toBe(0);
    expect(logs.stdout).toContain("profile preserve rule preserve-delegate-all");
    expect(
      result.decisions[0]?.chain.find((c) => c.matched && c.ruleId.startsWith("preserve"))?.ruleId,
    ).toBe("preserve-delegate-all");

    // Verifica 2: status shows the consumption estimated on codex.
    const status = parseJson<{
      instances: {
        id: string;
        windows: { kind: string; usedPct: number | null; reliability: string; source: string }[];
      }[];
    }>(w.dispatch(["status", "--json"], { env: { CLAUDECODE: "1" } }));
    const codex = status.instances.find((i) => i.id === "codex");
    expect(codex?.windows.length).toBeGreaterThan(0);
    expect(
      codex?.windows.every((x) => x.reliability === "estimated" && x.source === "estimator"),
    ).toBe(true);

    // Verifica 3: no `claude -p` call (the host's own provider is never invoked); only the
    // quota-free `claude -p /usage` read of `status` may run.
    expect(w.fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
    for (const call of w.fakes.readLog({ cli: "claude" }).filter((c) => c.key !== "usage")) {
      expect(call.args).not.toContain("-p");
      expect(call.args).not.toContain("--print");
    }
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toHaveLength(1);
  });

  it("[UC2] a task the policy does not delegate to codex never reaches claude either (host excluded)", () => {
    const w = createWorld({
      global: `${GLOBAL}allowed_providers: [claude]\n`,
      env: { CLAUDECODE: "1" },
      scenarios: { claude: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
    });
    const r = w.run(["--task-type", "test"]);
    expect(r.code).toBe(0);
    expect(r.result?.status).toBe("returned_to_host");
    expect(w.fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
  });
});
