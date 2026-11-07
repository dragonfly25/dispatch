/**
 * The isolated browser: install verification, readiness, the setup op, eligibility, the run plan,
 * the codex golden argv and the translation note. Pure or temp-dir only; no npm, no Chrome.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgyInvocation } from "../../../src/adapters/agy/invocation.js";
import { buildClaudeInvocation } from "../../../src/adapters/claude/invocation.js";
import { browserOverrides, buildCodexInvocation } from "../../../src/adapters/codex/invocation.js";
import {
  allowedOrigins,
  type BrowserFs,
  type BrowserRun,
  type BuildInvocationWithBrowser,
  browserCliPath,
  browserReadiness,
  browserToolsDir,
  ENABLED_TOOLS,
  findChrome,
  installStatus,
  PINNED_INTEGRITY,
  PLAYWRIGHT_MCP_VERSION,
} from "../../../src/browser/index.js";
import {
  BROWSER_OP_SIGNATURE,
  browserInstallOp,
  installArgv,
  npmCliFor,
  provisionBlocker,
} from "../../../src/browser/install.js";
import { browserNote, launchPorts, readLaunchConfigs } from "../../../src/browser/note.js";
import { defaultSettings } from "../../../src/config/defaults.js";
import { mergeLayers } from "../../../src/config/merge.js";
import type { GlobalConfigFile, Overlay } from "../../../src/config/schema.js";
import { browserFor, type HookCache } from "../../../src/hook/cache.js";
import { eligibility } from "../../../src/hosts/claude-code/agents.js";
import { describeServer, REASONS } from "../../../src/mcp/index.js";
import { type BrowserPlanInput, planBrowser } from "../../../src/runner/browser.js";
import { decideNetwork } from "../../../src/sandbox/network.js";
import { probeResult, task } from "../../fixtures/contracts.js";
import { makeConfig } from "../router/fixtures.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "dispatch-browser-"));
  dirs.push(d);
  return d;
}

/** Writes a complete pinned install into `dir` (what npm leaves behind). */
function fakeInstall(dir: string, over: { version?: string; integrity?: string } = {}): void {
  const pkg = join(dir, "node_modules", "@playwright", "mcp");
  mkdirSync(pkg, { recursive: true });
  writeFileSync(
    join(pkg, "package.json"),
    JSON.stringify({ version: over.version ?? PLAYWRIGHT_MCP_VERSION }),
  );
  writeFileSync(join(pkg, "cli.js"), "");
  const packages = Object.fromEntries(
    Object.entries(PINNED_INTEGRITY).map(([k, v]) => [k, { integrity: over.integrity ?? v }]),
  );
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages }));
}

describe("the pinned install is verified before use [SEC-browser]", () => {
  it("missing, outdated, tampered and complete installs", () => {
    const dir = tmp();
    expect(installStatus(dir)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not installed/),
    });
    fakeInstall(dir, { version: "0.0.70" });
    expect(installStatus(dir)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/pinned 0\.0\.84/),
    });
    fakeInstall(dir, { integrity: "sha512-evil" });
    expect(installStatus(dir)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/integrity/),
    });
    fakeInstall(dir);
    expect(installStatus(dir)).toEqual({
      ok: true,
      version: "0.0.84",
      cliPath: browserCliPath(dir),
    });
  });

  it("readiness needs the switch, the install and Google Chrome", () => {
    const home = tmp();
    const base = { dispatchHome: home, platform: "darwin", home: "/Users/u" };
    expect(browserReadiness({ ...base, enabled: false })).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/hosts\.claude-code\.browser/),
    });
    expect(browserReadiness({ ...base, enabled: true })).toMatchObject({ ready: false });
    fakeInstall(browserToolsDir(home));
    const disk = (chrome: boolean): BrowserFs => ({
      exists: (p) =>
        p.includes("Google Chrome") || p.startsWith("/opt/") ? chrome : existsSync(p),
      read: (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
    });
    expect(browserReadiness({ ...base, enabled: true, fs: disk(false) })).toEqual({
      ready: false,
      reason: "Google Chrome is not installed",
    });
    const r = browserReadiness({ ...base, enabled: true, fs: disk(true) });
    expect(r).toMatchObject({ ready: true, version: "0.0.84" });
  });

  it("Chrome is looked up in the stable install locations only", () => {
    expect(findChrome("darwin", "/Users/u", { exists: (p) => p.startsWith("/Users/u/") })).toBe(
      "/Users/u/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
    expect(
      findChrome("linux", "/home/u", { exists: (p) => p === "/opt/google/chrome/chrome" }),
    ).toBe("/opt/google/chrome/chrome");
    expect(findChrome("win32", undefined, { exists: () => true })).toBeNull();
  });
});

describe("setup provisions it with npm, never running lifecycle scripts [SEC-browser]", () => {
  it("pinned, local prefix, --ignore-scripts, no browser download, offline undo", () => {
    const op = browserInstallOp({
      dispatchHome: "/h/.dispatch",
      nodePath: "/n/node",
      npmCli: "/n/npm-cli.js",
    });
    expect(op).toMatchObject({
      file: "/n/node",
      kind: "cli-command",
      signature: BROWSER_OP_SIGNATURE,
    });
    expect(op.trustGrant).toMatch(/@playwright\/mcp@0\.0\.84 \(~19 MB\).*never your own profile/);
    const spec = JSON.parse(op.content);
    const dir = "/h/.dispatch/tools/playwright-mcp";
    expect(spec.argv).toEqual(installArgv("/n/npm-cli.js", dir));
    expect(spec.argv).toContain("--ignore-scripts");
    expect(spec.argv).toContain("@playwright/mcp@0.0.84");
    expect(spec.argv.slice(2, 4)).toEqual(["--prefix", dir]);
    expect(spec.argv).not.toContain("-g");
    expect(spec.argv).not.toContain("--global");
    expect(spec.env).toEqual({
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
      npm_config_ignore_scripts: "true",
    });
    expect(spec.ensure).toBe(join(dir, "node_modules", "@playwright", "mcp", "package.json"));
    expect(spec.undo[0]).toBe("-e");
    expect(spec.undo[1]).toContain(JSON.stringify(dir));
    expect(spec.snapshot.leftovers).toEqual([{ path: dir, recursive: true }]);
  });

  it("is never planned as root, nor without an npm next to node", () => {
    const bin = tmp();
    writeFileSync(join(bin, "node"), "");
    expect(provisionBlocker(join(bin, "node"), 501)).toMatch(/npm was not found/);
    mkdirSync(join(bin, "lib"));
    writeFileSync(join(bin, "lib", "npm-cli.js"), "");
    symlinkSync(join(bin, "lib", "npm-cli.js"), join(bin, "npm"));
    expect(npmCliFor(join(bin, "node"))).toBe(realpathSync(join(bin, "lib", "npm-cli.js")));
    expect(provisionBlocker(join(bin, "node"), 501)).toBeNull();
    expect(provisionBlocker(join(bin, "node"), 0)).toMatch(/root/);
  });
});

describe("hosts.claude-code.browser: off by default, a repo or flag can only turn it off [SEC-flags]", () => {
  const G = (g: Partial<GlobalConfigFile> = {}): GlobalConfigFile => ({ version: 1, ...g });
  const on = G({ hosts: { "claude-code": { browser: true } } });
  const merge = (global: GlobalConfigFile, repo?: Overlay, flags?: Overlay) =>
    mergeLayers({
      defaults: defaultSettings(),
      global,
      ...(repo ? { repo } : {}),
      ...(flags ? { flags } : {}),
    });

  it("defaults to false and follows the global switch", () => {
    expect(merge(G()).settings.browser).toBe(false);
    expect(merge(on).settings.browser).toBe(true);
    expect(merge(on).provenance.browser).toBe("global");
  });

  it("repo or flag false tightens; true never loosens", () => {
    expect(merge(on, { browser: false }).settings.browser).toBe(false);
    expect(merge(on, undefined, { browser: false }).settings.browser).toBe(false);
    for (const res of [merge(G(), { browser: true }), merge(G(), undefined, { browser: true })]) {
      expect(res.settings.browser).toBe(false);
      expect(res.issues).toEqual([expect.objectContaining({ level: "error", key: "browser" })]);
    }
  });
});

const BUILDER = {
  name: "feature-builder",
  description: null,
  model: null,
  effort: null,
  body: "Build it, then check it in the browser.",
  tools: [
    "Read",
    "Edit",
    "Bash",
    "mcp__Claude_Browser__navigate",
    "mcp__Claude_Browser__preview_start",
  ],
};

function cache(policy: Partial<HookCache["policy"]> = {}, repoBrowser?: boolean): HookCache {
  return {
    version: 1,
    writtenAt: "2026-11-07T00:00:00Z",
    trustedRepos: [
      { root: "/r", policyHash: null, ...(repoBrowser === false ? { browser: false } : {}) },
    ],
    policy: { profile: "balance", hardMode: true, summary: "", ...policy },
  };
}

describe("eligibility of agents that use the desktop browser [UC2]", () => {
  it("delegated only with the isolated browser available, and Bash for dev servers", () => {
    expect(eligibility(BUILDER as never)).toEqual({
      eligible: false,
      reason: "uses Claude_Browser; the isolated browser is off (hosts.claude-code.browser)",
    });
    expect(
      eligibility(BUILDER as never, { browser: "needs network: set network: delegated-agents" }),
    ).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/needs network/),
    });
    expect(eligibility(BUILDER as never, { browser: true })).toMatchObject({
      eligible: true,
      autonomy: "worktree",
      browser: true,
      mcpServers: [],
    });
    const noBash = { ...BUILDER, tools: ["Read", "Edit", "mcp__Claude_Browser__navigate"] };
    expect(eligibility(noBash as never, { browser: true })).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/without Bash/),
    });
  });

  it("the hook check: ready, repo not lowering it, and the agent in the network scope", () => {
    const ready = { browser: true as const, network: "delegated-agents" as const };
    expect(browserFor(cache(), "/r", "feature-builder")).toMatch(/hosts\.claude-code\.browser/);
    expect(
      browserFor(
        cache({ browser: false, browserReason: "Google Chrome is not installed" }),
        "/r",
        "a",
      ),
    ).toBe("Google Chrome is not installed");
    expect(browserFor(cache(ready), "/r", "feature-builder")).toBe(true);
    expect(browserFor(cache({ browser: true }), "/r", "x")).toBe(
      "needs network: set network: delegated-agents",
    );
    expect(
      browserFor(cache({ ...ready, networkAgents: ["other"] }), "/r", "feature-builder"),
    ).toMatch(/network_agents/);
    expect(browserFor(cache({ browser: true, network: "all" }), "/r", "x")).toBe(true);
    expect(browserFor(cache(ready, false), "/r/sub", "feature-builder")).toMatch(/this repo/);
  });
});

const READY = { ready: true as const, cliPath: "/d/tools/cli.js", chrome: "/c", version: "0.0.84" };
const LAUNCH = JSON.stringify({
  configurations: [
    { name: "web", runtimeExecutable: "pnpm", runtimeArgs: ["dev", "--port", "5173"], port: 5173 },
    {
      name: "api server",
      runtimeExecutable: "node",
      runtimeArgs: ["it's.js"],
      port: 8787,
      cwd: "api",
    },
    { name: "no port", runtimeExecutable: "node", runtimeArgs: ["x.js"], cwd: "../escape" },
    { runtimeExecutable: "bad" },
  ],
});
const read = (p: string) => (p.endsWith(join(".claude", "launch.json")) ? LAUNCH : null);

describe("the run plan: codex only, ready, with network [UC2]", () => {
  const network = (scope: "off" | "delegated-agents") =>
    decideNetwork({ scope, agent: "feature-builder" });
  const base: BrowserPlanInput = {
    wanted: true,
    readiness: READY,
    network: network("delegated-agents"),
    autonomy: "worktree",
    routing: makeConfig(),
    nodePath: "/n/node",
    repoRoot: "/r",
    read,
  };

  it("not wanted: a no-op", () => {
    expect(planBrowser({ ...base, wanted: false })).toMatchObject({
      ok: true,
      browser: undefined,
      excluded: [],
    });
  });

  it("restricts routing to codex and allows only the declared dev-server ports", () => {
    const p = planBrowser(base);
    if (!p.ok) throw new Error(p.reason);
    expect(p.excluded.sort()).toEqual(["agy", "claude", "claude-alt"]);
    expect(p.browser).toEqual({
      nodePath: "/n/node",
      cliPath: "/d/tools/cli.js",
      origins: [
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:8787",
        "http://127.0.0.1:8787",
      ],
    });
  });

  it("returns to the host when not ready, without network, read-only, or only claude enabled", () => {
    const host = (over: Partial<typeof base>) => planBrowser({ ...base, ...over });
    expect(
      host({ readiness: { ready: false, reason: "Google Chrome is not installed" } }),
    ).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/Google Chrome is not installed/),
    });
    expect(host({ network: network("off") })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/needs the sandbox network \(set network: delegated-agents/),
    });
    expect(host({ autonomy: "read-only" })).toMatchObject({ ok: false });
    const claudeOnly = makeConfig();
    claudeOnly.instances = claudeOnly.instances.filter((i) => i.adapter === "claude");
    expect(host({ routing: claudeOnly })).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/only codex can/),
    });
  });

  it("any localhost port without a launch.json", () => {
    expect(allowedOrigins([])).toEqual(["http://localhost:*", "http://127.0.0.1:*"]);
    const p = planBrowser({ ...base, read: () => null });
    expect(p.ok && p.browser?.origins).toEqual(["http://localhost:*", "http://127.0.0.1:*"]);
  });
});

const RUN: BrowserRun = {
  nodePath: "/n/node",
  cliPath: "/d/cli.js",
  origins: allowedOrigins([5173]),
};

function invArgs(
  adapter: "codex" | "claude" | "antigravity",
  over: Partial<BuildInvocationWithBrowser> = {},
): BuildInvocationWithBrowser {
  return {
    task,
    target: { instance: adapter, tier: "fast", model: "m1", effort: "low" },
    autonomy: adapter === "antigravity" ? "read-only" : "worktree",
    worktree: "/w/wt",
    repoRoot: "/w",
    runDir: "/w/run/attempt-1",
    instance: { id: adapter, adapter, pool: "subscription" },
    probe: {
      ...probeResult,
      binaryPath: `/bin/${adapter}`,
      flags: ["--safe-mode"],
      features: ["hooks", "plugins"],
    },
    baseEnv: { PATH: "/bin", HOME: "/home/u" },
    browser: RUN,
    ...over,
  };
}

describe("codex gets the Dispatch-owned dispatch_browser server [SEC-browser]", () => {
  it("golden overrides: isolated headless Chrome, origins, output dir and HOME outside the worktree, allowlisted tools", () => {
    expect(browserOverrides(RUN, "worktree", "/w/run/attempt-1")).toEqual([
      "-c",
      'mcp_servers.dispatch_browser.command="/n/node"',
      "-c",
      'mcp_servers.dispatch_browser.args=["/d/cli.js","--isolated","--headless","--browser","chrome","--output-dir","/w/run/attempt-1/browser","--allowed-origins","http://localhost:5173;http://127.0.0.1:5173"]',
      "-c",
      'mcp_servers.dispatch_browser.env={HOME="/w/run/attempt-1/browser-home"}',
      "-c",
      'mcp_servers.dispatch_browser.cwd="/w/run/attempt-1/browser"',
      "-c",
      `mcp_servers.dispatch_browser.enabled_tools=[${ENABLED_TOOLS.map((t) => `"${t}"`).join(",")}]`,
      "-c",
      'mcp_servers.dispatch_browser.default_tools_approval_mode="approve"',
    ]);
    expect(ENABLED_TOOLS).not.toContain("browser_run_code_unsafe");
    expect(ENABLED_TOOLS).not.toContain("browser_file_upload");
    expect(browserOverrides(RUN, "read-only", "/w/run")).toEqual([]);
    expect(browserOverrides(undefined, "worktree", "/w/run")).toEqual([]);
  });

  it("the full argv keeps the isolation flags and never names a user profile or a CDP attach", () => {
    const inv = buildCodexInvocation(invArgs("codex"));
    const argv = inv.argv.join(" ");
    expect(inv.argv).toContain("--ignore-user-config");
    expect(argv).toContain("mcp_servers.dispatch_browser.command");
    for (const flag of [
      "--user-data-dir",
      "--cdp-endpoint",
      "--extension",
      "--profile-dir-name",
      "Application Support",
    ]) {
      expect(argv).not.toContain(flag);
    }
    expect(inv.sideEffectGuards).toContain("codex-browser-isolated");
    expect(inv.argv[inv.argv.indexOf("-s") + 1]).toBe("workspace-write");
  });

  it("claude and antigravity refuse a run with the browser (fail closed)", () => {
    expect(() => buildClaudeInvocation(invArgs("claude"))).toThrow(/only codex/);
    expect(() => buildAgyInvocation(invArgs("antigravity"))).toThrow(/only codex/);
  });

  it("a user MCP server cannot take the reserved dispatch_browser name", () => {
    const s = describeServer("dispatch_browser", "user", { command: "node", args: ["x.js"] });
    expect(s).toMatchObject({ forwardable: false, reason: REASONS.ownName });
  });
});

describe("the translation note [UC2]", () => {
  it("reads launch.json leniently: names, commands, ports, safe cwd only", () => {
    const configs = readLaunchConfigs("/r", read);
    expect(configs).toEqual([
      { name: "web", command: ["pnpm", "dev", "--port", "5173"], port: 5173, cwd: null },
      { name: "api server", command: ["node", "it's.js"], port: 8787, cwd: "api" },
      { name: "no port", command: ["node", "x.js"], port: null, cwd: null },
    ]);
    expect(launchPorts(configs)).toEqual([5173, 8787]);
    expect(readLaunchConfigs("/r", () => "not json")).toEqual([]);
    expect(readLaunchConfigs("/r", () => null)).toEqual([]);
  });

  it("maps every Claude_Browser tool and gives a start/log/stop recipe per dev server", () => {
    const note = browserNote(readLaunchConfigs("/r", read));
    expect(note.startsWith("## Browser tools in this run")).toBe(true);
    for (const pair of [
      "navigate: browser_navigate",
      "read_page, find: browser_snapshot",
      "computer: browser_click, browser_type",
      "form_input: browser_fill_form",
      "javascript_tool: browser_evaluate",
      "read_console_messages: browser_console_messages",
      "read_network_requests: browser_network_requests",
      "resize_window: browser_resize; tabs_context: browser_tabs",
    ]) {
      expect(note).toContain(pair);
    }
    expect(note).toContain('`exec pnpm dev --port 5173 > "$TMPDIR/dispatch-dev-web.log" 2>&1`');
    expect(note).toContain(
      "cd api && exec node 'it'\\''s.js' > \"$TMPDIR/dispatch-dev-apiserver.log\"",
    );
    expect(note).toContain("curl -s -o /dev/null http://127.0.0.1:5173/");
    expect(note).toContain("preview_stop: send Ctrl-C to that running command's session");
    expect(note).toContain("`kill` from another command is blocked by the sandbox");
    expect(note).toContain("WITHOUT `&`, nohup or disown");
    expect(note).toContain("Stop every dev server you started before you finish");
    expect(browserNote([])).toContain("This repo has no .claude/launch.json");
  });
});
