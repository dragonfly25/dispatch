/**
 * Web access end to end with fake CLIs: a trusted repo and a custom agent that declares WebSearch
 * and WebFetch. The Claude hook rewrites the call to a handoff carrying `web`; `run --handoff`
 * (in process, and detached through the supervisor) routes to the fake codex with live web search.
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

const POLICY = `version: 1
pins:
  - id: everything-to-codex
    action: { type: provider, instance: codex }
`;
const AGENT = `---
name: idea-researcher
description: researches an idea on the web
tools: Read, Grep, WebSearch, WebFetch
---
Search the web, read the sources, report what you found.
`;

function setup(globalYaml = "version: 1\n") {
  fakes = createFakes({ codex: [{ scenario: "success_edit", files: {} }] });
  const h = tempHome();
  home = h;
  repo = tempRepo({
    files: { ".dispatch/config.yaml": POLICY, ".claude/agents/idea-researcher.md": AGENT },
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
        runner: { probes },
        detachCli: [process.execPath, "-e", "0"],
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env });
    return { code, out, err };
  };
  const hook = () =>
    preToolUseResponse(
      {
        session_id: "s1",
        hook_event_name: "PreToolUse",
        tool_name: "Agent",
        cwd: root,
        tool_input: {
          description: "research",
          prompt: "find prior art for a CLI that routes agent tasks",
          subagent_type: "idea-researcher",
        },
      },
      { DISPATCH_HOME: h.dispatchHome, HOME: h.home },
      Date.now(),
    );
  return { run, hook, root, fakes, home: h };
}

const handoffId = (stdout: string | undefined): string => {
  const reason = JSON.parse(stdout ?? "{}").hookSpecificOutput?.permissionDecisionReason ?? "";
  return /handoff ([0-9a-f]{32})/.exec(reason)?.[1] ?? "";
};

describe("web access through a Claude Code handoff [UC2]", () => {
  it("hook → handoff with web → run --handoff → codex gets live web search", async () => {
    const k = setup();
    expect((await k.run(["trust"])).code).toBe(0);
    const cache = readHookCache(k.home.dispatchHome);
    expect(cache && agentReport(cache, { HOME: k.home.home }, k.root)).toContain(
      "idea-researcher (project): delegated (read-only, web)",
    );
    const id = handoffId(k.hook().stdout);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const saved = JSON.parse(
      readFileSync(join(k.home.dispatchHome, HANDOFF_DIR, `${id}.json`), "utf8"),
    );
    expect(saved).toMatchObject({ web: true, webFetch: true, autonomy: "read-only" });

    const { code, out, err } = await k.run(["run", "--handoff", id, "--json"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    const [call] = k.fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain('web_search="live"');
    expect(call?.args[(call?.args.indexOf("-s") ?? 0) + 1]).toBe("read-only");
    expect(call?.args).toContain("--ignore-user-config");
  });

  it("the detached path carries the web flag to the supervisor, which passes it on", async () => {
    const k = setup();
    await k.run(["trust"]);
    const id = handoffId(k.hook().stdout);
    const { code, out } = await k.run(["run", "--detach", "--handoff", id, "--json"]);
    expect(code).toBe(0);
    const { runId } = JSON.parse(out) as { runId: string };
    const runDir = resolveRunDir(k.root, k.home.dispatchHome, runId);
    const payload = JSON.parse(readFileSync(join(runDir, TASK_FILE), "utf8"));
    expect(payload.handoff).toMatchObject({ web: true, webFetch: true });
    await k.run(["__supervise", runId, "--run-dir", runDir]);
    const [call] = k.fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain('web_search="live"');
  });

  it("with forward_web false the agent stays on Claude: no rewrite, no handoff", async () => {
    const k = setup("version: 1\nhosts:\n  claude-code:\n    forward_web: false\n");
    expect((await k.run(["trust"])).code).toBe(0);
    expect(k.hook()).toEqual({ exitCode: 0 });
    expect(existsSync(join(k.home.dispatchHome, HANDOFF_DIR))).toBe(false);
    expect(k.fakes.readLog({ kind: "run" })).toEqual([]);
  });
});
