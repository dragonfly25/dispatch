/**
 * WP27 end to end [UC3]: the Codex PreToolUse hook denies a V2 spawn; the commands its reason
 * prescribes (`run --detach --json --task '…'`, then `wait <runId> --json --timeout 280`) are run exactly
 * as a model would, through `/bin/sh -c` and the real launcher script, against the bundled CLI and
 * a fake codex provider. No real CLI is involved.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ExitCode, type HookInput, type RunResult } from "../../../src/core/contracts.js";
import { writeHookCache } from "../../../src/hook/cache.js";
import { preToolUseResponse } from "../../../src/hosts/codex/hook.js";
import { renderLauncherScript } from "../../../src/platform/launcher.js";
import { bundleHelper } from "../../helpers/bundle.js";
import {
  createFakes,
  type FakesContext,
  snapshotTree,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../../support/index.js";

let bundle: { dir: string; file: string };
beforeAll(async () => {
  bundle = await bundleHelper("dispatch-cli", {
    parent: resolve("node_modules", ".cache"),
    external: true,
  });
}, 120_000);
afterAll(() => rmSync(bundle.dir, { recursive: true, force: true }));

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
afterEach(() => {
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = undefined;
});

const GLOBAL = `version: 1
profile: t
quota:
  readers:
    claude: { enabled: false }
    codex: { enabled: false }
`;
const PROFILE = `version: 1
rules:
  - id: all
    action: { type: provider, instance: codex }
`;

/** Pulls the backquoted command that starts with the launcher and `sub` out of the reason. */
function command(reason: string, launcher: string, sub: string): string {
  const start = reason.indexOf(`\`${launcher} ${sub} `);
  expect(start).toBeGreaterThanOrEqual(0);
  return reason.slice(start + 1, reason.indexOf("`", start + 1));
}

describe("codex deny_redirect → run --detach → wait [UC3]", () => {
  it("the redirect's commands, run verbatim, deliver the final result", async () => {
    fakes = createFakes({
      codex: [{ scenario: "success_edit", file: "math.js", content: "export const x = 1;\n" }],
    });
    home = tempHome();
    repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
    const dh = home.dispatchHome;
    mkdirSync(join(dh, "profiles"), { recursive: true });
    mkdirSync(join(dh, "bin"));
    writeFileSync(join(dh, "config.yaml"), GLOBAL);
    writeFileSync(join(dh, "profiles", "t.yaml"), PROFILE);
    const launcher = join(dh, "bin", "dispatch");
    writeFileSync(
      launcher,
      renderLauncherScript({ nodePath: process.execPath, cliPath: bundle.file }),
      { mode: 0o755 },
    );
    writeHookCache(dh, {
      version: 1,
      writtenAt: "2026-11-07T00:00:00.000Z",
      trustedRepos: [{ root: repo.dir, policyHash: null }],
      policy: { profile: "t", hardMode: true, hardInterception: true, summary: "all → codex" },
    });

    // 1. Codex asks the hook about the V2 spawn (recorded fixture, cwd re-pointed).
    const fixture = JSON.parse(
      readFileSync(
        resolve(
          import.meta.dirname,
          "../../fixtures/codex/0.167.0/hook_pre_tool_use_spawn_agent_v2.json",
        ),
        "utf8",
      ),
    ) as HookInput;
    const res = preToolUseResponse({ ...fixture, cwd: repo.dir }, { DISPATCH_HOME: dh });
    const reason = JSON.parse(res.stdout ?? "{}").hookSpecificOutput
      .permissionDecisionReason as string;

    // 2. The model restates the task and runs the prescribed command shapes.
    const env = { ...fakes.env, ...home.env };
    const sh = (script: string) =>
      spawnSync("/bin/sh", ["-c", script], { cwd: repo?.dir, env, encoding: "utf8" });
    const before = snapshotTree(repo.dir);
    const runCmd = command(reason, launcher, "run").replace(
      "<the sub-agent task, in your own words>",
      "add a sub function to math.js",
    );
    expect(runCmd).toBe(`${launcher} run --detach --json --task 'add a sub function to math.js'`);
    const started = sh(runCmd);
    expect(started.status).toBe(ExitCode.OK);
    const { runId } = JSON.parse(started.stdout) as { runId: string };
    expect(runId).toMatch(/\S/);

    const waitCmd = command(reason, launcher, "wait").replace("<runId>", runId);
    expect(waitCmd).toBe(`${launcher} wait ${runId} --json --timeout 280`);
    let waited = sh(waitCmd);
    for (let i = 0; waited.status === ExitCode.STILL_RUNNING && i < 5; i++) {
      waited = sh(waitCmd);
    }
    expect(waited.status).toBe(ExitCode.OK);
    const result = JSON.parse(waited.stdout) as RunResult;
    expect(result).toMatchObject({ runId, status: "completed", outcome: "success" });
    expect(result.externalAgent?.instance).toBe("codex");
    // Dispatch never applies the patch: the repo is untouched.
    expect(snapshotTree(repo.dir)).toEqual(before);
  }, 120_000);
});
