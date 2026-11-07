import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EditOp, HostIntegration } from "../../../src/core/contracts.js";
import { sha256 } from "../../../src/hosts/_framework/fsutil.js";
import {
  applySetup,
  planSetup,
  readManifest,
  type SetupContext,
  uninstallGlobal,
} from "../../../src/hosts/_framework/index.js";
import { CLAUDE_AGENT_MATCHER } from "../../../src/hosts/claude-code/hook.js";
import {
  claudeConfigDir,
  claudeInstanceOf,
  createClaudeCodeIntegration,
  PLUGIN_ID,
} from "../../../src/hosts/claude-code/integration.js";
import { createCommandRunner } from "../../../src/runner/command.js";
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

/** A claude integration whose `claude` is the fake on PATH (or nothing when `fs` is NONE). */
function host(extraEnv: Record<string, string> = {}, withFake = true): HostIntegration {
  if (withFake) fakes = createFakes({});
  const env = { ...(fakes?.env ?? { PATH: "/nonexistent" }), HOME: h.home, ...extraEnv };
  return createClaudeCodeIntegration({ env: () => env, ...(withFake ? {} : { fs: NONE }) });
}

function ctx(hosts: HostIntegration[], hookPath = "/opt/d/hook.mjs"): SetupContext {
  return {
    home: h.home,
    dispatchHome: h.dispatchHome,
    install: { nodePath: "/opt/node/bin/node", cliPath: "/opt/d/cli.mjs", hookPath },
    hosts,
  };
}

const claudeBin = (): string => join(fakes?.binDir ?? "", "claude");
const bundle = (): string => join(h.dispatchHome, "hosts", "claude-code");

describe("claude-code plan and setup [UC1]", () => {
  it("lists exactly the expected ops and preview text", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const plan = await planSetup(ctx([host()]));
    const plugin = join(bundle(), "plugins", "dispatch");
    expect(plan.ops.map((o) => [o.kind, o.signature])).toEqual([
      ["new-file", "dispatch-launcher"],
      ["new-file", join(bundle(), ".claude-plugin", "marketplace.json")],
      ["new-file", join(plugin, ".claude-plugin", "plugin.json")],
      ["new-file", join(plugin, "agents", "dispatch.md")],
      ["new-file", join(plugin, "hooks", "hooks.json")],
      ["cli-command", "claude-marketplace"],
      ["cli-command", "claude-plugin"],
    ]);
    const cli = plan.ops.filter((o) => o.kind === "cli-command");
    expect(cli.every((o) => o.file === claudeBin())).toBe(true);
    expect(plan.ops.filter((o) => o.trustGrant !== null)).toEqual([cli[1]]);
    expect(plan.preview).toBe(
      [
        "Dispatch setup will make these changes:",
        `  - create ${join(h.dispatchHome, "bin", "dispatch")} (mode 0755)`,
        `  - create ${join(bundle(), ".claude-plugin", "marketplace.json")} (mode 0644)`,
        `  - create ${join(plugin, ".claude-plugin", "plugin.json")} (mode 0644)`,
        `  - create ${join(plugin, "agents", "dispatch.md")} (mode 0644)`,
        `  - create ${join(plugin, "hooks", "hooks.json")} (mode 0644)`,
        `  - run ${claudeBin()} plugin marketplace add ${bundle()} --scope user`,
        `  - run ${claudeBin()} plugin install dispatch@dispatch-local -s user --json -y`,
        "",
        "Trust grants (they give a host extra authority; read them carefully):",
        `  - ${claudeBin()}: installs the Dispatch plugin (a sub-agent, a SessionStart hook, and a PreToolUse hook that redirects general-purpose sub-agents to Dispatch in trusted repos) for every Claude Code session of this user`,
        "",
        "Hosts detected: claude-code",
        "",
      ].join("\n"),
    );
  });

  it("renders the plugin from the assets with absolute paths and wait 100", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const plan = await planSetup(ctx([host()]));
    await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner: fakeClaudeRunner(h.home),
    });
    const launcher = join(h.dispatchHome, "bin", "dispatch");
    const plugin = join(bundle(), "plugins", "dispatch");
    const agent = readFileSync(join(plugin, "agents", "dispatch.md"), "utf8");
    expect(agent).toContain(`${launcher} run --detach --json --task '<task>'`);
    expect(agent).toContain(`${launcher} wait <runId> --json --timeout 100`);
    expect(agent).toContain("model: haiku");
    expect(agent).toContain("EXTERNAL_AGENT_OUTPUT");
    expect(agent).not.toMatch(/\{\{/);
    const hooks = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
    const command = hooks.hooks.SessionStart[0].hooks[0].command as string;
    expect(command).toContain(
      "exec '/opt/node/bin/node' '/opt/d/hook.mjs' claude-code SessionStart",
    );
    expect(Object.keys(hooks.hooks)).toEqual(["SessionStart", "PreToolUse"]);
    const pre = hooks.hooks.PreToolUse[0];
    expect(pre.matcher).toBe(CLAUDE_AGENT_MATCHER); // [UC2] hard mode
    expect(pre.hooks[0]).toEqual({
      type: "command",
      command: command.replace(/SessionStart$/, "PreToolUse"),
      timeout: 5,
    });
    expect(command.startsWith('[ -n "$DISPATCH_DEPTH" ] && exit 0;')).toBe(true);
    expect(
      JSON.parse(readFileSync(join(bundle(), ".claude-plugin", "marketplace.json"), "utf8")).name,
    ).toBe("dispatch-local");
    expect(
      JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name,
    ).toBe("dispatch");
  });

  it.each([
    ["with user keys", '{\n  "model": "opus",\n  "permissions": {\n    "allow": []\n  }\n}\n'],
    ["an empty object", "{}\n"],
  ])(
    "apply + uninstall --global leaves settings.json byte-identical (%s)",
    async (_n, original) => {
      h = tempHome();
      mkdirSync(join(h.home, ".claude"));
      const settings = join(h.home, ".claude", "settings.json");
      writeFileSync(settings, original);
      const runner = fakeClaudeRunner(h.home);
      const integration = host();
      const plan = await planSetup(ctx([integration]));
      const summary = await applySetup(plan, {
        dispatchHome: h.dispatchHome,
        confirm: true,
        runner,
      });
      expect(summary.applied).toHaveLength(plan.ops.length);
      const during = JSON.parse(readFileSync(settings, "utf8"));
      expect(during.enabledPlugins).toEqual({ [PLUGIN_ID]: true });
      expect(during.extraKnownMarketplaces["dispatch-local"].source.path).toBe(bundle());

      // The exact argv sequence of the `claude plugin` calls.
      expect(runner.calls).toEqual([
        [claudeBin(), "plugin", "marketplace", "add", bundle(), "--scope", "user"],
        [claudeBin(), "plugin", "install", "dispatch@dispatch-local", "-s", "user", "--json", "-y"],
      ]);
      // Idempotent re-run: nothing applied, no further CLI call.
      const again = await applySetup(await planSetup(ctx([integration])), {
        dispatchHome: h.dispatchHome,
        confirm: true,
        runner,
      });
      expect(again.applied).toEqual([]);
      expect(runner.calls).toHaveLength(2);

      const un = await uninstallGlobal({ dispatchHome: h.dispatchHome, runner });
      expect(un.warnings).toEqual([]);
      expect(runner.calls.slice(2)).toEqual([
        [claudeBin(), "plugin", "uninstall", "dispatch@dispatch-local", "-s", "user"],
        [claudeBin(), "plugin", "marketplace", "remove", "dispatch-local"],
      ]);
      expect(readFileSync(settings, "utf8")).toBe(original);
      expect(readdirSync(join(h.home, ".claude"))).toEqual(["settings.json"]);
      expect(existsSync(h.dispatchHome)).toBe(false);
    },
  );

  it("refresh of a v0.1.0 install adds the PreToolUse hook in place, no reinstall; uninstall still restores [UC2][UC14][AC2]", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const settings = join(h.home, ".claude", "settings.json");
    const original = '{\n  "model": "opus"\n}\n';
    writeFileSync(settings, original);
    const runner = fakeClaudeRunner(h.home);
    const integration = host();
    // A v0.1.0 install: the same plan, but hooks.json with SessionStart only.
    const old = await planSetup(ctx([integration]));
    const hooksFile = join(bundle(), "plugins", "dispatch", "hooks", "hooks.json");
    old.ops = old.ops.map((op) => {
      if (op.file !== hooksFile) return op;
      const parsed = JSON.parse(op.content);
      delete parsed.hooks.PreToolUse;
      const content = `${JSON.stringify(parsed, null, 2)}\n`;
      return { ...op, content, sha256: sha256(content) };
    });
    await applySetup(old, { dispatchHome: h.dispatchHome, confirm: true, runner });
    expect(Object.keys(JSON.parse(readFileSync(hooksFile, "utf8")).hooks)).toEqual([
      "SessionStart",
    ]);

    const plan = await planSetup(ctx([integration]));
    expect(plan.stale).toEqual([]);
    const refreshed = await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner,
      refresh: true,
    });
    expect(refreshed.applied).toEqual([hooksFile]);
    expect(Object.keys(JSON.parse(readFileSync(hooksFile, "utf8")).hooks)).toEqual([
      "SessionStart",
      "PreToolUse",
    ]);
    // Claude reads a directory marketplace plugin from its folder: no plugin reinstall.
    expect(runner.calls).toHaveLength(2);

    const un = await uninstallGlobal({ dispatchHome: h.dispatchHome, runner });
    expect(un.warnings).toEqual([]);
    expect(readFileSync(settings, "utf8")).toBe(original);
    expect(readdirSync(join(h.home, ".claude"))).toEqual(["settings.json"]);
    expect(existsSync(h.dispatchHome)).toBe(false);
  });

  it("with no settings.json beforehand, no Dispatch key and no plugin leftovers remain", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const runner = fakeClaudeRunner(h.home);
    const plan = await planSetup(ctx([host()]));
    await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true, runner });
    await uninstallGlobal({ dispatchHome: h.dispatchHome, runner });
    const settings = join(h.home, ".claude", "settings.json");
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({});
    expect(readdirSync(join(h.home, ".claude"))).toEqual(["settings.json"]);
  });

  it("drives the fake `claude plugin` CLI end to end (argv recorded by the fake) [UC1]", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const hostIntegration = host();
    fakes?.setScenarios({ "claude:plugin": { stdout: "{}\n" } });
    const runner = createCommandRunner({ cwd: h.home });
    const plan = await planSetup(ctx([hostIntegration]));
    await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true, runner });
    await uninstallGlobal({ dispatchHome: h.dispatchHome, runner });
    const calls = fakes?.readLog({ cli: "claude", key: "plugin" }).map((c) => c.args);
    expect(calls).toEqual([
      ["plugin", "marketplace", "add", bundle(), "--scope", "user"],
      ["plugin", "install", "dispatch@dispatch-local", "-s", "user", "--json", "-y"],
      ["plugin", "uninstall", "dispatch@dispatch-local", "-s", "user"],
      ["plugin", "marketplace", "remove", "dispatch-local"],
    ]);
  });

  it("records the claude binary, undo argv and snapshots in the manifest", async () => {
    h = tempHome();
    mkdirSync(join(h.home, ".claude"));
    const plan = await planSetup(ctx([host()]));
    await applySetup(plan, {
      dispatchHome: h.dispatchHome,
      confirm: true,
      runner: fakeClaudeRunner(h.home),
    });
    const entries = readManifest(h.dispatchHome).entries.filter((e) => e.kind === "cli-command");
    expect(entries.map((e) => e.undo)).toEqual([
      ["plugin", "marketplace", "remove", "dispatch-local"],
      ["plugin", "uninstall", "dispatch@dispatch-local", "-s", "user"],
    ]);
    expect(entries[0]?.snapshot?.jsonKeys).toEqual([
      {
        file: join(h.home, ".claude", "settings.json"),
        key: "extraKnownMarketplaces",
        before: "absent",
      },
    ]);
    expect(entries[1]?.snapshot?.paths?.every((p) => p.existed === false)).toBe(true);
  });

  it("an absent host gets no ops and no directories [UC1]", async () => {
    h = tempHome();
    const integration = host({}, false);
    expect(
      await integration.detect({
        home: h.home,
        launcherPath: "/l",
        nodePath: "/n",
        hookPath: "/h",
      }),
    ).toBe(false);
    const plan = await planSetup(ctx([integration]));
    expect(plan.ops.map((o) => o.signature)).toEqual(["dispatch-launcher"]);
    expect(plan.absent).toEqual(["claude-code"]);
    await applySetup(plan, { dispatchHome: h.dispatchHome, confirm: true });
    expect(readdirSync(h.home)).toEqual([".dispatch"]);
  });

  it("detects by config dir alone, or by binary alone; plans nothing without a binary", async () => {
    h = tempHome();
    const c = { home: h.home, launcherPath: "/l", nodePath: "/n", hookPath: "/h" };
    mkdirSync(join(h.home, ".claude"));
    const dirOnly = host({}, false);
    expect(await dirOnly.detect(c)).toBe(true);
    expect(dirOnly.plan(c)).toEqual([]);
    const binOnly = createClaudeCodeIntegration({
      env: () => ({ HOME: join(h.home, "other"), PATH: "/nonexistent" }),
      fs: { isExecutableFile: (p) => p === "/opt/homebrew/bin/claude", realpath: (p) => p },
    });
    expect(await binOnly.detect({ ...c, home: join(h.home, "other") })).toBe(true);
    expect(
      binOnly.plan({ ...c, launcherPath: join(h.dispatchHome, "bin", "dispatch") })[5]?.file,
    ).toBe("/opt/homebrew/bin/claude");
  });
});

describe("claude-code self detection and instances [UC12]", () => {
  const integration = createClaudeCodeIntegration({ env: () => ({}) });

  it("detects Claude Code from the environment only", () => {
    expect(integration.detectSelf({})).toBeNull();
    expect(integration.detectSelf({ CLAUDECODE: "0" })).toBeNull();
    expect(integration.detectSelf({ CLAUDECODE: "1" })).toEqual({
      host: "claude-code",
      version: null,
    });
    expect(integration.detectSelf({ CLAUDE_CODE_ENTRYPOINT: "cli" })?.host).toBe("claude-code");
    expect(
      integration.detectSelf({
        CLAUDECODE: "1",
        CLAUDE_CODE_EXECPATH: "/Users/u/Library/claude-code/2.1.317/claude",
      })?.version,
    ).toBe("2.1.317");
    expect(integration.detectSelf({ CLAUDECODE: "1", CLAUDE_CODE_VERSION: "2.2.0" })?.version).toBe(
      "2.2.0",
    );
    expect(
      integration.detectSelf({ CLAUDECODE: "1", CLAUDE_CODE_EXECPATH: "/usr/local/bin/claude" })
        ?.version,
    ).toBeNull();
  });

  it("CLAUDE_CONFIG_DIR picks the instance; relative or empty values are ignored", () => {
    expect(claudeInstanceOf({}, "/h")).toEqual({ configDir: "/h/.claude", isDefault: true });
    expect(claudeInstanceOf({ CLAUDE_CONFIG_DIR: "/h/.claude" }, "/h").isDefault).toBe(true);
    expect(claudeInstanceOf({ CLAUDE_CONFIG_DIR: "/h/.claude-alt" }, "/h")).toEqual({
      configDir: "/h/.claude-alt",
      isDefault: false,
    });
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "rel/dir" }, "/h")).toBe("/h/.claude");
    expect(claudeConfigDir({ CLAUDE_CONFIG_DIR: "" }, "/h")).toBe("/h/.claude");
  });

  it("setup under claude-alt snapshots and undoes that instance's files", async () => {
    h = tempHome();
    const alt = join(h.home, ".claude-alt");
    mkdirSync(alt);
    const integration = host({ CLAUDE_CONFIG_DIR: alt });
    expect(
      await integration.detect({
        home: h.home,
        launcherPath: "/l",
        nodePath: "/n",
        hookPath: "/h",
      }),
    ).toBe(true);
    const ops: EditOp[] = (await planSetup(ctx([integration]))).ops.filter(
      (o) => o.kind === "cli-command",
    );
    const specs = ops.map((o) => JSON.parse(o.content));
    expect(specs[0].snapshot.jsonKeys).toEqual([
      { file: join(alt, "settings.json"), keys: ["extraKnownMarketplaces"] },
    ]);
    expect(specs[1].snapshot.jsonKeys[0].file).toBe(join(alt, "settings.json"));
    expect(specs[1].snapshot.leftovers.at(-1).path).toBe(join(alt, "plugins"));
    expect(JSON.stringify(specs)).not.toContain(join(h.home, ".claude", "settings.json"));
  });
});

describe("claude-code integration shape", () => {
  it("no contract sub-agent strategy (the rewrite lives in hooks.json), wait 100 s, both handlers", () => {
    h = tempHome();
    const integration = host({}, false);
    expect(integration.id).toBe("claude-code");
    expect(integration.subagentStrategy).toBe("none");
    expect(integration.subagentMatcher).toBeNull();
    expect(integration.waitTimeoutSec).toBe(100);
    expect(Object.keys(integration.hookHandlers)).toEqual(["SessionStart", "PreToolUse"]);
  });
});
