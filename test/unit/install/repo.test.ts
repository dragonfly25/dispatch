import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { buildProgram, runCli } from "../../../src/cli/program.js";
import { promptYesNo, type RepoCommandDeps } from "../../../src/cli/repo-commands.js";
import type { SetupCommandDeps } from "../../../src/cli/setup.js";
import { loadEffectiveConfig } from "../../../src/config/load.js";
import { assetsDir } from "../../../src/config/paths.js";
import { RepoConfigFileSchema } from "../../../src/config/schema.js";
import type { HostIntegration } from "../../../src/core/contracts.js";
import { ExitCode } from "../../../src/core/contracts.js";
import { renderRepoConfig } from "../../../src/install/config-template.js";
import { installsPath } from "../../../src/install/manifest.js";
import { shippedProfiles } from "../../../src/install/repo.js";
import { fakeCodexHost } from "../../support/fake-host.js";
import { snapshotTree, tempHome, tempRepo, treeHash } from "../../support/index.js";

const NOW = new Date("2026-11-07T10:00:00.000Z");

/** Setup deps that touch nothing outside the temp HOME (no hosts, fake runner, no terminal). */
function setupDeps(
  env: Record<string, string>,
  hosts: HostIntegration[] = [],
): Partial<SetupCommandDeps> {
  return {
    env,
    install: () => ({ nodePath: "/n/node", cliPath: "/d/cli.mjs", hookPath: "/d/hook.mjs" }),
    hosts: () => hosts,
    runner: () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    interactive: false,
  };
}

/** A temp HOME with a global config (so `setup` counts as done), plus a CLI runner. */
function kit(repoOpts: Parameters<typeof tempRepo>[0] = {}) {
  const home = tempHome();
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), "# my global config\nversion: 1\n");
  const repo = tempRepo(repoOpts);
  const io = { out: "", err: "" };
  const sink = {
    out: (t: string) => {
      io.out += t;
    },
    err: (t: string) => {
      io.err += t;
    },
  };
  const confirm = vi.fn(async (_q: string) => true);
  const run = async (args: string[], deps: Partial<RepoCommandDeps> = {}) => {
    io.out = "";
    io.err = "";
    const repoDeps: Partial<RepoCommandDeps> = {
      cwd: () => repo.dir,
      env: home.env,
      now: () => NOW,
      isInteractive: () => false,
      confirm,
      ...deps,
    };
    const program = buildProgram(sink, setupDeps(home.env), repoDeps);
    return runCli(args, sink, program, { platform: process.platform, env: {} });
  };
  const globalConfig = () => readFileSync(join(home.dispatchHome, "config.yaml"), "utf8");
  return { home, repo, io, run, confirm, globalConfig };
}

describe("[AC2][UC14] install then uninstall restores the repo", () => {
  it("leaves git status empty and the tree hash unchanged", async () => {
    const k = kit({ files: { "README.md": "# x\n", ".gitignore": "node_modules/\n" } });
    const before = treeHash(k.repo.dir);
    expect(k.repo.git("status", "--porcelain")).toBe("");
    expect(await k.run(["install", "--yes"])).toBe(0);
    expect(treeHash(k.repo.dir)).not.toBe(before);
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(k.repo.git("status", "--porcelain")).toBe("");
    expect(treeHash(k.repo.dir)).toBe(before);
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
  });

  it("holds with a root .gitignore and untracked files, and never edits the root .gitignore", async () => {
    const k = kit({ files: { "README.md": "# x\n", ".gitignore": "build/\n*.log\n" } });
    k.repo.write("scratch/notes.txt", "todo\n");
    k.repo.write("a.log", "ignored\n");
    k.repo.write("src/new.ts", "export {};\n");
    const before = snapshotTree(k.repo.dir);
    const hash = treeHash(k.repo.dir);
    const status = k.repo.git("status", "--porcelain", "--ignored");

    expect(await k.run(["install", "--yes"])).toBe(0);
    expect(readFileSync(join(k.repo.dir, ".gitignore"), "utf8")).toBe("build/\n*.log\n");
    expect(await k.run(["uninstall", "--yes"])).toBe(0);

    expect(snapshotTree(k.repo.dir)).toEqual(before);
    expect(treeHash(k.repo.dir)).toBe(hash);
    expect(k.repo.git("status", "--porcelain", "--ignored")).toBe(status);
  });

  it("removes the runtime state directory too", async () => {
    const k = kit();
    const before = treeHash(k.repo.dir);
    await k.run(["install", "--yes"]);
    k.repo.write(".dispatch/state/run.log", "log\n");
    k.repo.write(".dispatch/state/worktrees/w1/file", "x\n");
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(treeHash(k.repo.dir)).toBe(before);
  });
});

describe("[UC1] install writes only .dispatch/", () => {
  it("shows only .dispatch/ in git status and ignores state/", async () => {
    const k = kit({ files: { "README.md": "# x\n", ".gitignore": "dist/\n" } });
    expect(await k.run(["install", "--yes"])).toBe(0);
    expect(k.repo.git("status", "--porcelain")).toBe("?? .dispatch/");

    const dot = join(k.repo.dir, ".dispatch");
    expect(readFileSync(join(dot, ".gitignore"), "utf8")).toBe("state/\n");
    k.repo.write(".dispatch/state/run.log", "x\n");
    expect(k.repo.git("status", "--porcelain", "-uall")).not.toContain("state");
    expect(k.repo.git("check-ignore", "-q", ".dispatch/state/run.log")).toBe("");
    expect(readdirSync(dot).sort()).toEqual([
      ".gitignore",
      "config.yaml",
      "mappings",
      "profiles",
      "state",
    ]);
  });

  it("copies the shipped profiles and mappings byte for byte", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    for (const sub of ["profiles", "mappings"]) {
      const shipped = readdirSync(join(assetsDir(), sub)).sort();
      expect(shipped.length).toBeGreaterThan(0);
      expect(readdirSync(join(k.repo.dir, ".dispatch", sub)).sort()).toEqual(shipped);
      for (const f of shipped) {
        expect(readFileSync(join(k.repo.dir, ".dispatch", sub, f))).toEqual(
          readFileSync(join(assetsDir(), sub, f)),
        );
      }
    }
  });

  it("writes a version-1 config that the loader accepts and trusts", async () => {
    const k = kit();
    expect(
      await k.run(["install", "--yes", "--profile", "preserve", "--unspecified-model", "fast"]),
    ).toBe(0);
    const text = readFileSync(join(k.repo.dir, ".dispatch/config.yaml"), "utf8");
    const parsed = RepoConfigFileSchema.parse(parse(text));
    expect(parsed).toEqual({ version: 1, profile: "preserve", unspecified_model: "fast" });
    const cfg = loadEffectiveConfig({ cwd: k.repo.dir, env: k.home.env });
    expect(cfg.trusted).toBe(true);
    expect(cfg.routing.activeProfile).toBe("preserve");
    expect(cfg.routing.unspecifiedModel).toBe("fast");
    expect(cfg.issues).toEqual([]);
    expect(k.io.out).toContain("dispatch doctor");
    expect(k.io.out).toContain("dispatch status");
  });

  it("the default config is fully commented and documents every option", () => {
    const text = renderRepoConfig();
    expect(parse(text)).toEqual({ version: 1 });
    for (const key of [
      "unspecified_model",
      "profile",
      "pins",
      "db/migrations/**",
      "mappings",
      "preset",
      "thresholds",
      "shadow_profiles",
      "timeouts",
      "autonomy",
      "allowed_providers",
      "network",
    ]) {
      expect(text).toContain(key);
    }
  });

  it("records the install outside the repo, keyed by the git common dir, with hashes", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    const manifest = JSON.parse(readFileSync(installsPath(k.home.env), "utf8"));
    const id = realpathSync(join(k.repo.dir, ".git"));
    expect(Object.keys(manifest.repos)).toEqual([id]);
    const entry = manifest.repos[id];
    expect(entry.worktreeRoot).toBe(k.repo.dir);
    expect(entry.files.map((f: { path: string }) => f.path)).toContain(".dispatch/config.yaml");
    for (const f of entry.files) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.dirs).toEqual(expect.arrayContaining([".dispatch", ".dispatch/profiles"]));
    await k.run(["uninstall", "--yes"]);
    expect(existsSync(installsPath(k.home.env))).toBe(false);
  });
});

describe("install refusals and flags", () => {
  it("refuses outside a git repository (exit 2)", async () => {
    const k = kit();
    const outside = tempHome().home;
    expect(await k.run(["install", "--yes"], { cwd: () => outside })).toBe(2);
    expect(k.io.err).toContain("not inside a git repository");
    expect(existsSync(join(outside, ".dispatch"))).toBe(false);
  });

  it("refuses when .dispatch/ exists and changes nothing", async () => {
    const k = kit({
      files: { "README.md": "x\n", ".dispatch/config.yaml": "version: 1\nprofile: off\n" },
    });
    const before = treeHash(k.repo.dir);
    expect(await k.run(["install", "--yes"])).toBe(2);
    expect(k.io.err).toContain("already exists");
    expect(treeHash(k.repo.dir)).toBe(before);
  });

  it("--force fills in missing files and leaves edited ones alone", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    const cfg = join(k.repo.dir, ".dispatch/config.yaml");
    writeFileSync(cfg, "version: 1\nprofile: off\n");
    k.repo.git("add", "-A");
    const gi = join(k.repo.dir, ".dispatch/.gitignore");
    writeFileSync(gi, "state/\n");
    expect(await k.run(["install", "--yes", "--force"])).toBe(0);
    expect(readFileSync(cfg, "utf8")).toBe("version: 1\nprofile: off\n");
    expect(k.io.out).toContain("left unchanged");
  });

  it("--force keeps the earlier record: uninstall still removes everything", async () => {
    const k = kit();
    const before = treeHash(k.repo.dir);
    await k.run(["install", "--yes"]);
    rmFile(join(k.repo.dir, ".dispatch/profiles/off.yaml"));
    expect(await k.run(["install", "--yes", "--force"])).toBe(0);
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(treeHash(k.repo.dir)).toBe(before);
  });

  it("rejects an unknown profile", async () => {
    const k = kit();
    expect(await k.run(["install", "--yes", "--profile", "nope"])).toBe(2);
    expect(k.io.err).toContain("unknown profile");
    expect(k.io.err).toContain(shippedProfiles().join(", "));
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
  });

  it("--non-interactive never prompts, even without a terminal", async () => {
    const k = kit();
    expect(await k.run(["install", "--non-interactive"])).toBe(0);
    expect(k.confirm).not.toHaveBeenCalled();
  });

  it("without a terminal and without --yes it refuses to guess (exit 2)", async () => {
    const k = kit();
    expect(await k.run(["install"])).toBe(2);
    expect(k.io.err).toContain("--yes");
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
  });

  it("asks for confirmation interactively and honors a no", async () => {
    const k = kit();
    k.confirm.mockResolvedValueOnce(false);
    expect(await k.run(["install"], { isInteractive: () => true })).toBe(0);
    expect(k.confirm).toHaveBeenCalledTimes(1);
    expect(k.io.out).toContain("+ .dispatch/config.yaml");
    expect(k.io.out).toContain("Aborted");
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);

    expect(await k.run(["install"], { isInteractive: () => true })).toBe(0);
    expect(existsSync(join(k.repo.dir, ".dispatch/config.yaml"))).toBe(true);
  });

  it("--no-trust skips trusting the policy", async () => {
    const k = kit();
    expect(await k.run(["install", "--yes", "--no-trust"])).toBe(0);
    expect(k.globalConfig()).not.toContain("trusted_repos");
    expect(loadEffectiveConfig({ cwd: k.repo.dir, env: k.home.env }).trust.status).toBe(
      "untrusted",
    );
  });

  it("trusts by default and keeps the global config's comments", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    expect(k.globalConfig()).toContain("# my global config");
    expect(k.globalConfig()).toContain(realpathSync(join(k.repo.dir, ".git")));
  });

  it("without a global config it runs the real setup first, then installs and trusts", async () => {
    const k = kit();
    mkdirSync(join(k.home.home, ".codex"));
    rmFile(join(k.home.dispatchHome, "config.yaml"));
    const run = (args: string[]) => {
      const program = buildProgram(
        { out: (t) => (k.io.out += t), err: (t) => (k.io.err += t) },
        setupDeps(k.home.env, [fakeCodexHost()]),
        { cwd: () => k.repo.dir, now: () => NOW, isInteractive: () => false },
      );
      return runCli(args, { out: (t) => (k.io.out += t), err: (t) => (k.io.err += t) }, program, {
        platform: process.platform,
        env: {},
      });
    };
    expect(await run(["install", "--yes"])).toBe(0);
    expect(k.io.out).toContain("running `dispatch setup` first");
    expect(k.io.out).toContain("Setup done");
    expect(existsSync(join(k.home.dispatchHome, "setup-manifest.json"))).toBe(true);
    expect(k.globalConfig()).toContain(realpathSync(join(k.repo.dir, ".git")));
    expect(loadEffectiveConfig({ cwd: k.repo.dir, env: k.home.env }).trusted).toBe(true);

    // The repo part and --global go through the one `uninstall` command.
    expect(await run(["uninstall", "--yes"])).toBe(0);
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
    expect(await run(["uninstall", "--global"])).toBe(0);
    expect(existsSync(k.home.dispatchHome)).toBe(false);
  });

  it("--non-interactive without --yes does not set up behind your back (exit 2)", async () => {
    const k = kit();
    mkdirSync(join(k.home.home, ".codex"));
    rmFile(join(k.home.dispatchHome, "config.yaml"));
    const program = buildProgram(
      { out: (t) => (k.io.out += t), err: (t) => (k.io.err += t) },
      setupDeps(k.home.env, [fakeCodexHost()]),
      { cwd: () => k.repo.dir, now: () => NOW },
    );
    const code = await runCli(
      ["install", "--non-interactive"],
      { out: (t) => (k.io.out += t), err: (t) => (k.io.err += t) },
      program,
      { platform: process.platform, env: {} },
    );
    expect(code).toBe(2);
    expect(k.io.err).toContain("re-run with --yes");
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
  });

  it("--skip-setup installs without a global config and skips trust", async () => {
    const k = kit();
    rmFile(join(k.home.dispatchHome, "config.yaml"));
    expect(await k.run(["install", "--yes", "--skip-setup"])).toBe(0);
    expect(k.io.out).toContain("skipping trust");
    expect(existsSync(join(k.home.dispatchHome, "config.yaml"))).toBe(false);
  });

  it("an injected ensureGlobalSetup can veto and receives the context", async () => {
    const k = kit();
    const ensure = vi.fn(async () => false);
    expect(await k.run(["install", "--yes"], { ensureGlobalSetup: ensure })).toBe(2);
    expect(ensure).toHaveBeenCalledWith(expect.objectContaining({ interactive: false }));
  });

  it("rolls back the files it wrote when a write fails", async () => {
    const k = kit({ files: { "README.md": "x\n", ".dispatch/profiles": "i am a file\n" } });
    const before = treeHash(k.repo.dir);
    expect(await k.run(["install", "--yes", "--force"])).toBe(ExitCode.FAILED);
    expect(treeHash(k.repo.dir)).toBe(before);
    expect(existsSync(installsPath(k.home.env))).toBe(false);
  });
});

describe("uninstall", () => {
  it("is a no-op with exit 0 when nothing was installed", async () => {
    const k = kit({ files: { "README.md": "x\n", ".dispatch/config.yaml": "version: 1\n" } });
    const before = treeHash(k.repo.dir);
    expect(await k.run(["uninstall"])).toBe(0);
    expect(k.io.out).toContain("nothing to remove");
    expect(treeHash(k.repo.dir)).toBe(before);
  });

  it("refuses outside a git repository", async () => {
    const k = kit();
    const outside = tempHome().home;
    expect(await k.run(["uninstall", "--yes"], { cwd: () => outside })).toBe(2);
  });

  it("keeps an edited file with a warning, removes the rest, and still drops trust", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    const edited = join(k.repo.dir, ".dispatch/profiles/balance.yaml");
    writeFileSync(edited, `${readFileSync(edited, "utf8")}# mine\n`);
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(k.io.err + k.io.out).toContain("kept .dispatch/profiles/balance.yaml");
    expect(readFileSync(edited, "utf8")).toContain("# mine");
    expect(readdirSync(join(k.repo.dir, ".dispatch")).sort()).toEqual(["profiles"]);
    expect(readdirSync(join(k.repo.dir, ".dispatch/profiles"))).toEqual(["balance.yaml"]);
    expect(k.globalConfig()).not.toContain("trusted_repos");
    expect(existsSync(installsPath(k.home.env))).toBe(false);
  });

  it("--force removes edited files", async () => {
    const k = kit();
    const before = treeHash(k.repo.dir);
    await k.run(["install", "--yes"]);
    writeFileSync(join(k.repo.dir, ".dispatch/config.yaml"), "version: 1\nprofile: off\n");
    expect(await k.run(["uninstall", "--yes", "--force"])).toBe(0);
    expect(treeHash(k.repo.dir)).toBe(before);
  });

  it("asks per edited file when interactive", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    writeFileSync(join(k.repo.dir, ".dispatch/config.yaml"), "version: 1\nprofile: off\n");
    k.confirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await k.run(["uninstall"], { isInteractive: () => true })).toBe(0);
    expect(k.confirm).toHaveBeenCalledTimes(2);
    expect(k.confirm.mock.calls[1]?.[0]).toContain("config.yaml was edited");
    expect(readFileSync(join(k.repo.dir, ".dispatch/config.yaml"), "utf8")).toContain(
      "profile: off",
    );
  });

  it("honors a no at the confirmation", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    const before = treeHash(k.repo.dir);
    k.confirm.mockResolvedValueOnce(false);
    expect(await k.run(["uninstall"], { isInteractive: () => true })).toBe(0);
    expect(k.io.out).toContain("Aborted");
    expect(treeHash(k.repo.dir)).toBe(before);
    expect(existsSync(installsPath(k.home.env))).toBe(true);
  });

  it("keeps a directory that holds files of the user's and says so", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    k.repo.write(".dispatch/profiles/mine.yaml", "version: 1\nrules: []\n");
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(k.io.out).toContain("kept .dispatch/profiles/");
    expect(readdirSync(join(k.repo.dir, ".dispatch/profiles"))).toEqual(["mine.yaml"]);
  });

  it("skips files that are already gone", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    rmFile(join(k.repo.dir, ".dispatch/profiles/off.yaml"));
    expect(await k.run(["uninstall", "--yes"])).toBe(0);
    expect(existsSync(join(k.repo.dir, ".dispatch"))).toBe(false);
  });

  it("fails clearly on a corrupt manifest", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    writeFileSync(installsPath(k.home.env), "{not json");
    expect(await k.run(["uninstall", "--yes"])).toBe(2);
    expect(k.io.err).toContain("unreadable");
  });

  it("--global is WP17's flow: it never touches the repo part", async () => {
    const k = kit();
    await k.run(["install", "--yes"]);
    const before = treeHash(k.repo.dir);
    expect(await k.run(["uninstall", "--global", "--keep-home"])).toBe(0);
    expect(treeHash(k.repo.dir)).toBe(before);
    expect(existsSync(k.home.dispatchHome)).toBe(true);
  });
});

describe("default collaborators", () => {
  it("work with only cwd injected (env comes from the setup deps)", async () => {
    const k = kit();
    const sink = { out: () => {}, err: () => {} };
    const program = buildProgram(sink, setupDeps(k.home.env), { cwd: () => k.repo.dir });
    const ctx = { platform: process.platform, env: {} };
    expect(await runCli(["install", "--yes"], sink, program, ctx)).toBe(0);
    expect(await runCli(["uninstall", "--yes"], sink, program, ctx)).toBe(0);
  });
});

describe("promptYesNo", () => {
  async function ask(answer: string | null) {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = promptYesNo("Proceed?", input, output);
    if (answer === null) input.end();
    else input.write(`${answer}\n`);
    return { result: await p, prompt: output.read()?.toString() };
  }

  it.each(["y", "Y", "yes", " Yes "])("accepts %j", async (a) => {
    const { result, prompt } = await ask(a);
    expect(result).toBe(true);
    expect(prompt).toContain("Proceed? [y/N]");
  });

  it.each(["", "n", "no", "maybe"])("declines %j", async (a) => {
    expect((await ask(a)).result).toBe(false);
  });

  it("declines when the input ends", async () => {
    expect((await ask(null)).result).toBe(false);
  });
});

function rmFile(path: string): void {
  rmSync(path, { force: true });
}
