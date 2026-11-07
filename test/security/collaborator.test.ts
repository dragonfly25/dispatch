/**
 * Security suite (WP28), AC5 / spec §2.4: a collaborator who clones a repo with `.dispatch/`
 * committed but has no Dispatch (empty HOME, GUI-like `env -i PATH=/usr/bin:/bin`) sees nothing:
 * the host hook command is silent and the clone stays clean. Unit coverage: test/unit/hook/hook.test.ts
 * and test/unit/hosts/claude-code-hook.test.ts ([UC9]); the command string itself:
 * test/unit/platform/launcher.test.ts ([SEC-hookpath]).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderHookCommand } from "../../src/platform/launcher.js";
import { GIT_TEST_ENV, snapshotTree, type TempRepo, tempRepo } from "../support/index.js";
import { type Bundles, buildBundles } from "./harness.js";

let bundles: Bundles;
let origin: TempRepo;
let work: string;
let clone: string;
let emptyHome: string;

beforeAll(async () => {
  bundles = await buildBundles();
  origin = tempRepo({
    files: {
      "README.md": "# project\n",
      ".dispatch/config.yaml": "version: 1\nprofile: preserve\n",
      ".dispatch/.gitignore": "state/\n",
      ".dispatch/profiles/team.yaml": "version: 1\nrules: []\n",
    },
  });
  work = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-collab-")));
  clone = join(work, "clone");
  emptyHome = join(work, "home");
  mkdirSync(emptyHome);
  const r = spawnSync("git", ["clone", "-q", origin.dir, clone], {
    env: { ...GIT_TEST_ENV, PATH: "/usr/bin:/bin", HOME: emptyHome },
    encoding: "utf8",
  });
  expect(r.status, r.stderr).toBe(0);
}, 120_000);

afterAll(() => {
  bundles?.cleanup();
  origin?.cleanup();
  if (work) rmSync(work, { recursive: true, force: true });
});

const STDIN = {
  valid: JSON.stringify({
    session_id: "00000000-0000-4000-8000-000000000001",
    hook_event_name: "SessionStart",
    source: "startup",
    cwd: "<clone>",
  }),
  garbage: "\u0000\u0001 not json {{{",
  empty: "",
  huge: "x".repeat(2 * 1024 * 1024),
};

/** Runs `argv` under `env -i PATH=/usr/bin:/bin [HOME=<empty>]` in the clone, like a GUI host. */
function gui(argv: string[], input: string, withHome = true) {
  const env = ["PATH=/usr/bin:/bin", ...(withHome ? [`HOME=${emptyHome}`] : [])];
  return spawnSync("/usr/bin/env", ["-i", ...env, ...argv], {
    cwd: clone,
    input: input.replace("<clone>", clone),
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("[AC5][SEC-hooks] a collaborator without Dispatch sees nothing", () => {
  const cases = Object.entries(STDIN).flatMap(([name, input]) =>
    [true, false].map((withHome) => [name, input, withHome] as const),
  );

  it.each(cases)(
    "[AC5][SEC-hooks] the Claude SessionStart hook command (as setup writes it) is silent: %s stdin, HOME=%s",
    (_name, input, withHome) => {
      const installed = renderHookCommand({
        nodePath: process.execPath,
        hookPath: bundles.hook,
        host: "claude-code",
        event: "SessionStart",
      });
      const missing = renderHookCommand({
        nodePath: process.execPath,
        hookPath: join(emptyHome, ".dispatch", "lib", "hook.mjs"),
        host: "claude-code",
        event: "SessionStart",
      });
      for (const command of [installed, missing]) {
        const r = gui(["/bin/sh", "-c", command], input, withHome);
        expect({ code: r.status, out: r.stdout, err: r.stderr }).toEqual({
          code: 0,
          out: "",
          err: "",
        });
      }
    },
  );

  it.each(Object.entries(STDIN))(
    "[AC5][SEC-hooks] hook.mjs run directly is silent for %s stdin, for every host and event",
    (_name, input) => {
      for (const [host, event] of [
        ["claude-code", "SessionStart"],
        ["codex", "SessionStart"],
        ["codex", "PreToolUse"],
        ["nope", "SessionStart"],
      ]) {
        const r = gui([process.execPath, bundles.hook, host as string, event as string], input);
        expect({ code: r.status, out: r.stdout, err: r.stderr }).toEqual({
          code: 0,
          out: "",
          err: "",
        });
      }
    },
  );

  it("[AC5] the clone has no Dispatch side effects: clean status, no hooks, nothing in HOME", () => {
    const git = (...args: string[]) =>
      spawnSync("git", args, {
        cwd: clone,
        env: { ...GIT_TEST_ENV, PATH: "/usr/bin:/bin", HOME: emptyHome },
        encoding: "utf8",
      });
    expect(git("status", "--porcelain", "--ignored").stdout).toBe("");
    const hooks = readdirSync(join(clone, ".git", "hooks"));
    expect(hooks.filter((h) => !h.endsWith(".sample"))).toEqual([]);
    expect(snapshotTree(emptyHome)).toEqual({});
    // Only the committed policy files; no host config dirs in the repo.
    expect(readdirSync(clone).sort()).toEqual([".dispatch", ".git", "README.md"]);
  });
});
