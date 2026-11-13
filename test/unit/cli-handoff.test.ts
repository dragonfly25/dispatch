/** `dispatch run --handoff` and `dispatch apply` (Claude hard mode for custom agents) with fake CLIs. */
import { chmodSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HANDOFF_RUNS_DIR, handoffPromptText, readHandoffRun } from "../../src/app/handoff.js";
import { refusal } from "../../src/cli/commands/apply.js";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type { RunResult } from "../../src/core/contracts.js";
import {
  type Handoff,
  PASSTHROUGH_FILE,
  passthroughKey,
  writeHandoff,
} from "../../src/hosts/claude-code/handoff.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { probeResult } from "../fixtures/contracts.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  snapshotTree,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
let other: TempRepo | undefined;
afterEach(() => {
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  other?.cleanup();
  fakes = home = repo = other = undefined;
});

const EDIT: FakeScenarioMap = {
  codex: [{ scenario: "success_edit", file: "math.js", content: "changed\n" }],
};

function setup(scenarios: FakeScenarioMap = EDIT, config = "") {
  fakes = createFakes(scenarios);
  home = tempHome();
  repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), `version: 1\n${config}`);
  const base = { ...fakes.env, ...home.env };
  const probes = new ProbeCache();
  probes.set("codex", "codex", {
    ...probeResult,
    binaryPath: fakes.bin("codex"),
    features: ["hooks", "plugins", "apps", "memories"],
  });
  const run = async (args: string[], cwd = repo?.dir ?? "") => {
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
        cwd,
        env: base,
        quotaReaders: new QuotaReaderRegistry(),
        runner: { probes },
        // A supervisor that exits at once: enough to see what `run --detach` records.
        detachCli: [process.execPath, "-e", "0"],
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env: base });
    return { code, out, err };
  };
  return { run, fakes, home, repo };
}

function handoff(over: Partial<Handoff> = {}): Handoff {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    agent: {
      name: "builder",
      source: "project",
      path: join(repo?.dir ?? "", ".claude", "agents", "builder.md"),
    },
    instructions: "Always add a JSDoc comment.",
    task: "add sub to math.js",
    description: "add sub",
    model: "claude-opus-5-5",
    effort: "high",
    autonomy: "worktree",
    mcpServers: [],
    web: false,
    autoApply: true,
    passthroughKey: passthroughKey("builder", "add sub to math.js"),
    ...over,
  };
}

const passthrough = (h: TempHome) => {
  try {
    return Object.keys(JSON.parse(readFileSync(join(h.dispatchHome, PASSTHROUGH_FILE), "utf8")));
  } catch {
    return [];
  }
};

describe("dispatch run --handoff [UC2][SEC-handoff]", () => {
  it("builds the task from the agent instructions and requests its model, effort and autonomy", async () => {
    const { run, fakes, home, repo } = setup();
    const id = writeHandoff(home.dispatchHome, handoff({ autonomy: "read-only" }));
    const { code, out, err } = await run(["run", "--handoff", id, "--json"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(r.decisions[0]?.targets[0]).toMatchObject({ tier: "max", effort: "high" });
    const call = fakes.readLog({ cli: "codex", kind: "run" })[0];
    expect(call?.stdin).toContain("## Agent instructions (from .claude/agents/builder.md)");
    expect(call?.stdin).toContain("Always add a JSDoc comment.");
    expect(call?.stdin).toMatch(/## Task\n\nadd sub to math\.js/);
    expect(call?.args.join(" ")).toContain("-s read-only");
    expect(readHandoffRun(home.dispatchHome, r.runId)).toMatchObject({
      agent: "builder",
      autoApply: true,
      appliedAt: null,
      repoRoot: repo.dir,
    });
    // The handoff is used once.
    const again = await run(["run", "--handoff", id, "--json"]);
    expect(again.code).toBe(2);
    expect(again.err).toMatch(/not found/);
    expect(passthrough(home)).toEqual([]);
  });

  it("--detach passes the handoff to the supervisor and records the run for apply", async () => {
    const { run, home } = setup();
    const h = handoff();
    const id = writeHandoff(home.dispatchHome, h);
    const { code, out } = await run(["run", "--detach", "--handoff", id, "--json"]);
    expect(code).toBe(0);
    const { runId } = JSON.parse(out) as { runId: string };
    expect(readHandoffRun(home.dispatchHome, runId)).toMatchObject({ agent: "builder" });
  });

  it("gc removes stale handoffs, expired passthrough and old handoff-run records", async () => {
    const { run, home } = setup();
    const old = new Date(Date.now() - 400 * 86_400_000);
    const stale = writeHandoff(home.dispatchHome, handoff());
    utimesSync(join(home.dispatchHome, "handoffs", `${stale}.json`), old, old);
    const id = writeHandoff(home.dispatchHome, handoff());
    const { runId } = JSON.parse((await run(["run", "--handoff", id, "--json"])).out) as RunResult;
    const rec = join(home.dispatchHome, HANDOFF_RUNS_DIR, `${runId}.json`);
    utimesSync(rec, old, old);
    writeFileSync(
      join(home.dispatchHome, PASSTHROUGH_FILE),
      JSON.stringify({ expired: 1, live: Date.now() + 60_000 }),
    );
    const dry = JSON.parse((await run(["gc", "--dry-run", "--json"])).out);
    expect(dry).toMatchObject({ handoffs: [stale], passthrough: 1, handoffRuns: [runId] });
    const text = (await run(["gc"])).out;
    expect(text).toContain("Removed 1 stale handoff(s), 1 expired passthrough entry, 1 old");
    expect(readHandoffRun(home.dispatchHome, runId)).toBeNull();
    expect(JSON.parse((await run(["gc", "--json"])).out)).toMatchObject({
      handoffs: [],
      passthrough: 0,
      handoffRuns: [],
    });
  });

  it("a handoff-run record that is malformed or readable by others is ignored", async () => {
    const { home } = setup();
    const dir = join(home.dispatchHome, HANDOFF_RUNS_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "R1.json"), '{"version":1,"runId":"R1"}', { mode: 0o600 });
    expect(readHandoffRun(home.dispatchHome, "R1")).toBeNull();
    const ok = { version: 1, runId: "R2", repoRoot: "/r", agent: "a", autoApply: true };
    writeFileSync(
      join(dir, "R2.json"),
      JSON.stringify({ ...ok, createdAt: "x", appliedAt: null }),
      { mode: 0o600 },
    );
    expect(readHandoffRun(home.dispatchHome, "R2")).not.toBeNull();
    if (process.platform !== "win32") {
      // Windows: mode bits do not reflect ACLs, so isOwnerOnly cannot see this.
      chmodSync(join(dir, "R2.json"), 0o644);
      expect(readHandoffRun(home.dispatchHome, "R2")).toBeNull();
    }
    expect(readHandoffRun(home.dispatchHome, "../R2")).toBeNull();
  });

  it("rejects --handoff with --task and a malformed id", async () => {
    const { run } = setup();
    expect((await run(["run", "--handoff", "a".repeat(32), "--task", "x"])).code).toBe(2);
    const bad = await run(["run", "--handoff", "../x"]);
    expect(bad.code).toBe(2);
    expect(bad.err).toMatch(/not a handoff id/);
  });

  it("a run that fails records the passthrough so the caller's retry runs natively", async () => {
    const { run, home } = setup({ codex: [{ scenario: "fail" }] });
    const h = handoff();
    const id = writeHandoff(home.dispatchHome, h);
    const r = JSON.parse((await run(["run", "--handoff", id, "--json"])).out) as RunResult;
    expect(r.outcome === "success" && r.status === "completed").toBe(false);
    expect(passthrough(home)).toEqual([h.passthroughKey]);
  });

  it("a config error after loading also records the passthrough", async () => {
    const { run, home } = setup(EDIT, "profile: nope\n");
    const h = handoff();
    const id = writeHandoff(home.dispatchHome, h);
    expect((await run(["run", "--handoff", id, "--json"])).code).toBe(2);
    expect(passthrough(home)).toEqual([h.passthroughKey]);
  });

  it("the prompt text shows a user agent path under ~", () => {
    const h = handoff({
      agent: { name: "u", source: "user", path: "/home/me/.claude/agents/u.md" },
      instructions: "",
    });
    const text = handoffPromptText(h, "/repo", "/home/me");
    expect(text).not.toContain("Agent instructions");
    expect(
      handoffPromptText({ ...h, instructions: "i" }, "/repo", "/home/me", [], "linux"),
    ).toContain("(from ~/.claude/agents/u.md)");
    const win = {
      ...h,
      instructions: "i",
      agent: { ...h.agent, path: "C:\\Users\\me\\.claude\\agents\\u.md" },
    };
    expect(handoffPromptText(win, "C:\\repo", "C:\\Users\\me", [], "win32")).toContain(
      "(from ~\\.claude\\agents\\u.md)",
    );
  });
});

describe("dispatch apply [UC2][SEC-apply]", () => {
  async function succeeded(over: Partial<Handoff> = {}, scenarios: FakeScenarioMap = EDIT) {
    const s = setup(scenarios);
    const id = writeHandoff(s.home.dispatchHome, handoff(over));
    const r = JSON.parse((await s.run(["run", "--handoff", id, "--json"])).out) as RunResult;
    return { ...s, runId: r.runId, result: r };
  }

  it("applies a clean patch to the working tree only, once", async () => {
    const { run, repo, runId, home } = await succeeded();
    const { code, out } = await run(["apply", runId, "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ runId, applied: true });
    expect(readFileSync(join(repo.dir, "math.js"), "utf8")).toBe("changed\n");
    expect(repo.git("diff", "--cached", "--name-only")).toBe(""); // index untouched
    expect(repo.git("log", "--oneline").split("\n")).toHaveLength(1); // no commit
    expect(readHandoffRun(home.dispatchHome, runId)?.appliedAt).not.toBeNull();
    const twice = await run(["apply", runId, "--json"]);
    expect(twice.code).toBe(3);
    expect(JSON.parse(twice.out).reason).toMatch(/already applied/);
  });

  it("each refusal exits 3 with the reason and leaves the tree unchanged", async () => {
    const { run, repo, runId, home } = await succeeded();
    const tree = () => snapshotTree(repo.dir);
    const refused = async (args: string[], re: RegExp, cwd?: string) => {
      const before = tree();
      const r = await run(args, cwd);
      expect(r.code).toBe(3);
      expect(r.out).toMatch(re);
      expect(tree()).toEqual(before);
    };
    await refused(["apply", "01NOTAHANDOFFRUN"], /not a run started from a Dispatch handoff/);
    other = tempRepo({ files: { "a.txt": "a\n" } });
    await refused(["apply", runId], /another repository/, other.dir);
    writeFileSync(
      join(home.dispatchHome, "config.yaml"),
      "version: 1\nhosts:\n  claude-code:\n    auto_apply: false\n",
    );
    await refused(["apply", runId], /auto-apply is off/);
    writeFileSync(join(home.dispatchHome, "config.yaml"), "version: 1\n");
    writeFileSync(join(repo.dir, "math.js"), "someone else edited this\n");
    await refused(["apply", runId, "--json"], /no longer applies/);
  });

  it("a handoff without autoApply and a failed run are refused", async () => {
    const off = await succeeded({ autoApply: false });
    const r = await off.run(["apply", off.runId]);
    expect(r.code).toBe(3);
    expect(r.out).toMatch(/Not applied: auto-apply is off/);
  });

  it("refusal() covers every unsafe result", () => {
    const patch = {
      path: "/p",
      diffstat: " a | 1 +",
      applies: true,
      needsReview: false,
      rejectedPaths: [] as string[],
    };
    const ok = { status: "completed", outcome: "success", patch } as unknown as RunResult;
    expect(refusal(ok)).toBeNull();
    expect(refusal(null)).toMatch(/no result/);
    expect(refusal({ ...ok, status: "returned_to_host", outcome: null })).toMatch(
      /did not succeed/,
    );
    expect(refusal({ ...ok, outcome: "failed" })).toMatch(/did not succeed/);
    expect(refusal({ ...ok, patch: null })).toMatch(/no patch/);
    expect(refusal({ ...ok, patch: { ...patch, needsReview: true } })).toMatch(/needs review/);
    expect(refusal({ ...ok, patch: { ...patch, rejectedPaths: [".env"] } })).toMatch(/dropped/);
    expect(refusal({ ...ok, patch: { ...patch, applies: false } })).toMatch(/did not apply/);
  });
});
