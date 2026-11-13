import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type PolicySummary, writeHookCache } from "../../../src/hook/cache.js";
import {
  applySetup,
  type CommandRunner,
  type DoctorCheck,
  type DoctorContext,
  planSetup,
} from "../../../src/hosts/_framework/index.js";
import { claudeDoctorChecks, permissionRules } from "../../../src/hosts/claude-code/doctor.js";
import { createClaudeCodeIntegration } from "../../../src/hosts/claude-code/integration.js";
import { builtinRegistry } from "../../../src/hosts/index.js";
import { launcherFileName } from "../../../src/platform/os.js";
import { fakeClaudeRunner } from "../../support/fake-host.js";
import { createFakes, type FakesContext } from "../../support/index.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
let fakes: FakesContext | undefined;
afterEach(() => {
  h?.cleanup();
  fakes?.dispose();
  fakes = undefined;
});

const NONE = { isExecutableFile: () => false, realpath: (p: string) => p };
const WIN = process.platform === "win32";
/** A PATH dir and the `claude` binary in it, in the running platform's form. */
const BIN_DIR = WIN ? "C:\\bin" : "/bin";
const CLAUDE = WIN ? "C:\\bin\\claude.exe" : "/bin/claude";
const FOUND = { isExecutableFile: (p: string) => p === CLAUDE, realpath: (p: string) => p };
/** `s` as it appears inside a JSON string (Windows paths hold backslashes). */
const inJson = (s: string): string => JSON.stringify(s).slice(1, -1);

function dctx(env: Record<string, string> = {}): DoctorContext {
  return { home: h.home, dispatchHome: h.dispatchHome, env: { HOME: h.home, ...env } };
}

function check(id: string, deps: Parameters<typeof claudeDoctorChecks>[0] = {}): DoctorCheck {
  const c = claudeDoctorChecks(deps).find((x) => x.id === id);
  if (!c) throw new Error(`no check ${id}`);
  return c;
}

const runner = (code: number, stdout: string): (() => CommandRunner) => {
  return () => ({ run: async () => ({ code, stdout, stderr: "" }) });
};

describe("claude-code.plugin [UC1]", () => {
  const plugin = (deps: Parameters<typeof claudeDoctorChecks>[0]) =>
    check("claude-code.plugin", deps).run(dctx({ PATH: BIN_DIR }));

  it("is ok when Claude Code is not installed at all", async () => {
    h = tempHome();
    expect((await check("claude-code.plugin", { fs: NONE }).run(dctx())).status).toBe("ok");
  });

  it("warns when the config dir exists but claude cannot be found", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const r = await check("claude-code.plugin", { fs: NONE }).run(dctx());
    expect(r.status).toBe("warn");
    expect(r.message).toMatch(/claude binary was not found/);
  });

  it.each([
    [
      "array with id",
      JSON.stringify([{ id: "dispatch@dispatch-local", scope: "user", enabled: true }]),
    ],
    [
      "array with name+marketplace",
      JSON.stringify([{ name: "dispatch", marketplace: "dispatch-local" }]),
    ],
    ["object with plugins", JSON.stringify({ plugins: [{ source: "dispatch@dispatch-local" }] })],
    ["object with installed", JSON.stringify({ installed: [{ name: "dispatch" }] })],
  ])("finds the plugin: %s", async (_n, stdout) => {
    h = tempHome();
    const r = await plugin({ fs: FOUND, runner: runner(0, stdout) });
    expect(r).toEqual({ status: "ok", message: "plugin dispatch@dispatch-local is installed" });
  });

  it("warns when it is missing, disabled, or the answer is unusable", async () => {
    h = tempHome();
    const other = JSON.stringify([
      { id: "x@y" },
      { name: "dispatch", marketplace: "elsewhere" },
      5,
    ]);
    const missing = await plugin({ fs: FOUND, runner: runner(0, other) });
    expect(missing).toMatchObject({ status: "warn", fix: "dispatch setup" });
    const disabled = await plugin({
      fs: FOUND,
      runner: runner(0, JSON.stringify([{ id: "dispatch@dispatch-local", enabled: false }])),
    });
    expect(disabled).toMatchObject({
      status: "warn",
      fix: "claude plugin enable dispatch@dispatch-local",
    });
    for (const [code, out] of [
      [1, "[]"],
      [0, "not json"],
      [0, '"string"'],
      [0, '{"plugins": 1}'],
    ] as const) {
      const r = await plugin({ fs: FOUND, runner: runner(code, out) });
      expect(r.status).toBe("warn");
      expect(r.message).toMatch(/no usable answer/);
    }
    const crashed = await plugin({
      fs: FOUND,
      runner: () => ({
        run: async () => {
          throw new Error("spawn ENOENT");
        },
      }),
    });
    expect(crashed).toMatchObject({ status: "warn" });
    expect(crashed.message).toMatch(/spawn ENOENT/);
  });

  it("runs `claude plugin list --json` through the real runner against the fake CLI", async () => {
    h = tempHome();
    fakes = createFakes({
      "claude:plugin": {
        stdout: `${JSON.stringify([{ id: "dispatch@dispatch-local", enabled: true }])}\n`,
      },
    });
    const r = await check("claude-code.plugin").run(dctx({ PATH: fakes.env.PATH ?? "" }));
    expect(r.status).toBe("ok");
    expect(fakes.readLog({ cli: "claude", key: "plugin" }).map((c) => c.args)).toEqual([
      ["plugin", "list", "--json"],
    ]);
  });
});

describe("claude-code.files [UC1]", () => {
  /** Runs setup for real files with a node/hook/cli that exist, then returns the install paths. */
  async function installed() {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const hook = join(h.home, "app", "hook.mjs");
    const cli = join(h.home, "app", "cli.mjs");
    mkdirSync(join(h.home, "app"));
    writeFileSync(hook, "");
    writeFileSync(cli, "");
    const integration = createClaudeCodeIntegration({
      env: () => ({ HOME: h.home, PATH: BIN_DIR }),
      fs: FOUND,
    });
    const plan = await planSetup({
      home: h.home,
      dispatchHome: h.dispatchHome,
      install: { nodePath: process.execPath, cliPath: cli, hookPath: hook },
      hosts: [integration],
    });
    await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner: fakeClaudeRunner(h.home),
    });
    return { hook, cli };
  }
  const run = () => check("claude-code.files", { fs: FOUND }).run(dctx());

  it("is ok right after setup", async () => {
    await installed();
    expect(await run()).toMatchObject({ status: "ok" });
  });

  it("is ok when Claude Code is absent, warns when setup never ran", async () => {
    h = tempHome();
    expect(await check("claude-code.files", { fs: NONE }).run(dctx())).toMatchObject({
      status: "ok",
    });
    mkdirSync(join(h.home, ".claude"));
    expect(await run()).toMatchObject({ status: "warn", fix: "dispatch setup" });
  });

  it("warns with --refresh when the hook or cli path vanished (stale after an upgrade)", async () => {
    const { hook, cli } = await installed();
    rmSync(hook);
    const r = await run();
    expect(r).toMatchObject({ status: "warn", fix: "dispatch setup --refresh" });
    expect(r.message).toContain(hook);
    rmSync(cli);
    expect((await run()).message).toContain(cli);
  });

  it("warns when the node path is no longer executable or the launcher is gone", async () => {
    await installed();
    const hooksFile = join(
      h.dispatchHome,
      "hosts",
      "claude-code",
      "plugins",
      "dispatch",
      "hooks",
      "hooks.json",
    );
    const launcher = join(h.dispatchHome, "bin", launcherFileName());
    const original = readFileSync(launcher, "utf8");
    writeFileSync(launcher, original.replace(process.execPath, "/gone/node"));
    expect((await run()).message).toContain("/gone/node");
    rmSync(launcher);
    expect((await run()).message).toContain(launcher);
    writeFileSync(hooksFile, "{not json");
    expect(await run()).toMatchObject({ status: "warn", fix: "dispatch setup --refresh" });
    writeFileSync(hooksFile, "{}");
    expect((await run()).status).toBe("warn"); // no guard found in the hook command: launcher is gone
  });

  it("treats an unreadable node path in the hook command as stale", async () => {
    await installed();
    const hooksFile = join(
      h.dispatchHome,
      "hosts",
      "claude-code",
      "plugins",
      "dispatch",
      "hooks",
      "hooks.json",
    );
    const json = readFileSync(hooksFile, "utf8").replace(inJson(process.execPath), "/gone/node");
    writeFileSync(hooksFile, json);
    expect((await run()).message).toContain("/gone/node");
  });
});

describe("claude-code.permission-rule [UC1]", () => {
  const run = (env: Record<string, string> = {}) =>
    check("claude-code.permission-rule", { fs: FOUND }).run(dctx(env));

  it("prints the run, wait and apply rules for the user to add, and never writes them", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const settings = join(h.home, ".claude", "settings.json");
    writeFileSync(settings, '{ "model": "opus" }\n');
    const r = await run();
    const launcher = join(h.dispatchHome, "bin", launcherFileName());
    expect(r.status).toBe("warn");
    expect(r.message).toContain(
      `  Bash(${launcher} run:*)\n  Bash(${launcher} wait:*)\n  Bash(${launcher} apply:*)`,
    );
    expect(r.message).toContain(settings);
    expect(r.fix).toContain(`Bash(${launcher} run:*)`);
    expect(readFileSync(settings, "utf8")).toBe('{ "model": "opus" }\n');
    expect(permissionRules("/x/dispatch")).toEqual([
      "Bash(/x/dispatch run:*)",
      "Bash(/x/dispatch wait:*)",
      "Bash(/x/dispatch apply:*)",
    ]);
  });

  it("is ok once both rules are in permissions.allow (jsonc accepted)", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const rules = permissionRules(join(h.dispatchHome, "bin", launcherFileName()));
    writeFileSync(
      join(h.home, ".claude", "settings.json"),
      `{\n  // mine\n  "permissions": { "allow": [${rules.map((r) => JSON.stringify(r)).join(", ")}, 5] }\n}\n`,
    );
    expect((await run()).status).toBe("ok");
    writeFileSync(
      join(h.home, ".claude", "settings.json"),
      `{ "permissions": { "allow": [${JSON.stringify(rules[0])}] } }`,
    );
    expect((await run()).status).toBe("warn");
  });

  it.each([
    ["no file", undefined],
    ["unparsable", "\u0000"],
    ["no permissions", "{}"],
    ["allow not a list", '{"permissions":{"allow":"x"}}'],
    ["null root", "null"],
  ])("warns with the rules when settings.json is %s", async (_n, body) => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    if (body !== undefined) writeFileSync(join(h.home, ".claude", "settings.json"), body);
    expect((await run()).status).toBe("warn");
  });

  it("reads the settings of the CLAUDE_CONFIG_DIR instance [UC12]", async () => {
    h = tempHome();
    const alt = join(h.home, ".claude-alt");
    mkdirSync(alt);
    const r = await run({ CLAUDE_CONFIG_DIR: alt });
    expect(r.message).toContain(join(alt, "settings.json"));
  });

  it("is ok when Claude Code is absent", async () => {
    h = tempHome();
    expect(await check("claude-code.permission-rule", { fs: NONE }).run(dctx())).toMatchObject({
      status: "ok",
    });
  });
});

describe("claude-code.hard-mode [UC2]", () => {
  const run = () => check("claude-code.hard-mode", { fs: FOUND }).run(dctx());
  const hooksFile = () =>
    join(h.dispatchHome, "hosts", "claude-code", "plugins", "dispatch", "hooks", "hooks.json");

  async function installed() {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const integration = createClaudeCodeIntegration({
      env: () => ({ HOME: h.home, PATH: BIN_DIR }),
      fs: FOUND,
    });
    const plan = await planSetup({
      home: h.home,
      dispatchHome: h.dispatchHome,
      install: {
        nodePath: process.execPath,
        cliPath: join(h.home, "app", "cli.mjs"),
        hookPath: join(h.home, "app", "hook.mjs"),
      },
      hosts: [integration],
    });
    await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner: fakeClaudeRunner(h.home),
    });
  }

  const cache = (policy: Partial<PolicySummary>) =>
    writeHookCache(h.dispatchHome, {
      version: 1,
      writtenAt: "2026-11-07T00:00:00.000Z",
      trustedRepos: [],
      policy: { profile: "balance", hardMode: true, summary: "s", ...policy },
    });

  it("reports hard mode on with the intercept list, off, and an idle policy", async () => {
    await installed();
    cache({ hardInterception: true, claudeHard: true, claudeIntercept: ["general-purpose"] });
    expect(await run()).toMatchObject({
      status: "ok",
      message: expect.stringContaining("hard mode is on: Agent calls of general-purpose"),
    });
    cache({ hardInterception: false, claudeHard: true, claudeIntercept: ["*"] });
    expect((await run()).message).toMatch(/every eligible custom agent.*delegates nothing/);
    cache({ hardInterception: true, claudeHard: false });
    expect(await run()).toMatchObject({
      status: "ok",
      message: expect.stringContaining("hard mode is off"),
    });
  });

  it("warns with --refresh for an old cache, a missing cache or a hooks.json without the hook", async () => {
    await installed();
    expect(await run()).toMatchObject({ status: "warn", fix: "dispatch setup --refresh" });
    cache({ hardInterception: true });
    expect(await run()).toMatchObject({ status: "warn", fix: "dispatch setup --refresh" });
    cache({ hardInterception: true, claudeHard: true });
    const parsed = JSON.parse(readFileSync(hooksFile(), "utf8"));
    delete parsed.hooks.PreToolUse;
    writeFileSync(hooksFile(), JSON.stringify(parsed));
    expect(await run()).toMatchObject({
      status: "warn",
      message: expect.stringContaining("no PreToolUse hook"),
      fix: "dispatch setup --refresh",
    });
    writeFileSync(hooksFile(), "{nope");
    expect(await run()).toMatchObject({ status: "warn" });
  });

  it("is ok when Claude Code is absent; warns when the plugin was never set up", async () => {
    h = tempHome();
    expect(await check("claude-code.hard-mode", { fs: NONE }).run(dctx())).toMatchObject({
      status: "ok",
    });
    mkdirSync(join(h.home, ".claude"));
    expect(await run()).toMatchObject({ status: "warn", fix: "dispatch setup" });
  });
});

describe("claude-code.mcp-forwarding [SEC-mcp]", () => {
  const SECRET = "canary-doctor-7f3a";
  function repo(): string {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const root = join(h.home, "repo");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "src"));
    writeFileSync(
      join(h.home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          gh: { command: "gh-mcp", env: { GH_TOKEN: `\${GH_TOKEN}` } },
          leaky: { command: "x", env: { API_KEY: SECRET } },
        },
        projects: { [root]: { enabledMcpjsonServers: [] } },
      }),
    );
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { local: { command: "l" } } }),
    );
    return root;
  }
  const policy = (forwardMcp?: boolean) =>
    writeHookCache(h.dispatchHome, {
      version: 1,
      writtenAt: "2026-11-07T00:00:00.000Z",
      trustedRepos: [],
      policy: {
        profile: "balance",
        hardMode: true,
        summary: "s",
        ...(forwardMcp === undefined ? {} : { forwardMcp }),
      },
    });

  it("lists forwardable vs not-forwardable servers of the current repo, never a value", async () => {
    const root = repo();
    policy(true);
    const r = await check("claude-code.mcp-forwarding", {
      fs: FOUND,
      cwd: () => join(root, "src"),
    }).run(dctx());
    expect(r.status).toBe("ok");
    expect(r.message).toContain("MCP forwarding is on");
    expect(r.message).toContain("forwardable: gh;");
    expect(r.message).toContain("leaky (literal secret in env/headers)");
    expect(r.message).toContain("local (project .mcp.json server not approved in Claude Code)");
    expect(r.message).not.toContain(SECRET);
  });

  it("says forwarding is off without consent, and handles a repo without servers", async () => {
    const root = repo();
    policy(false);
    const off = await check("claude-code.mcp-forwarding", { fs: FOUND, cwd: () => root }).run(
      dctx(),
    );
    expect(off.message).toContain("MCP forwarding is off");
    rmSync(join(h.home, ".claude.json"));
    rmSync(join(root, ".mcp.json"));
    const none = await check("claude-code.mcp-forwarding", { fs: FOUND, cwd: () => root }).run(
      dctx(),
    );
    expect(none.message).toContain("no MCP servers are configured");
    expect(
      (await check("claude-code.mcp-forwarding", { fs: NONE, cwd: () => root }).run(dctx({})))
        .message,
    ).toBe(
      `MCP forwarding is off (hosts.claude-code.forward_mcp): agents that use MCP tools stay on Claude; no MCP servers are configured for ${root}`,
    );
  });
});

describe("registration", () => {
  it("builtinRegistry registers the claude-code and codex hosts and their checks", () => {
    const reg = builtinRegistry();
    expect(reg.getHost("claude-code")?.waitTimeoutSec).toBe(100);
    expect(reg.doctorChecks().map((c) => c.id)).toEqual([
      "setup.manifest",
      "claude-code.plugin",
      "claude-code.files",
      "claude-code.permission-rule",
      "claude-code.hard-mode",
      "claude-code.mcp-forwarding",
      "claude-code.browser",
      "codex.files",
      "codex.rules-launcher",
      "codex.hooks-trusted",
    ]);
  });
});
