/** Claude hard mode for the user's own sub-agents: parser, lookup, eligibility, hook, handoffs. */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "../../../src/core/contracts.js";
import { type PolicySummary, writeHookCache } from "../../../src/hook/cache.js";
import {
  type AgentDefinition,
  agentDirs,
  eligibility,
  findAgent,
  listAgents,
  MAX_AGENT_BODY,
  mcpServerOf,
  parseAgentFile,
} from "../../../src/hosts/claude-code/agents.js";
import { agentReport } from "../../../src/hosts/claude-code/doctor.js";
import {
  addPassthrough,
  consumePassthrough,
  dispatchEffort,
  gcHandoffs,
  gcPassthrough,
  HANDOFF_DIR,
  type HandoffError,
  loadHandoff,
  PASSTHROUGH_CAP,
  PASSTHROUGH_FILE,
  passthroughKey,
} from "../../../src/hosts/claude-code/handoff.js";
import { handoffPrompt, preToolUseResponse } from "../../../src/hosts/claude-code/hook.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome;
afterEach(() => h?.cleanup());

const NOW = Date.parse("2026-11-07T12:00:00.000Z");

const agentText = (front: string, body = "Be careful.\nRead before you write.") =>
  `---\n${front}\n---\n${body}\n`;

const DEF = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "x",
  description: null,
  model: null,
  effort: null,
  tools: null,
  body: "b",
  ...over,
});

describe("agent frontmatter parser [UC2]", () => {
  it("reads comma, inline and block tool lists, quotes and block scalars", () => {
    const comma = parseAgentFile(
      agentText(
        'name: reader\ndescription: "Reads code"\ntools: Read, Grep, Bash(git:*)\nmodel: claude-sonnet-5-5\neffort: xhigh',
      ),
    );
    expect(comma).toEqual({
      name: "reader",
      description: "Reads code",
      model: "claude-sonnet-5-5",
      effort: "xhigh",
      tools: ["Read", "Grep", "Bash(git:*)"],
      body: "Be careful.\nRead before you write.",
    });
    const block = parseAgentFile(
      agentText("name: b\ndescription: |\n  line one\n  line two\ntools:\n  - Read\n  - 'Edit'"),
    );
    expect(block?.description).toBe("line one\nline two");
    expect(block?.tools).toEqual(["Read", "Edit"]);
    expect(parseAgentFile(agentText("name: c\ntools: [Read, Glob]"))?.tools).toEqual([
      "Read",
      "Glob",
    ]);
    expect(
      parseAgentFile(agentText("# comment\n\nname: d\ndescription: >\n  a\n  b")),
    ).toMatchObject({ name: "d", description: "a b" });
  });

  it("missing fields are null; `*` or an empty list means every tool", () => {
    expect(parseAgentFile(agentText("description: x", ""))).toEqual({
      name: null,
      description: "x",
      model: null,
      effort: null,
      tools: null,
      body: "",
    });
    expect(parseAgentFile(agentText("tools: '*'"))?.tools).toBeNull();
    expect(parseAgentFile(agentText("tools: []"))?.tools).toBeNull();
  });

  it("malformed files are refused", () => {
    for (const bad of [
      "no frontmatter",
      "---\nname: x\n",
      "---\nname x\n---\nbody",
      "---\n: nope\n---\n",
    ]) {
      expect(parseAgentFile(bad), bad).toBeNull();
    }
    expect(parseAgentFile("﻿---\r\nname: crlf\r\n---\r\nbody")?.name).toBe("crlf");
  });
});

describe("agent lookup [UC2]", () => {
  function dirs() {
    h = tempHome();
    const repo = join(h.home, "repo");
    const project = join(repo, ".claude", "agents");
    const user = join(h.home, ".claude", "agents");
    mkdirSync(project, { recursive: true });
    mkdirSync(user, { recursive: true });
    return { repo, project, user, d: agentDirs(repo, { HOME: h.home }) };
  }

  it("finds by file name, then by frontmatter name; project before user", () => {
    const { project, user, d } = dirs();
    writeFileSync(join(project, "reader.md"), agentText("name: reader\ntools: Read"));
    writeFileSync(join(user, "reader.md"), agentText("name: reader\ntools: Bash"));
    writeFileSync(join(user, "other-file.md"), agentText("name: builder\ntools: Edit"));
    writeFileSync(join(project, "renamed.md"), agentText("name: not-renamed"));
    expect(findAgent("reader", d)).toMatchObject({ source: "project", def: { tools: ["Read"] } });
    expect(findAgent("builder", d)).toMatchObject({
      source: "user",
      path: join(user, "other-file.md"),
    });
    expect(findAgent("renamed", d)).toBeNull(); // its name: says otherwise
    expect(listAgents(d).map((a) => `${a.name}:${a.source}`)).toEqual([
      "reader:project",
      "not-renamed:project",
      "builder:user",
    ]);
  });

  it("built-ins without a file, plugin agents, odd names and oversized files are not found", () => {
    const { project, d } = dirs();
    writeFileSync(join(project, "big.md"), agentText("name: big", "x".repeat(70 * 1024)));
    for (const t of ["Explore", "Plan", "plugin:agent", "../escape", "", "big"]) {
      expect(findAgent(t, d), t).toBeNull();
    }
  });

  it("CLAUDE_CONFIG_DIR (absolute) replaces ~/.claude for user agents", () => {
    expect(agentDirs("/r", { HOME: "/h", CLAUDE_CONFIG_DIR: "/alt" })).toEqual({
      project: join("/r", ".claude", "agents"),
      user: join("/alt", "agents"),
    });
    expect(agentDirs(null, { CLAUDE_CONFIG_DIR: "rel" })).toEqual({ project: null, user: null });
  });
});

describe("agent eligibility [UC2]", () => {
  it.each<[string, Partial<AgentDefinition>, object, RegExp | Record<string, unknown>]>([
    ["read-only agent", { tools: ["Read", "Grep", "Glob", "LS"] }, {}, { autonomy: "read-only" }],
    ["editor agent", { tools: ["Read", "Edit", "Bash(npm test)"] }, {}, { autonomy: "worktree" }],
    ["no tools list", { tools: null }, {}, { autonomy: "worktree", mcpServers: [] }],
    ["web tools, web forwarding off", { tools: ["Read", "WebFetch"] }, {}, /forward_web/],
    [
      "web search only, delegated with web",
      { tools: ["Read", "WebSearch"] },
      { webSupported: true },
      { autonomy: "read-only", web: true, webFetch: false },
    ],
    [
      "web fetch, delegated with web",
      { tools: ["Read", "Write", "WebSearch", "WebFetch(domain:example.com)"] },
      { webSupported: true },
      { autonomy: "worktree", web: true, webFetch: true },
    ],
    [
      "web + Claude_Browser stays on Claude",
      { tools: ["WebSearch", "WebFetch", "mcp__Claude_Browser__navigate"] },
      { webSupported: true },
      /Claude_Browser/,
    ],
    ["MCP not forwardable", { tools: ["mcp__github__get_issue"] }, {}, /github/],
    [
      "MCP forwardable",
      { tools: ["Edit", "mcp__github__get_issue", "mcp__db"] },
      { forwardableMcp: ["github", "db"] },
      { autonomy: "worktree", mcpServers: ["db", "github"] },
    ],
    [
      "Claude_Browser",
      { tools: ["Read", "mcp__Claude_Browser__navigate"] },
      { forwardableMcp: ["Claude_Browser"] },
      /Claude_Browser/,
    ],
    ["unknown tool", { tools: ["Read", "Agent"] }, {}, /Agent/],
    ["oversized body", { body: "x".repeat(MAX_AGENT_BODY + 1) }, {}, /32 KB/],
  ])("%s", (_n, def, opts, want) => {
    const v = eligibility(DEF(def), opts);
    if (want instanceof RegExp) {
      expect(v.eligible).toBe(false);
      expect(v.eligible ? "" : v.reason).toMatch(want);
    } else expect(v).toMatchObject({ eligible: true, ...want });
  });

  it("mcp server names and effort mapping", () => {
    expect(mcpServerOf("mcp__a__b__c")).toBe("a");
    expect(mcpServerOf("mcp__solo")).toBe("solo");
    expect(mcpServerOf("Read")).toBeNull();
    expect(["low", "medium", "high", "xhigh", "max", "weird", null].map(dispatchEffort)).toEqual([
      "low",
      "medium",
      "high",
      "high",
      "high",
      null,
      null,
    ]);
  });
});

// ---------------------------------------------------------------------------
// Hook rewrite
// ---------------------------------------------------------------------------

const HARD: Partial<PolicySummary> = {
  hardInterception: true,
  claudeHard: true,
  claudeIntercept: ["auto"],
};

interface World {
  repo: string;
  agents: string;
  env: Record<string, string>;
  input: (type: string, prompt?: string) => HookInput;
}

function world(policy: Partial<PolicySummary> = HARD): World {
  h = tempHome();
  const repo = join(h.home, "work", "repo");
  const agents = join(repo, ".claude", "agents");
  mkdirSync(agents, { recursive: true });
  writeHookCache(h.dispatchHome, {
    version: 1,
    writtenAt: "2026-11-07T00:00:00.000Z",
    trustedRepos: [{ root: repo, policyHash: null }],
    policy: { profile: "balance", hardMode: true, summary: "s", ...policy },
  });
  writeFileSync(
    join(agents, "reader.md"),
    agentText(
      "name: reader\ndescription: reads\ntools: Read, Grep\nmodel: claude-sonnet-5-5\neffort: max",
    ),
  );
  writeFileSync(
    join(agents, "browser.md"),
    agentText("name: browser\ntools: Read, mcp__Claude_Browser__navigate"),
  );
  return {
    repo,
    agents,
    env: { DISPATCH_HOME: h.dispatchHome, HOME: h.home },
    input: (type, prompt = "Summarize src/") => ({
      session_id: "s1",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      cwd: join(repo, "sub"),
      tool_input: { description: "summary", prompt, subagent_type: type, run_in_background: true },
    }),
  };
}

const out = (res: { stdout?: string }) => JSON.parse(res.stdout ?? "").hookSpecificOutput;
const SILENT = { exitCode: 0 };
const handoffs = () => {
  const dir = join(h.dispatchHome, HANDOFF_DIR);
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("claude-code PreToolUse for custom agents [UC2][SEC-handoff]", () => {
  it("writes a 0600 handoff and points the relay at it, keeping the other fields", () => {
    const w = world();
    const o = out(preToolUseResponse(w.input("reader"), w.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(o.updatedInput).toEqual({
      description: "summary",
      run_in_background: true,
      subagent_type: "dispatch:dispatch",
      prompt: handoffPrompt(id, "reader"),
    });
    expect(o.updatedInput.prompt).not.toContain("Summarize src/");
    const file = join(h.dispatchHome, HANDOFF_DIR, `${id}.json`);
    // Windows: mode bits do not reflect ACLs.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    const loaded = loadHandoff(h.dispatchHome, id, NOW + 1000);
    expect(loaded).toEqual({
      version: 1,
      createdAt: new Date(NOW).toISOString(),
      agent: { name: "reader", source: "project", path: join(w.agents, "reader.md") },
      instructions: "Be careful.\nRead before you write.",
      task: "Summarize src/",
      description: "summary",
      model: "claude-sonnet-5-5",
      effort: "high",
      autonomy: "read-only",
      mcpServers: [],
      web: false,
      webFetch: false,
      autoApply: true,
      passthroughKey: passthroughKey("reader", "Summarize src/"),
    });
    expect(existsSync(file)).toBe(false); // used once
  });

  it("ineligible, unknown, excluded or not-listed agents stay native and write nothing", () => {
    const w = world();
    for (const t of ["browser", "Explore", "nobody", "plugin:reader"]) {
      expect(preToolUseResponse(w.input(t), w.env, NOW), t).toEqual(SILENT);
    }
    const ex = world({ ...HARD, claudeExclude: ["reader"] });
    expect(preToolUseResponse(ex.input("reader"), ex.env, NOW)).toEqual(SILENT);
    const listed = world({ ...HARD, claudeIntercept: ["general-purpose"] });
    expect(preToolUseResponse(listed.input("reader"), listed.env, NOW)).toEqual(SILENT);
    expect(handoffs()).toEqual([]);
    const allow = world({ ...HARD, claudeIntercept: ["reader"] });
    expect(
      out(preToolUseResponse(allow.input("reader"), allow.env, NOW)).updatedInput,
    ).toMatchObject({ subagent_type: "dispatch:dispatch" });
    const off = world({ ...HARD, claudeAutoApply: false });
    const o = out(preToolUseResponse(off.input("reader"), off.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    expect(loadHandoff(h.dispatchHome, id, NOW).autoApply).toBe(false);
  });

  it("an MCP agent is delegated only when its server is forwardable", () => {
    const w = world();
    writeFileSync(join(w.agents, "gh.md"), agentText("name: gh\ntools: Read, mcp__github__issue"));
    expect(preToolUseResponse(w.input("gh"), w.env, NOW)).toEqual(SILENT);
    // A forwardable server without the consent flag still stays on Claude [SEC-mcp].
    const noConsent = world({ ...HARD, forwardableMcp: ["github"] });
    writeFileSync(
      join(noConsent.agents, "gh.md"),
      agentText("name: gh\ntools: Read, mcp__github__issue"),
    );
    expect(preToolUseResponse(noConsent.input("gh"), noConsent.env, NOW)).toEqual(SILENT);
    const f = world({ ...HARD, forwardMcp: true, forwardableMcp: ["github"] });
    writeFileSync(join(f.agents, "gh.md"), agentText("name: gh\ntools: Read, mcp__github__issue"));
    const o = out(preToolUseResponse(f.input("gh"), f.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    expect(loadHandoff(h.dispatchHome, id, NOW).mcpServers).toEqual(["github"]);
  });

  it("a web agent is delegated with web; forward_web false (global or repo) keeps it [UC2]", () => {
    const tools = "name: researcher\ntools: Read, WebSearch, WebFetch";
    const w = world();
    writeFileSync(join(w.agents, "researcher.md"), agentText(tools));
    const o = out(preToolUseResponse(w.input("researcher"), w.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    expect(loadHandoff(h.dispatchHome, id, NOW)).toMatchObject({
      autonomy: "read-only",
      web: true,
      webFetch: true,
    });
    const off = world({ ...HARD, forwardWeb: false });
    writeFileSync(join(off.agents, "researcher.md"), agentText(tools));
    expect(preToolUseResponse(off.input("researcher"), off.env, NOW)).toEqual(SILENT);
    // A trusted repo whose merged config says `forward_web: false` keeps it on Claude too.
    const repoOff = world();
    writeHookCache(h.dispatchHome, {
      version: 1,
      writtenAt: "2026-11-07T00:00:00.000Z",
      trustedRepos: [{ root: repoOff.repo, policyHash: null, forwardWeb: false }],
      policy: { profile: "balance", hardMode: true, summary: "s", ...HARD },
    });
    writeFileSync(join(repoOff.agents, "researcher.md"), agentText(tools));
    expect(preToolUseResponse(repoOff.input("researcher"), repoOff.env, NOW)).toEqual(SILENT);
    expect(handoffs()).toEqual([]);
  });

  it("a passthrough entry lets exactly one identical retry through", () => {
    const w = world();
    addPassthrough(h.dispatchHome, passthroughKey("reader", "Summarize src/"), NOW);
    expect(preToolUseResponse(w.input("reader"), w.env, NOW + 1000)).toEqual(SILENT);
    expect(handoffs()).toEqual([]);
    expect(out(preToolUseResponse(w.input("reader"), w.env, NOW + 2000))).toBeDefined();
    // A different prompt never matched the entry.
    addPassthrough(h.dispatchHome, passthroughKey("reader", "Summarize src/"), NOW);
    expect(out(preToolUseResponse(w.input("reader", "other"), w.env, NOW))).toBeDefined();
  });

  it("the doctor lists which agents are delegated and why the others stay", () => {
    const w = world();
    const cache = {
      version: 1 as const,
      writtenAt: "x",
      trustedRepos: [],
      policy: { profile: "p", hardMode: true, summary: "s", ...HARD, claudeExclude: ["x"] },
    };
    writeFileSync(join(w.agents, "x.md"), agentText("name: x"));
    writeFileSync(join(w.agents, "web.md"), agentText("name: web\ntools: Read, WebSearch"));
    mkdirSync(join(w.repo, ".git"));
    const text = agentReport(cache, { HOME: join(h.home, "nobody") }, join(w.repo));
    expect(text).toContain(
      "browser (project): stays on Claude (uses Claude_Browser; the isolated browser is off (hosts.claude-code.browser))",
    );
    expect(text).toContain("reader (project): delegated (read-only, model claude-sonnet-5-5)");
    expect(text).toContain("x (project): stays on Claude (not in hosts.claude-code.intercept");
    expect(text).toContain("web (project): delegated (read-only, web)");
    const off = { ...cache, policy: { ...cache.policy, forwardWeb: false } };
    expect(agentReport(off, { HOME: join(h.home, "nobody") }, w.repo)).toContain(
      "web (project): stays on Claude (uses WebSearch, and web forwarding is off",
    );
    expect(agentReport(cache, {}, "/")).toBe("");
  });
});

describe("handoff loader and passthrough file [SEC-handoff]", () => {
  let w: World;
  function written(): { id: string; file: string } {
    const o = out(preToolUseResponse(w.input("reader"), w.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    return { id, file: join(h.dispatchHome, HANDOFF_DIR, `${id}.json`) };
  }
  const refuse = (id: string, now = NOW, re: RegExp = /./) =>
    expect(() => loadHandoff(h.dispatchHome, id, now)).toThrow(
      expect.objectContaining({ message: expect.stringMatching(re) }) as HandoffError,
    );

  it("refuses bad ids, missing, old, world-readable, symlinked and malformed handoffs", () => {
    w = world();
    refuse("../../etc/passwd", NOW, /not a handoff id/);
    const a = written();
    refuse("0".repeat(32), NOW, /not found/);
    refuse(a.id, NOW + 61 * 60 * 1000, /older than 1 h/);
    expect(existsSync(a.file)).toBe(false);

    const b = written();
    // Windows: mode bits do not reflect ACLs, so isOwnerOnly passes there.
    if (process.platform !== "win32") {
      chmodSync(b.file, 0o644);
      refuse(b.id, NOW, /owner or mode/);
    }

    const c = written();
    const target = join(h.home, "elsewhere.json");
    writeFileSync(target, readFileSync(c.file), { mode: 0o600 });
    const link = join(h.dispatchHome, HANDOFF_DIR, `${"a".repeat(32)}.json`);
    symlinkSync(target, link);
    refuse("a".repeat(32), NOW, /not a file/);

    const d = written();
    writeFileSync(d.file, '{"version":1}', { mode: 0o600 });
    refuse(d.id, NOW, /malformed/);
  });

  it("refuses a handoff directory that is a symlink (outside ~/.dispatch/handoffs)", () => {
    w = world();
    const outside = join(h.home, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(h.dispatchHome, HANDOFF_DIR));
    const o = out(preToolUseResponse(w.input("reader"), w.env, NOW));
    const id = /handoff ([0-9a-f]{32})/.exec(o.permissionDecisionReason)?.[1] as string;
    refuse(id, NOW, /outside/);
  });

  it("gc removes stale handoffs and expired passthrough entries; the file is capped", () => {
    w = world();
    const a = written();
    utimesSync(a.file, new Date(NOW - 2 * 3600_000), new Date(NOW - 2 * 3600_000));
    const b = written();
    utimesSync(b.file, new Date(NOW), new Date(NOW));
    expect(gcHandoffs(h.dispatchHome, NOW, true)).toEqual([a.id]);
    expect(existsSync(a.file)).toBe(true);
    expect(gcHandoffs(h.dispatchHome, NOW)).toEqual([a.id]);
    expect(handoffs()).toEqual([`${b.id}.json`]);

    for (let i = 0; i < PASSTHROUGH_CAP + 5; i++) addPassthrough(h.dispatchHome, `k${i}`, NOW + i);
    const file = join(h.dispatchHome, PASSTHROUGH_FILE);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toHaveLength(PASSTHROUGH_CAP);
    // Windows: mode bits do not reflect ACLs.
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(consumePassthrough(h.dispatchHome, "k0", NOW)).toBe(false); // dropped by the cap
    expect(consumePassthrough(h.dispatchHome, "k104", NOW)).toBe(true);
    expect(consumePassthrough(h.dispatchHome, "k104", NOW)).toBe(false);
    expect(gcPassthrough(h.dispatchHome, NOW + 31 * 60_000)).toBe(PASSTHROUGH_CAP - 1);
    expect(gcPassthrough(h.dispatchHome, NOW)).toBe(0);
    writeFileSync(file, "[]");
    expect(consumePassthrough(h.dispatchHome, "k1", NOW)).toBe(false);
  });
});

const dist = resolve(import.meta.dirname, "../../../dist/hook.mjs");

describe.skipIf(!existsSync(dist))("dist/hook.mjs custom agent latency [UC2]", () => {
  // The 80 ms budget is asserted only on a quiet machine (DISPATCH_PERF=1, as for the other hooks);
  // under the parallel test suite the bound is generous.
  const budget = process.env.DISPATCH_PERF === "1" ? 80 : 1000;
  it("p95 within budget with 30 agent files, matching by frontmatter name", () => {
    const w = world();
    for (let i = 0; i < 30; i++) {
      writeFileSync(
        join(w.agents, `agent-${i}.md`),
        agentText(`name: a${i}\ndescription: agent ${i}\ntools: Read, Edit`, "x".repeat(2000)),
      );
    }
    const input = JSON.stringify(w.input("a29"));
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      const r = spawnSync(process.execPath, [dist, "claude-code", "PreToolUse"], {
        input,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", ...w.env },
      });
      times.push(performance.now() - t0);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('"subagent_type":"dispatch:dispatch"');
    }
    times.shift(); // the first run warms the file cache
    times.sort((x, y) => x - y);
    expect(times[Math.ceil(times.length * 0.95) - 1]).toBeLessThanOrEqual(budget);
  });
});
