/**
 * The isolated browser end to end with fake CLIs: a trusted repo with a `.claude/launch.json` and a
 * builder agent that lists `mcp__Claude_Browser__*` tools. With the browser ready and the sandbox
 * network on, the Claude hook writes a handoff carrying `browser`, and `run --handoff` routes to
 * the fake codex with the `dispatch_browser` server and the translation note. Otherwise the agent
 * stays on Claude. Readiness (install + Chrome) is injected: no npm, no Chrome.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type { RunResult } from "../../src/core/contracts.js";
import { HOOK_CACHE_FILE, readHookCache } from "../../src/hook/cache.js";
import { agentReport } from "../../src/hosts/claude-code/doctor.js";
import { HANDOFF_DIR } from "../../src/hosts/claude-code/handoff.js";
import { preToolUseResponse } from "../../src/hosts/claude-code/hook.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { probeResult } from "../fixtures/contracts.js";
import {
  createFakes,
  type FakesContext,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
afterEach(() => {
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = undefined;
});

const POLICY = `version: 1
pins:
  - id: everything-to-codex
    action: { type: provider, instance: codex }
`;
const AGENT = `---
name: feature-builder
description: builds a feature and checks it in the browser
tools: Read, Edit, Write, Bash, mcp__Claude_Browser__preview_start, mcp__Claude_Browser__navigate, mcp__Claude_Browser__read_page
---
Build the feature, start the preview and check the page.
`;
const LAUNCH = JSON.stringify({
  version: "0.0.1",
  configurations: [
    { name: "web", runtimeExecutable: "node", runtimeArgs: ["server.mjs"], port: 47831 },
  ],
});
const ON = "version: 1\nnetwork: delegated-agents\nhosts:\n  claude-code:\n    browser: true\n";

function setup(globalYaml = ON) {
  fakes = createFakes({ codex: [{ scenario: "success_edit", files: {} }] });
  const h = tempHome();
  home = h;
  repo = tempRepo({
    files: {
      ".dispatch/config.yaml": POLICY,
      ".claude/agents/feature-builder.md": AGENT,
      ".claude/launch.json": LAUNCH,
    },
  });
  const root = repo.dir;
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), globalYaml);
  const env = { ...fakes.env, ...home.env };
  const probes = new ProbeCache();
  probes.set("codex", "codex", {
    ...probeResult,
    binaryPath: fakes.bin("codex"),
    features: ["hooks", "plugins", "apps", "memories"],
  });
  const run = async (args: string[]) => {
    let out = "";
    let err = "";
    const io = {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        err += t;
      },
    };
    const program = buildProgram(
      io,
      {},
      {},
      {
        cwd: root,
        env,
        quotaReaders: new QuotaReaderRegistry(),
        runner: {
          probes,
          nodePath: "/n/node",
          browserReadiness: () => ({
            ready: true,
            cliPath: "/d/tools/playwright-mcp/cli.js",
            chrome: "/c",
            version: "0.0.84",
          }),
        },
        detachCli: [process.execPath, "-e", "0"],
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env });
    return { code, out, err };
  };
  /** Marks the cached browser ready, as the writer does once installed with Chrome present. */
  const ready = () => {
    const path = join(h.dispatchHome, HOOK_CACHE_FILE);
    const c = JSON.parse(readFileSync(path, "utf8"));
    c.policy.browser = true;
    delete c.policy.browserReason;
    writeFileSync(path, JSON.stringify(c), { mode: 0o600 });
  };
  const hook = () =>
    preToolUseResponse(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        cwd: root,
        tool_input: {
          description: "build",
          prompt: "add a hello page and check it",
          subagent_type: "feature-builder",
        },
      },
      { DISPATCH_HOME: h.dispatchHome, HOME: h.home },
      Date.now(),
    );
  return { run, hook, ready, root, fakes, home: h };
}

const handoffId = (stdout: string | undefined): string => {
  const reason = JSON.parse(stdout ?? "{}").hookSpecificOutput?.permissionDecisionReason ?? "";
  return /handoff ([0-9a-f]{32})/.exec(reason)?.[1] ?? "";
};

describe("the isolated browser through a Claude Code handoff [UC2]", () => {
  it("hook → handoff with browser → run --handoff → codex gets dispatch_browser and the note", async () => {
    const k = setup();
    expect((await k.run(["trust"])).code).toBe(0);
    const written = readHookCache(k.home.dispatchHome);
    expect(written?.policy).toMatchObject({ browser: false, network: "delegated-agents" });
    expect(written?.policy.browserReason).toMatch(/not installed/);
    k.ready();
    const cache = readHookCache(k.home.dispatchHome);
    expect(cache && agentReport(cache, { HOME: k.home.home }, k.root)).toContain(
      "feature-builder (project): delegated (worktree, isolated browser)",
    );
    const id = handoffId(k.hook().stdout);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const saved = JSON.parse(
      readFileSync(join(k.home.dispatchHome, HANDOFF_DIR, `${id}.json`), "utf8"),
    );
    expect(saved).toMatchObject({ browser: true, autonomy: "worktree", mcpServers: [] });

    const { code, out, err } = await k.run(["run", "--handoff", id, "--json"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    const [call] = k.fakes.readLog({ cli: "codex", kind: "run" });
    const args = call?.args ?? [];
    expect(args).toContain('mcp_servers.dispatch_browser.command="/n/node"');
    const serverArgs = args.find((a) => a.startsWith("mcp_servers.dispatch_browser.args="));
    expect(serverArgs).toContain('"--isolated","--headless","--browser","chrome"');
    expect(serverArgs).toContain(
      '"--allowed-origins","http://localhost:47831;http://127.0.0.1:47831"',
    );
    expect(args.find((a) => a.includes("enabled_tools"))).not.toContain("run_code_unsafe");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(args[args.indexOf("-s") + 1]).toBe("workspace-write");
    const stdin = (call as { stdin?: string } | undefined)?.stdin ?? "";
    expect(stdin).toContain("## Browser tools in this run");
    expect(stdin).toContain("exec node server.mjs");
  });

  it("without the sandbox network the agent stays on Claude: no rewrite, no handoff", async () => {
    const k = setup("version: 1\nhosts:\n  claude-code:\n    browser: true\n");
    expect((await k.run(["trust"])).code).toBe(0);
    k.ready();
    const cache = readHookCache(k.home.dispatchHome);
    expect(cache && agentReport(cache, { HOME: k.home.home }, k.root)).toContain(
      "feature-builder (project): stays on Claude (uses Claude_Browser; needs network: set network: delegated-agents)",
    );
    expect(k.hook()).toEqual({ exitCode: 0 });
    expect(existsSync(join(k.home.dispatchHome, HANDOFF_DIR))).toBe(false);
  });

  it("with the browser switched off the agent stays on Claude", async () => {
    const k = setup("version: 1\nnetwork: delegated-agents\n");
    expect((await k.run(["trust"])).code).toBe(0);
    expect(k.hook()).toEqual({ exitCode: 0 });
    expect(k.fakes.readLog({ kind: "run" })).toEqual([]);
  });
});
