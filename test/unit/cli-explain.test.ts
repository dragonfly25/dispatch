import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildTask, dryRun, loadAppContext } from "../../src/app/index.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { recordDecisionWithShadow } from "../../src/shadow/index.js";
import { harness, maskHash, NOW, PIN_CONFIG } from "./cli-read.helpers.js";

const PROFILES = ["balance", "off", "preserve", "specialize"] as const;
const PINNED = ["--task", "update the schema", "--path", "db/migrations/001.sql"];

describe("explain", () => {
  it.each(PROFILES)("[UC5] the pin is the winning rule under profile %s", async (profile) => {
    const h = harness();
    h.sb.global(`${PIN_CONFIG}profile: ${profile}\n`);
    const r = await h.run(["explain", ...PINNED]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`profile ${profile},`);
    expect(r.out).toContain("+ [pin] migrations: host");
    expect(r.out).toContain("Decision: host (single)");
    // Every other profile decides the same, with the pin as the reason.
    for (const other of PROFILES.filter((p) => p !== profile)) {
      expect(r.out).toContain(`${other}: host (single) | host: pin migrations`);
    }
  });

  it("[UC5] snapshot: the pin wins and every profile agrees", async () => {
    const h = harness();
    h.sb.global(PIN_CONFIG);
    const r = await h.run(["explain", ...PINNED, "--task-type", "refactor"]);
    expect(maskHash(r.out)).toMatchSnapshot();
  });

  it("[UC5] without a pinned path the profiles differ", async () => {
    const h = harness();
    h.sb.global(PIN_CONFIG);
    const r = await h.run(["explain", "--task", "fix a bug", "--path", "src/a.ts"]);
    expect(r.out).toContain("Decision: delegate (fallback)");
    expect(r.out).toContain("- [pin] migrations: no match");
    expect(r.out).toContain("Other profiles:");
  });

  it("[UC6] balanced (default) keeps the balanced tier, inherit follows the session model", async () => {
    const h = harness();
    const base = ["explain", "--task", "refactor it", "--session-model", "claude-opus-5-5"];
    const env = { CLAUDECODE: "1" };

    const balanced = await h.run(base, { env });
    expect(balanced.out).toContain("tier:unspecified:balanced: tier balanced");
    expect(balanced.out).toContain("tier balanced [models.codex.tiers.balanced]");

    h.sb.global("version: 1\nunspecified_model: inherit\n");
    const inherit = await h.run(base, { env });
    expect(inherit.out).toContain("tier:unspecified:inherit: tier max");
    expect(inherit.out).toContain("tier max [models.codex.tiers.max]");
    expect(inherit.out).not.toContain("tier:unspecified:balanced");

    // Without a known session model, inherit records what it decided without.
    const unknown = await h.run(["explain", "--task", "refactor it"], { env });
    expect(unknown.out).toContain("decided_without: session_model");
  });

  it("excludes the host instance and reports the self id", async () => {
    const h = harness();
    const r = await h.run(["explain", "--task", "x", "--json"], { env: { CLAUDECODE: "1" } });
    const j = JSON.parse(r.out);
    expect(j.input.host).toMatchObject({ self: "claude", depth: 0 });
    expect(j.decision.targets.map((t: { instance: string }) => t.instance)).not.toContain("claude");
  });

  it("--json carries input, decision, alternatives and text", async () => {
    const h = harness();
    h.sb.global("version: 1\nautonomy: read-only\n");
    const r = await h.run([
      "explain",
      "--task",
      "look",
      "--path",
      "a.ts",
      "--path",
      "b.ts",
      "--model",
      "claude-opus-5-5",
      "--tier",
      "fast",
      "--effort",
      "low",
      "--timeout",
      "90",
      "--json",
    ]);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.input.task).toEqual({
      id: "task-1",
      prompt: "look",
      paths: ["a.ts", "b.ts"],
      requestedModel: "claude-opus-5-5",
      tier: "fast",
      effort: "low",
      autonomy: "read-only",
      timeoutMs: 90_000,
    });
    expect(j.input.now).toBe(NOW);
    expect(j.decision.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(j.alternatives).sort()).toEqual(["off", "preserve", "specialize"]);
    expect(j.explain).toContain("Dispatch explain");
  });

  it("reads the prompt from --task-file and the task type", async () => {
    const h = harness();
    writeFileSync(join(h.sb.root, "task.txt"), "from a file\n");
    const r = await h.run(["explain", "--task-file", "task.txt", "--task-type", "docs", "--json"]);
    const j = JSON.parse(r.out);
    expect(j.input.task).toMatchObject({ prompt: "from a file\n", taskType: "docs" });
  });

  it.each([
    [["explain"], "a task is required"],
    [["explain", "--task", "x", "--task-file", "f"], "either --task or --task-file"],
    [["explain", "--task-file", "missing.txt"], "cannot read --task-file"],
    [["explain", "--task", "x", "--tier", "huge"], 'unknown tier "huge"'],
    [["explain", "--task", "x", "--effort", "extreme"], 'unknown effort "extreme"'],
    [["explain", "--task", "x", "--autonomy", "root"], 'unknown autonomy "root"'],
    [["explain", "--task", "x", "--timeout", "0"], "--timeout must be a positive"],
    [["explain", "--task", "x", "--timeout", "soon"], "--timeout must be a positive"],
    [["explain", "--task", "x", "--with-current-config"], "needs --replay"],
    [["explain", "--task", "x", "--replay", "abc"], "either --replay or --task"],
    [["explain", "--replay", "nope"], "no recorded decision"],
  ])("usage error (exit 2): %j", async (args, message) => {
    const h = harness();
    const r = await h.run(args);
    expect(r.code).toBe(2);
    expect(r.err).toContain(message);
  });

  it("a broken global config exits 2", async () => {
    const h = harness();
    h.sb.global("version: 1\nprofile: [unclosed\n");
    const r = await h.run(["explain", "--task", "x"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid YAML");
  });

  it("still explains when the state database cannot be opened (quota unknown)", async () => {
    const h = harness();
    mkdirSync(join(h.sb.dispatchHome, "state", "dispatch.db"), { recursive: true });
    const r = await h.run(["explain", "--task", "x"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Dispatch explain");
  });

  it("does not record anything", async () => {
    const h = harness();
    await h.run(["explain", "--task", "x"]);
    const ctx = loadAppContext({
      cwd: h.sb.root,
      env: h.sb.env,
      clock: h.clock,
      quotaReaders: new QuotaReaderRegistry(),
    });
    try {
      expect(await ctx.store.listDecisions("1970-01-01T00:00:00.000Z")).toEqual([]);
    } finally {
      ctx.close();
    }
  });
});

describe("explain --replay", () => {
  /** Records the dry-run decision of a pinned task (as `run` will) and returns its id. */
  async function record(h: ReturnType<typeof harness>): Promise<string> {
    const ctx = loadAppContext({
      cwd: h.sb.root,
      env: h.sb.env,
      clock: h.clock,
      quotaReaders: new QuotaReaderRegistry(),
    });
    try {
      const task = buildTask(ctx, { task: "update schema", path: ["db/migrations/002.sql"] });
      const { input, decision } = await dryRun(ctx, task);
      return (await recordDecisionWithShadow(ctx.store, input, decision, { clock: h.clock })).id;
    } finally {
      ctx.close();
    }
  }

  it("[AC3] replays a recorded decision identically", async () => {
    const h = harness();
    h.sb.global(PIN_CONFIG);
    const id = await record(h);

    const text = await h.run(["explain", "--replay", id]);
    expect(text.code).toBe(0);
    expect(text.out).toContain(`Replay of decision ${id} (profile balance): IDENTICAL`);
    expect(text.out).toContain("+ [pin] migrations: host");

    const json = JSON.parse((await h.run(["explain", "--replay", id, "--json"])).out);
    expect(json).toMatchObject({ decisionId: id, identical: true, diff: [] });
  });

  it("[AC3] --with-current-config shows what a changed configuration would decide", async () => {
    const h = harness();
    h.sb.global(PIN_CONFIG);
    const id = await record(h);

    // The pin is removed afterwards: the stored input still replays identically...
    h.sb.global("version: 1\n");
    expect((await h.run(["explain", "--replay", id])).out).toContain("IDENTICAL");

    // ...and differs when today's configuration is substituted.
    const r = await h.run(["explain", "--replay", id, "--with-current-config"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("DIFFERS");
    expect(r.out).toContain("current configuration");
    expect(r.out).toMatch(/recorded: .*pin/);
  });

  it("opens the state database lazily", async () => {
    const h = harness();
    await h.run(["validate"]);
    expect(existsSync(join(h.sb.dispatchHome, "state"))).toBe(false);
  });
});
