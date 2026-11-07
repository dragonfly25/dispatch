import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "../../../src/core/contracts.js";
import { type HookCache, type PolicySummary, writeHookCache } from "../../../src/hook/cache.js";
import {
  CLAUDE_AGENT_MATCHER,
  claudeRedirects,
  hookHandlers,
  policyText,
  preToolUseResponse,
  rewriteHeader,
} from "../../../src/hosts/claude-code/hook.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

const FIXTURE = resolve(import.meta.dirname, "../../fixtures/hosts/claude_pre_tool_use_agent.json");

const HARD: Partial<PolicySummary> = {
  hardInterception: true,
  claudeHard: true,
  claudeIntercept: ["general-purpose"],
};

function cacheFor(root: string, policy: Partial<PolicySummary> = HARD): HookCache {
  return {
    version: 1,
    writtenAt: "2026-11-07T00:00:00.000Z",
    trustedRepos: [{ root, policyHash: null }],
    policy: { profile: "balance", hardMode: true, summary: "Tests go to codex.", ...policy },
  };
}

/** A trusted repo with the given policy and the recorded-shape PreToolUse input for it. */
function setup(policy: Partial<PolicySummary> = HARD): { input: HookInput; env: Env } {
  h = tempHome();
  const repo = join(h.home, "work", "repo");
  mkdirSync(repo, { recursive: true });
  writeHookCache(h.dispatchHome, cacheFor(repo, policy));
  const raw = readFileSync(FIXTURE, "utf8").replace("<REPO>", repo);
  return { input: JSON.parse(raw) as HookInput, env: { DISPATCH_HOME: h.dispatchHome } };
}

type Env = Record<string, string>;

const withAgent = (input: HookInput, toolInput: Record<string, unknown>): HookInput => ({
  ...input,
  tool_input: { ...(input.tool_input as object), ...toolInput },
});

const SILENT = { exitCode: 0 };

function rewritten(res: { stdout?: string }) {
  const out = JSON.parse(res.stdout ?? "");
  expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
  return out.hookSpecificOutput;
}

describe("claude-code PreToolUse hard mode [UC2]", () => {
  it("rewrites a general-purpose Agent call to dispatch:dispatch, keeping every other field", () => {
    const { input, env } = setup();
    const res = preToolUseResponse(
      withAgent(input, { model: "haiku", run_in_background: true }),
      env,
    );
    expect(res.exitCode).toBe(0);
    expect(res.stdout?.endsWith("\n")).toBe(true);
    const o = rewritten(res);
    expect(o.hookEventName).toBe("PreToolUse");
    expect(o.permissionDecision).toBe("allow");
    expect(o.permissionDecisionReason).toContain("general-purpose");
    expect(o.updatedInput).toEqual({
      description: "Answer 2+2 question",
      model: "haiku",
      run_in_background: true,
      subagent_type: "dispatch:dispatch",
      prompt: `${rewriteHeader("general-purpose")}\n\nWhat is 2+2? Reply with just the answer.`,
    });
  });

  it("the legacy Task tool name and a missing or empty subagent_type count as general-purpose", () => {
    const { input, env } = setup();
    const noType = { ...(input.tool_input as Record<string, unknown>) };
    delete noType.subagent_type;
    for (const i of [
      { ...input, tool_name: "Task" },
      { ...input, tool_input: noType },
      withAgent(input, { subagent_type: "  " }),
      withAgent(input, { subagent_type: null }),
    ]) {
      expect(rewritten(preToolUseResponse(i, env)).updatedInput.subagent_type).toBe(
        "dispatch:dispatch",
      );
    }
    expect(CLAUDE_AGENT_MATCHER.split("|")).toEqual(["Agent", "Task"]);
  });

  it("never touches the Dispatch sub-agent or types outside the intercept list", () => {
    const { input, env } = setup();
    for (const t of ["dispatch:dispatch", "dispatch", "Explore", "Plan", "feature-builder-x"]) {
      expect(preToolUseResponse(withAgent(input, { subagent_type: t }), env)).toEqual(SILENT);
    }
  });

  it('"*" intercepts general-purpose and eligible agents, never built-ins without a file', () => {
    const { input, env } = setup({ ...HARD, claudeIntercept: ["*"] });
    const o = rewritten(preToolUseResponse(input, env));
    expect(o.updatedInput.prompt).toContain('"general-purpose" sub-agent task was redirected');
    for (const t of ["Explore", "feature-builder-x", "dispatch:dispatch"]) {
      expect(preToolUseResponse(withAgent(input, { subagent_type: t }), env)).toEqual(SILENT);
    }
  });

  it("a custom intercept list replaces the default", () => {
    const { input, env } = setup({ ...HARD, claudeIntercept: ["Explore"] });
    expect(preToolUseResponse(input, env)).toEqual(SILENT);
  });

  it.each<[string, Partial<PolicySummary>]>([
    ["hosts.claude-code.hard: false", { ...HARD, claudeHard: false }],
    ["policy off (nothing delegated)", { ...HARD, hardInterception: false }],
    ["cache from before Claude hard mode", { hardInterception: true }],
  ])("%s → untouched", (_n, policy) => {
    const { input, env } = setup(policy);
    expect(preToolUseResponse(input, env)).toEqual(SILENT);
  });

  it("untrusted repo, DISPATCH_DEPTH, other tools, malformed input → silent", () => {
    const { input, env } = setup();
    expect(preToolUseResponse({ ...input, cwd: "/definitely/not/trusted" }, env)).toEqual(SILENT);
    expect(preToolUseResponse(input, { ...env, DISPATCH_DEPTH: "1" })).toEqual(SILENT);
    expect(preToolUseResponse(input, {})).toEqual(SILENT);
    expect(preToolUseResponse({ ...input, tool_name: "Bash" }, env)).toEqual(SILENT);
    expect(preToolUseResponse({ ...input, tool_name: undefined }, env)).toEqual(SILENT);
    for (const ti of [undefined, null, "x", [1], {}, { prompt: "" }, { prompt: 5 }]) {
      expect(preToolUseResponse({ ...input, tool_input: ti }, env)).toEqual(SILENT);
    }
    expect(preToolUseResponse(withAgent(input, { subagent_type: 7 }), env)).toEqual(SILENT);
    writeFileSync(join(h.dispatchHome, "hook-cache.json"), "{garbage");
    expect(preToolUseResponse(input, env)).toEqual(SILENT);
  });

  it("the handler map serves PreToolUse and never throws", async () => {
    const old = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = "/nonexistent-dispatch-home";
    try {
      expect(await hookHandlers.PreToolUse?.({ tool_name: "Agent", cwd: 5 } as never)).toEqual(
        SILENT,
      );
      expect(await hookHandlers.PreToolUse?.(null as never)).toEqual(SILENT);
    } finally {
      if (old === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = old;
    }
  });
});

describe("claude-code SessionStart wording with hard mode [UC2]", () => {
  it("names the redirected sub-agent types only when hard mode applies", () => {
    const on = policyText(cacheFor("/r"), "/l");
    expect(on).toContain(
      'Sub-agent calls (Agent tool) of type "general-purpose" are redirected to Dispatch in this repository;',
    );
    expect(on).toContain("instead of being done in this session, unless the user says otherwise");
    expect(on).not.toContain("Exception:");
    const auto = policyText(cacheFor("/r", { ...HARD, claudeIntercept: ["auto"] }), "/l");
    expect(auto).toContain("of your own sub-agents (.claude/agents) that Dispatch can run");
    expect(auto).toContain("Exception: when a redirected custom sub-agent's run succeeds");
    expect(
      policyText(cacheFor("/r", { ...HARD, claudeIntercept: ["*"], claudeAutoApply: false }), "/l"),
    ).not.toContain("Exception:");
    for (const p of [
      { ...HARD, claudeHard: false },
      { ...HARD, hardInterception: false },
      { ...HARD, claudeIntercept: ["dispatch:dispatch"] },
    ]) {
      expect(policyText(cacheFor("/r", p), "/l")).not.toContain("redirected");
    }
    expect(claudeRedirects(cacheFor("/r", { hardInterception: true }))).toBe(false);
  });
});

const dist = resolve(import.meta.dirname, "../../../dist/hook.mjs");

function runDist(env: Env, input: string) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [dist, "claude-code", "PreToolUse"], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", ...env },
  });
  return { ms: performance.now() - t0, code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!existsSync(dist))("dist/hook.mjs claude-code PreToolUse [UC2][UC9]", () => {
  it("rewrites the recorded-shape Agent call under a minimal env", () => {
    const { input, env } = setup();
    const r = runDist(env, JSON.stringify(input));
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(JSON.parse(r.out).hookSpecificOutput.updatedInput.subagent_type).toBe(
      "dispatch:dispatch",
    );
    expect(r.ms).toBeLessThan(1000);
  });

  it("malformed stdin and untrusted repos → no output, exit 0", () => {
    const { input, env } = setup();
    for (const body of ["{nope", "[]", "", JSON.stringify({ ...input, cwd: "/tmp" })]) {
      expect(runDist(env, body)).toMatchObject({ code: 0, out: "", err: "" });
    }
  });

  // [perf] Timing-sensitive, so opt-in like the SessionStart budget test: DISPATCH_PERF=1.
  it.runIf(process.env.DISPATCH_PERF === "1")("p95 latency < 80 ms over 20 runs", () => {
    const { input, env } = setup();
    const body = JSON.stringify(input);
    runDist(env, body); // warm the file cache
    const times = Array.from({ length: 20 }, () => runDist(env, body).ms);
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1] as number;
    expect(p95).toBeLessThan(80);
  });
});
