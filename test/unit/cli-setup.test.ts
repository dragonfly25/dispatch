import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import {
  defaultSetupDeps,
  registerSetupCommands,
  type SetupCommandDeps,
} from "../../src/cli/setup.js";
import { createCodexIntegration } from "../../src/hosts/codex/integration.js";
import { launcherFileName } from "../../src/platform/os.js";
import { fakeCodexHost } from "../support/fake-host.js";
import { type TempHome, tempHome } from "../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

/** A fixture absolute path in the running platform's form (`/a/b` or `C:\\a\\b`). */
const abs = (p: string): string =>
  process.platform === "win32" ? `C:${p.replaceAll("/", "\\")}` : p;

function cli(deps: Partial<SetupCommandDeps>) {
  const io = { stdout: "", stderr: "" };
  const sink = {
    out(t: string) {
      io.stdout += t;
    },
    err(t: string) {
      io.stderr += t;
    },
  };
  const full: Partial<SetupCommandDeps> = {
    env: h.env,
    install: () => ({
      nodePath: abs("/n/node"),
      cliPath: abs("/d/cli.mjs"),
      hookPath: abs("/d/hook.mjs"),
    }),
    hosts: () => [fakeCodexHost()],
    runner: () => ({ run: async () => ({ code: 0, stdout: "", stderr: "" }) }),
    interactive: false,
    ...deps,
  };
  const run = (...args: string[]) =>
    runCli(args, sink, buildProgram(sink, full), { platform: "darwin", env: {} });
  return { io, run };
}

describe("dispatch setup / uninstall --global [UC1][UC14]", () => {
  it("--non-interactive without --yes prints the plan and changes nothing", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    const { io, run } = cli({});
    expect(await run("setup", "--non-interactive")).toBe(2);
    expect(io.stdout).toContain("Trust grants");
    expect(io.stderr).toMatch(/re-run with --yes/);
    expect(existsSync(h.dispatchHome)).toBe(false);
  });

  it("--yes applies, uninstall --global restores the host files", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    const hooks = join(h.home, ".codex", "hooks.json");
    writeFileSync(hooks, "{\n  // keep\n}\n");
    const { io, run } = cli({});
    expect(await run("setup", "--yes")).toBe(0);
    expect(io.stdout).toMatch(/Setup done: 5 applied, 0 unchanged, 0 removed/);
    expect(await run("setup", "--yes", "--refresh")).toBe(0);
    expect(io.stdout).toMatch(/0 applied, 5 unchanged/);
    expect(await run("uninstall", "--global")).toBe(0);
    expect(io.stdout).toContain(`Removed 5 Dispatch edit(s) and ${h.dispatchHome}`);
    expect(readFileSync(hooks, "utf8")).toBe("{\n  // keep\n}\n");
    expect(existsSync(h.dispatchHome)).toBe(false);
  });

  it("asks interactively; anything but yes changes nothing", async () => {
    h = tempHome();
    // A config already exists, so the wizard is not part of this test (see setup-wizard.test.ts).
    mkdirSync(h.dispatchHome, { recursive: true });
    writeFileSync(join(h.dispatchHome, "config.yaml"), "version: 1\n");
    const no = cli({ interactive: true, ask: async () => "n", hosts: () => [] });
    expect(await no.run("setup")).toBe(0);
    expect(no.io.stdout).toContain("Nothing was changed.");
    const yes = cli({ interactive: true, ask: async () => "yes", hosts: () => [] });
    expect(await yes.run("setup")).toBe(0);
    const launcher = join(h.dispatchHome, "bin", launcherFileName());
    expect(existsSync(launcher)).toBe(true);
    const stale = cli({ interactive: true, ask: async () => "y", hosts: () => [] });
    writeFileSync(launcher, "edited");
    expect(await stale.run("uninstall", "--global", "--keep-home")).toBe(0);
    expect(stale.io.stderr).toMatch(/warning: .*edited since setup/);
    expect(existsSync(h.dispatchHome)).toBe(true);
  });

  it("reports stale edits and suggests --refresh; warnings go to stderr", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    expect(await cli({}).run("setup", "-y")).toBe(0);
    const later = cli({ hosts: () => [] });
    expect(await later.run("setup", "-y")).toBe(0);
    expect(later.io.stdout).toMatch(/4 earlier edit\(s\) are no longer planned/);
  });

  it("repo-level uninstall is an extension point for WP21", async () => {
    h = tempHome();
    // Without the WP21 slot filled (registerSetupCommands used on its own) it says so.
    const bare = new Command().exitOverride();
    registerSetupCommands(
      bare,
      { out: () => {}, err: () => {} },
      {
        ...defaultSetupDeps(),
        env: h.env,
      },
    );
    await expect(bare.parseAsync(["uninstall"], { from: "user" })).rejects.toThrow(
      /not available yet/,
    );
    let called = false;
    const withRepo = cli({
      repoUninstall: async () => {
        called = true;
      },
    });
    expect(await withRepo.run("uninstall")).toBe(0);
    expect(called).toBe(true);
  });

  it("needs HOME and has sane production defaults", async () => {
    h = tempHome();
    // POSIX wording (the win32 one is tested below).
    const { io, run } = cli({ env: {}, platform: "darwin" });
    expect(await run("setup", "--yes")).toBe(2);
    expect(io.stderr).toMatch(/HOME is not set/);
    expect(await run("uninstall", "--global")).toBe(2);
    const d = defaultSetupDeps();
    expect(d.env).toBe(process.env);
    expect(d.install().hookPath).toMatch(/hook\.mjs$/);
    expect(Array.isArray(d.hosts())).toBe(true);
    expect(typeof d.runner(h.home).run).toBe("function");
  });
});

describe("dispatch setup on Windows (platform win32 injected)", () => {
  const install = () => ({
    nodePath: "C:\\nodejs\\node.exe",
    cliPath: "C:\\d\\cli.mjs",
    hookPath: "C:\\d\\hook.mjs",
  });

  it("takes the home from USERPROFILE, writes dispatch.cmd and warns that Codex gets no rule", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".codex"));
    const { HOME: _home, ...rest } = h.env;
    const env = { ...rest, USERPROFILE: h.home };
    const NONE = { isExecutableFile: () => false, realpath: (p: string) => p };
    const codex = createCodexIntegration({ env: () => env, fs: NONE, platform: "win32" });
    const { io, run } = cli({ env, install, hosts: () => [codex], platform: "win32" });
    expect(await run("setup", "--yes")).toBe(0);
    expect(io.stderr).toContain("no Codex rule is installed on Windows");
    expect(readFileSync(join(h.dispatchHome, "bin", "dispatch.cmd"), "utf8")).toContain(
      '"C:\\nodejs\\node.exe" --disable-warning=ExperimentalWarning "C:\\d\\cli.mjs" %*\r\n',
    );
    expect(existsSync(join(h.home, ".codex", "rules", "dispatch.rules"))).toBe(false);
    expect(await run("uninstall", "--global")).toBe(0);
    expect(existsSync(join(h.dispatchHome, "bin", "dispatch.cmd"))).toBe(false);
  });

  it("names both variables when neither HOME nor USERPROFILE is set", async () => {
    h = tempHome();
    const { io, run } = cli({ env: {}, platform: "win32" });
    expect(await run("setup", "--yes")).toBe(2);
    expect(io.stderr).toMatch(/HOME and USERPROFILE are not set/);
  });
});
