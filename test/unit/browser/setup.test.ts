/**
 * `dispatch setup` provisions the isolated browser through a recorded `cli-command` op, with a fake
 * npm (no network): plan and trust grant, install, idempotent refresh, reinstall when the copy went
 * missing, removal by `uninstall --global`, never as root; plus the `claude-code.browser` doctor check.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type BrowserFs,
  browserToolsDir,
  installStatus,
  PINNED_INTEGRITY,
  PLAYWRIGHT_MCP_VERSION,
} from "../../../src/browser/index.js";
import { buildProgram, runCli } from "../../../src/cli/program.js";
import type { SetupCommandDeps } from "../../../src/cli/setup.js";
import type { CommandRunner } from "../../../src/hosts/_framework/index.js";
import { claudeDoctorChecks } from "../../../src/hosts/claude-code/doctor.js";
import { type TempHome, tempHome } from "../../support/index.js";

let h: TempHome | undefined;
afterEach(() => {
  h?.cleanup();
  h = undefined;
});

interface Call {
  binary: string;
  argv: readonly string[];
  env: Record<string, string> | undefined;
}

/** A fake npm: `install --prefix <dir>` writes what npm would; the undo removes the directory. */
function fakeNpm(calls: Call[]): CommandRunner {
  return {
    async run(binary, argv, opts) {
      calls.push({ binary, argv, env: opts?.env });
      if (argv[1] === "install") {
        const dir = argv[argv.indexOf("--prefix") + 1] as string;
        const pkg = join(dir, "node_modules", "@playwright", "mcp");
        mkdirSync(pkg, { recursive: true });
        writeFileSync(
          join(pkg, "package.json"),
          JSON.stringify({ version: PLAYWRIGHT_MCP_VERSION }),
        );
        writeFileSync(join(pkg, "cli.js"), "");
        const packages = Object.fromEntries(
          Object.entries(PINNED_INTEGRITY).map(([k, v]) => [k, { integrity: v }]),
        );
        writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages }));
      } else if (argv[0] === "-e") {
        rmSync(JSON.parse(/rmSync\(("[^"]+")/.exec(argv[1] ?? "")?.[1] ?? '""'), {
          recursive: true,
          force: true,
        });
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
}

function harness(over: Partial<SetupCommandDeps> = {}) {
  const t = tempHome();
  h = t;
  const bin = join(t.home, "node", "bin");
  mkdirSync(join(t.home, "node", "lib"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "node"), "");
  writeFileSync(join(t.home, "node", "lib", "npm-cli.js"), "");
  symlinkSync(join(t.home, "node", "lib", "npm-cli.js"), join(bin, "npm"));
  const calls: Call[] = [];
  const io = { stdout: "", stderr: "" };
  const sink = {
    out: (s: string) => {
      io.stdout += s;
    },
    err: (s: string) => {
      io.stderr += s;
    },
  };
  const deps: Partial<SetupCommandDeps> = {
    env: t.env,
    install: () => ({
      nodePath: join(bin, "node"),
      cliPath: "/d/cli.mjs",
      hookPath: "/d/hook.mjs",
    }),
    hosts: () => [],
    runner: () => fakeNpm(calls),
    interactive: false,
    uid: 501,
    ...over,
  };
  const run = (...args: string[]) =>
    runCli(args, sink, buildProgram(sink, deps, {}), { platform: "darwin", env: {} });
  const dir = browserToolsDir(t.dispatchHome);
  const installs = () => calls.filter((c) => c.argv[1] === "install");
  return { t, io, run, calls, installs, dir, npmCli: realpathSync(join(bin, "npm")) };
}

describe("setup installs the isolated browser when the config enables it [UC1][UC14][AC2]", () => {
  it("plan with the trust grant, install, refresh, reinstall, uninstall", async () => {
    const k = harness();
    expect(await k.run("setup", "--non-interactive", "--yes", "--browser")).toBe(0);
    expect(k.io.stderr).toBe("");
    expect(k.io.stdout).toContain("Isolated browser");
    expect(k.io.stdout).toMatch(/run .*node .*npm-cli\.js install --prefix .*playwright-mcp/);
    expect(k.io.stdout).toMatch(/Trust grants[\s\S]*@playwright\/mcp@0\.0\.84 \(~19 MB\)/);
    expect(readFileSync(join(k.t.dispatchHome, "config.yaml"), "utf8")).toMatch(
      /^ {4}browser: true$/m,
    );
    expect(k.installs()).toHaveLength(1);
    const [call] = k.installs();
    expect(call?.argv[0]).toBe(k.npmCli);
    expect(call?.argv).toContain("--ignore-scripts");
    expect(call?.env).toMatchObject({ PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" });
    expect(installStatus(k.dir)).toMatchObject({ ok: true });
    const manifest = JSON.parse(
      readFileSync(join(k.t.dispatchHome, "setup-manifest.json"), "utf8"),
    );
    expect(manifest.entries.map((e: { signature: string }) => e.signature)).toContain(
      "dispatch-browser-playwright-mcp",
    );

    // Idempotent: nothing to do on a refresh.
    expect(await k.run("setup", "--refresh", "--yes", "--non-interactive")).toBe(0);
    expect(k.installs()).toHaveLength(1);
    // A copy deleted by hand is reinstalled by the next refresh.
    rmSync(k.dir, { recursive: true, force: true });
    expect(await k.run("setup", "--refresh", "--yes", "--non-interactive")).toBe(0);
    expect(k.installs()).toHaveLength(2);
    expect(installStatus(k.dir)).toMatchObject({ ok: true });

    expect(await k.run("uninstall", "--global", "--keep-home")).toBe(0);
    expect(existsSync(k.dir)).toBe(false);
    expect(existsSync(join(k.t.dispatchHome, "config.yaml"))).toBe(true);
  });

  it("nothing is installed without the grant, and never as root", async () => {
    const off = harness();
    expect(await off.run("setup", "--non-interactive", "--yes")).toBe(0);
    expect(readFileSync(join(off.t.dispatchHome, "config.yaml"), "utf8")).toMatch(
      /^ {4}browser: false$/m,
    );
    expect(off.calls).toEqual([]);
    expect(off.io.stdout).not.toContain("Isolated browser");

    const root = harness({ uid: 0 });
    expect(await root.run("setup", "--non-interactive", "--yes", "--browser")).toBe(0);
    expect(root.io.stderr).toMatch(/never installed as root/);
    expect(root.calls).toEqual([]);
  });

  it("an answers file can carry the grant", async () => {
    const k = harness();
    const file = join(k.t.home, "answers.yaml");
    writeFileSync(file, "browser: true\n");
    expect(await k.run("setup", "--non-interactive", "--yes", "--answers", file)).toBe(0);
    expect(k.installs()).toHaveLength(1);
  });
});

describe("claude-code.browser doctor check", () => {
  const check = (fs?: BrowserFs) => {
    const c = claudeDoctorChecks({ platform: "darwin", ...(fs ? { browserFs: fs } : {}) }).find(
      (x) => x.id === "claude-code.browser",
    );
    if (!c) throw new Error("missing check");
    return c;
  };
  const ctx = (t: TempHome) => ({ home: t.home, dispatchHome: t.dispatchHome, env: t.env });
  const config = (t: TempHome, text: string) => {
    mkdirSync(t.dispatchHome, { recursive: true });
    writeFileSync(join(t.dispatchHome, "config.yaml"), text);
  };

  it("off, not installed, no network, ready", async () => {
    const k = harness();
    expect(await check().run(ctx(k.t))).toMatchObject({ status: "ok", message: /is off/ });
    config(k.t, "version: 1\nhosts:\n  claude-code:\n    browser: true\n");
    expect(await check().run(ctx(k.t))).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/setup --refresh --yes/),
    });
    await k.run("setup", "--refresh", "--yes", "--non-interactive");
    const withChrome: BrowserFs = {
      exists: (p) => p.includes("Google Chrome") || existsSync(p),
      read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    };
    expect(await check(withChrome).run(ctx(k.t))).toMatchObject({
      status: "warn",
      fix: expect.stringMatching(/network: delegated-agents/),
    });
    config(
      k.t,
      "version: 1\nnetwork: delegated-agents\nhosts:\n  claude-code:\n    browser: true\n",
    );
    const ok = await check(withChrome).run(ctx(k.t));
    expect(ok.status).toBe("ok");
    expect(ok.message).toMatch(
      /on: @playwright\/mcp 0\.0\.84 \(integrity checked\), Google Chrome at/,
    );
    expect(
      await check({ ...withChrome, exists: (p) => !p.includes("Chrome") && existsSync(p) }).run(
        ctx(k.t),
      ),
    ).toMatchObject({
      status: "warn",
      fix: "install Google Chrome",
    });
  });
});
