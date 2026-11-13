/**
 * MCP forwarding end to end with fake CLIs: a trusted repo, an approved `.mcp.json` server with a
 * `${VAR}` env reference and a custom agent that uses its tools. The Claude hook rewrites the call
 * to a handoff carrying `mcpServers`; `run --handoff` routes to the fake codex with exactly that
 * server, the variable passed by name, and the secret value nowhere in argv, state or logs.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type { RunResult } from "../../src/core/contracts.js";
import { readHookCache } from "../../src/hook/cache.js";
import { agentReport } from "../../src/hosts/claude-code/doctor.js";
import { HANDOFF_DIR } from "../../src/hosts/claude-code/handoff.js";
import { preToolUseResponse } from "../../src/hosts/claude-code/hook.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { TASK_FILE } from "../../src/runner/detach.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { resolveRunDir } from "../../src/runner/runlog.js";
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

const CANARY = "ghp_CANARYe2eforward0123456789abcdefgh";
const ref = (name: string) => `\${${name}}`;
const POLICY = `version: 1
pins:
  - id: everything-to-codex
    action: { type: provider, instance: codex }
`;
const AGENT = `---
name: gh-builder
description: edits code and files issues
tools: Read, Edit, mcp__gh__create_issue
model: claude-sonnet-5-5
---
Open an issue for anything you could not finish.
`;

function setup(consent: boolean) {
  fakes = createFakes({
    codex: [{ scenario: "success_edit", file: "math.js", content: "changed\n" }],
  });
  const h = tempHome();
  home = h;
  repo = tempRepo({
    files: {
      "math.js": "function add(a, b) {\n  return a + b;\n}\n",
      ".dispatch/config.yaml": POLICY,
      ".claude/agents/gh-builder.md": AGENT,
      ".mcp.json": JSON.stringify({
        mcpServers: {
          gh: { command: "gh-mcp", args: ["--stdio"], env: { GH_TOKEN: ref("GH_TOKEN") } },
        },
      }),
    },
  });
  const root = repo.dir;
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(
    join(home.dispatchHome, "config.yaml"),
    `version: 1\nhosts:\n  claude-code:\n    forward_mcp: ${consent}\n`,
  );
  // The user approved the project server in Claude Code.
  writeFileSync(
    join(home.home, ".claude.json"),
    JSON.stringify({ projects: { [root]: { enabledMcpjsonServers: ["gh"] } } }),
  );
  const env = { ...fakes.env, ...home.env, GH_TOKEN: CANARY };
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
        runner: { probes },
        detachCli: [process.execPath, "-e", "0"],
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env });
    return { code, out, err };
  };
  /** The parent session's Agent call for the custom agent, through the real hook. */
  const hook = () =>
    preToolUseResponse(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        cwd: root,
        tool_input: {
          description: "add sub",
          prompt: "add sub to math.js and file an issue for the docs",
          subagent_type: "gh-builder",
        },
      },
      { DISPATCH_HOME: h.dispatchHome, HOME: h.home },
      Date.now(),
    );
  return { run, hook, env, root, fakes, home: h };
}

const handoffId = (stdout: string | undefined): string => {
  const reason = JSON.parse(stdout ?? "{}").hookSpecificOutput?.permissionDecisionReason ?? "";
  return /handoff ([0-9a-f]{32})/.exec(reason)?.[1] ?? "";
};

/** Every byte Dispatch persisted: the SQLite files and the run log. */
function persisted(dispatchHome: string, r: RunResult): string {
  const db = join(dispatchHome, "state", "dispatch.db");
  const parts = [db, `${db}-wal`].filter(existsSync).map((p) => readFileSync(p, "latin1"));
  return parts.join("") + readFileSync(r.log.path, "utf8");
}

describe("MCP forwarding through a Claude Code handoff [UC2][SEC-mcp]", () => {
  it("hook → handoff with mcpServers → run --handoff → codex gets only that server, by name", async () => {
    const k = setup(true);
    expect((await k.run(["trust"])).code).toBe(0);
    // Doctor `claude-code.hard-mode` lists the MCP agent as delegated, with its server.
    const cache = readHookCache(k.home.dispatchHome);
    expect(cache && agentReport(cache, { HOME: k.home.home }, k.root)).toContain(
      "gh-builder (project): delegated (worktree, model claude-sonnet-5-5, MCP forwarded: gh)",
    );
    const res = k.hook();
    const id = handoffId(res.stdout);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const saved = JSON.parse(
      readFileSync(join(k.home.dispatchHome, HANDOFF_DIR, `${id}.json`), "utf8"),
    );
    expect(saved.mcpServers).toEqual(["gh"]);

    const { code, out, err } = await k.run(["run", "--handoff", id, "--json"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    expect(r.externalAgent?.instance).toBe("codex");
    const [call] = k.fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain('mcp_servers.gh.command="gh-mcp"');
    expect(call?.args).toContain('mcp_servers.gh.args=["--stdio"]');
    expect(call?.args).toContain('mcp_servers.gh.env_vars=["GH_TOKEN"]');
    expect(call?.args).toContain("--ignore-user-config");
    // The variable reaches the codex process by name; the value is nowhere else.
    expect(call?.env.GH_TOKEN).toBe(CANARY);
    expect(call?.args.join(" ")).not.toContain(CANARY);
    expect(call?.stdin ?? "").not.toContain(CANARY);
    expect(out).not.toContain(CANARY);
    expect(persisted(k.home.dispatchHome, r)).not.toContain(CANARY);
  });

  it("the detached path carries the handoff's mcpServers to the supervisor", async () => {
    const k = setup(true);
    await k.run(["trust"]);
    const id = handoffId(k.hook().stdout);
    const { code, out } = await k.run(["run", "--detach", "--handoff", id, "--json"]);
    expect(code).toBe(0);
    const { runId } = JSON.parse(out) as { runId: string };
    const payload = JSON.parse(
      readFileSync(join(resolveRunDir(k.root, k.home.dispatchHome, runId), TASK_FILE), "utf8"),
    );
    expect(payload.handoff.mcpServers).toEqual(["gh"]);
    expect(JSON.stringify(payload)).not.toContain(CANARY);
  });

  it("with consent off the agent stays on Claude: no rewrite, no handoff", async () => {
    const k = setup(false);
    expect((await k.run(["trust"])).code).toBe(0);
    expect(k.hook()).toEqual({ exitCode: 0 });
    const cache = readHookCache(k.home.dispatchHome);
    expect(cache && agentReport(cache, { HOME: k.home.home }, k.root)).toMatch(
      /gh-builder \(project\): stays on Claude \(.*gh/,
    );
    expect(existsSync(join(k.home.dispatchHome, HANDOFF_DIR))).toBe(false);
    expect(k.fakes.readLog({ kind: "run" })).toEqual([]);
  });
});
