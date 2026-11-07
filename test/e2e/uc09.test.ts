/**
 * [UC9] A collaborator without Dispatch (spec §11 UC9, AC5). Verifica: no error, no message,
 * behaviour identical to a repo without Dispatch.
 *
 * The owner runs `setup` and `install` and commits `.dispatch/`. A colleague clones the repo onto a
 * machine with no Dispatch (empty HOME, GUI-like `env -i PATH=/usr/bin:/bin`) and opens Claude Code
 * or Codex; the host runs whatever hook command it has. The commands used here are the ones setup
 * really wrote (Claude: the plugin's hooks.json) or renders (Codex), with the hook script present
 * but with no state, and with the script missing altogether.
 *
 * Lower-level proofs: test/unit/hook/hook.test.ts, hosts/claude-code-hook.test.ts,
 * platform/launcher.test.ts ([SEC-hookpath]); the security-suite twin: test/security/collaborator.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { renderHookCommand } from "../../src/platform/launcher.js";
import { GIT_TEST_ENV, snapshotTree } from "../support/index.js";
import { createWorld, THREE_PROVIDERS, useBundles, useClaudePluginShim } from "./harness.js";

const bundles = useBundles();

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A host-launched hook process: nothing but PATH (and HOME when given). */
function guiHook(command: string, cwd: string, input: string, home: string | null) {
  const env = ["PATH=/usr/bin:/bin", ...(home ? [`HOME=${home}`] : [])];
  return spawnSync("/usr/bin/env", ["-i", ...env, "/bin/sh", "-c", command], {
    cwd,
    input,
    encoding: "utf8",
    timeout: 30_000,
  });
}

const sessionStart = (cwd: string) =>
  JSON.stringify({ hook_event_name: "SessionStart", source: "startup", session_id: "s1", cwd });
const preToolUse = (cwd: string) =>
  JSON.stringify({
    hook_event_name: "PreToolUse",
    tool_name: "spawn_agent",
    tool_input: { message: "write the tests" },
    session_id: "s1",
    cwd,
  });

describe("[UC9] collaborator without Dispatch", () => {
  it("[UC9][AC5] a fresh clone of a repo with .dispatch/ is silent for Claude Code and Codex hooks", () => {
    // The owner: installs and commits the shared policy.
    const owner = createWorld({ global: THREE_PROVIDERS });
    useClaudePluginShim(owner);
    expect(owner.dispatch(["setup", "--yes"]).code).toBe(0);
    expect(owner.dispatch(["install", "--yes", "--profile", "preserve"]).code).toBe(0);
    owner.repo.git("add", ".dispatch");
    owner.repo.git("commit", "-q", "-m", "Share the Dispatch policy");
    const plugin = join(owner.home.dispatchHome, "hosts", "claude-code", "plugins", "dispatch");
    const claudeCommand = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"))
      .hooks.SessionStart[0].hooks[0].command as string;

    // Contrast: on the owner's machine the same command does speak.
    const ownerRun = guiHook(
      claudeCommand,
      owner.repo.dir,
      sessionStart(owner.repo.dir),
      owner.home.home,
    );
    expect(ownerRun.stdout).toContain("additionalContext");

    // The colleague: a clone, an empty HOME, no dispatch anywhere.
    const work = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-uc9-")));
    scratch.push(work);
    const clone = join(work, "clone");
    const emptyHome = join(work, "home");
    mkdirSync(emptyHome);
    const git = spawnSync("git", ["clone", "-q", owner.repo.dir, clone], {
      env: { ...GIT_TEST_ENV, PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: emptyHome },
      encoding: "utf8",
    });
    expect(git.status, git.stderr).toBe(0);
    expect(readdirSync(join(clone, ".dispatch")).sort()).toContain("config.yaml");
    const cloneBefore = snapshotTree(clone);

    const hookPath = bundles().hook;
    const missing = join(emptyHome, ".dispatch", "lib", "hook.mjs");
    const commands = [claudeCommand];
    for (const path of [hookPath, missing]) {
      for (const [host, event] of [
        ["claude-code", "SessionStart"],
        ["codex", "SessionStart"],
        ["codex", "PreToolUse"],
      ] as const) {
        commands.push(
          renderHookCommand({ nodePath: process.execPath, hookPath: path, host, event }),
        );
      }
    }
    for (const command of commands) {
      for (const input of [sessionStart(clone), preToolUse(clone), "", "not json {{"]) {
        for (const home of [emptyHome, null]) {
          const r = guiHook(command, clone, input, home);
          expect({ code: r.status, out: r.stdout, err: r.stderr }, command).toEqual({
            code: 0,
            out: "",
            err: "",
          });
        }
      }
    }

    // Nothing appeared: the clone is clean and identical, the HOME is still empty.
    expect(
      spawnSync("git", ["status", "--porcelain"], { cwd: clone, encoding: "utf8" }).stdout,
    ).toBe("");
    expect(snapshotTree(clone)).toEqual(cloneBefore);
    expect(readdirSync(emptyHome)).toEqual([]);
  });

  it("[UC9] a colleague who later installs Dispatch still ignores the committed policy until they trust it", () => {
    const owner = createWorld({ global: THREE_PROVIDERS });
    expect(owner.dispatch(["install", "--yes", "--skip-setup", "--profile", "preserve"]).code).toBe(
      0,
    );
    owner.repo.git("add", ".dispatch");
    owner.repo.git("commit", "-q", "-m", "policy");

    const colleague = createWorld({ global: THREE_PROVIDERS });
    const clone = join(colleague.home.home, "clone");
    const git = spawnSync("git", ["clone", "-q", owner.repo.dir, clone], {
      env: {
        ...GIT_TEST_ENV,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: colleague.home.home,
      },
      encoding: "utf8",
    });
    expect(git.status, git.stderr).toBe(0);
    // Their own profile (balance) still rules: the committed preserve policy is not trusted yet.
    const status = colleague.dispatch(["status"], { cwd: clone });
    expect(status.stdout).toContain("Profile: balance");
    expect(status.stdout).toContain("repo policy NOT trusted, ignored");
    expect(status.stderr).toContain("run `dispatch trust`");
  });
});
