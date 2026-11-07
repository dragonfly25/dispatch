import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AGY_CAPABILITIES,
  createAgyAdapter,
  parseResetDelayMs,
  REQUIRED_FLAGS,
  satisfiesRange,
  wrapPrompt,
} from "../../../src/adapters/agy/index.js";
import type {
  AdapterDeps,
  AdapterOutcome,
  AdapterRunContext,
  BuildInvocationArgs,
  NormalizedEvent,
  ProbeResult,
  ProviderInstance,
  Spawner,
  SpawnRequest,
  SpawnResult,
} from "../../../src/core/contracts.js";
import {
  AdapterCapabilitiesSchema,
  AdapterOutcomeSchema,
  InvocationSchema,
  NormalizedEventSchema,
} from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import * as fx from "../../fixtures/contracts.js";
import { FakeClock, ScriptedSpawner } from "../../stubs/index.js";
import { withFakes } from "../../support/index.js";

const adapter = createAgyAdapter();
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/agy/1.5.2");
const WT = "/work/wt";
const ENDED = "2026-11-07T10:00:00.000Z";

const instance: ProviderInstance = { id: "agy", adapter: "antigravity", pool: "subscription" };
const probe: ProbeResult = {
  binaryPath: "/opt/homebrew/bin/agy",
  realpath: "/opt/homebrew/Caskroom/antigravity-cli/1.5.2/agy",
  version: "1.5.2",
  flags: [],
  features: [],
  loggedIn: true,
  outsideCliRange: false,
};
const baseEnv = { PATH: "/usr/bin:/bin", HOME: "/home/u", TERM: "dumb", DISPATCH_DEPTH: "1" };

function buildArgs(over: Partial<BuildInvocationArgs> = {}): BuildInvocationArgs {
  return {
    task: { ...fx.task, autonomy: "read-only", prompt: "Review src/a.ts", timeoutMs: 120_000 },
    target: { instance: "agy", tier: "fast", model: "gemini-3.8-flash-low", effort: "low" },
    autonomy: "read-only",
    worktree: WT,
    repoRoot: "/work/repo",
    runDir: "/work/run",
    instance,
    probe,
    baseEnv,
    ...over,
  };
}

function ctxOf(extra: Record<string, unknown> = {}): AdapterRunContext {
  return {
    runId: "run-1",
    worktree: WT,
    scratch: { now: () => new Date(fx.T0), endedAt: ENDED, ...extra },
  };
}

interface Replay {
  events: NormalizedEvent[];
  outcome: AdapterOutcome;
}

/** Feeds recorded/synthetic output through parseLine, then finalize. */
function replay(
  stdout: string[],
  stderr: string[],
  exitCode: number | null,
  over: Partial<SpawnResult & { durationMs: number }> = {},
  ctx = ctxOf(),
): Replay {
  const events = [
    ...stdout.flatMap((l) => adapter.parseLine("stdout", l, ctx)),
    ...stderr.flatMap((l) => adapter.parseLine("stderr", l, ctx)),
  ];
  const outcome = adapter.finalize(
    { exitCode, signal: null, timedOut: false, durationMs: 1234, ...over },
    ctx,
  );
  return { events, outcome };
}

function fixture(name: string): { stdout: string[]; stderr: string[]; exitCode: number } {
  const read = (f: string): string[] =>
    readFileSync(join(FIXTURES, f), "utf8").split("\n").filter(Boolean);
  const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), "utf8")) as {
    exitCode: number;
  };
  return {
    stdout: read(`${name}.stdout.jsonl`),
    stderr: read(`${name}.stderr.txt`),
    exitCode: meta.exitCode,
  };
}

const json = (o: unknown): string => JSON.stringify(o);
const result = (r: Record<string, unknown>): string =>
  json({ event: "result", result: { status: "SUCCESS", response: "", ...r } });
const tool = (state: string, name: string, index: number, parameters: unknown, error?: unknown) =>
  json({
    event: "step_update",
    step_update: {
      step_index: index,
      state,
      step_type: "tool",
      tool_name: name,
      tool_info: { name, parameters, ...(error ? { error } : {}) },
    },
  });

describe("agy capabilities", () => {
  it("[UC4] declares an experimental read-only adapter with argv prompts", () => {
    expect(AdapterCapabilitiesSchema.safeParse(AGY_CAPABILITIES).success).toBe(true);
    expect(adapter.caps).toMatchObject({
      id: "antigravity",
      experimental: true,
      autonomy: ["read-only"],
      quotaChannel: "reader",
      promptChannel: "argv",
      sandbox: "permission-only",
      cliRange: ">=1.5.2 <1.6",
      isolation: {
        userHooks: "not_disableable",
        userPlugins: "not_disableable",
        projectConfig: "not_disableable",
      },
    });
    expect(adapter.readQuota).toBeUndefined();
  });
});

describe("agy buildInvocation", () => {
  it("[UC4][SEC-agy-ro] golden argv for read-only", () => {
    const inv = adapter.buildInvocation(buildArgs());
    expect(InvocationSchema.safeParse(inv).success).toBe(true);
    expect(inv.binary).toBe("/opt/homebrew/bin/agy");
    expect(inv.argv).toEqual([
      `-p=${wrapPrompt("Review src/a.ts")}`,
      "--output-format",
      "stream-json",
      "--sandbox",
      "--disable-slash-commands",
      "--model",
      "gemini-3.8-flash-low",
      "--effort",
      "low",
      "--print-timeout",
      "120s",
    ]);
    expect(inv.cwd).toBe(WT);
    expect(inv.stdin).toBeNull();
    expect(inv.redactArgvIndexes).toEqual([0]);
    expect(inv.sideEffectGuards).toEqual(["agy-no-skip-permissions", "agy-read-only"]);
    expect(inv.argv).not.toContain("--mode");
    expect(inv.argv).not.toContain("--dangerously-skip-permissions");
    const prompt = inv.argv[0] ?? "";
    expect(prompt).toContain("task delegated by Dispatch");
    expect(prompt).toContain("Never run `dispatch`");
    expect(prompt.endsWith("Review src/a.ts")).toBe(true);
  });

  it("rounds the print timeout up to whole seconds", () => {
    const inv = adapter.buildInvocation(
      buildArgs({ task: { ...buildArgs().task, timeoutMs: 1500 } }),
    );
    expect(inv.argv.at(-1)).toBe("2s");
  });

  it("[SEC-agy-ro] never adds ANTIGRAVITY_* (or anything) to baseEnv", () => {
    const inv = adapter.buildInvocation(buildArgs());
    expect(inv.env).toEqual(baseEnv);
    expect(Object.keys(inv.env).some((k) => k.startsWith("ANTIGRAVITY_"))).toBe(false);
    expect(inv.env).not.toBe(baseEnv);
  });

  it("[SEC-agy-ro] rejects worktree and direct autonomy", () => {
    for (const autonomy of ["worktree", "direct"] as const) {
      const call = () => adapter.buildInvocation(buildArgs({ autonomy }));
      expect(call).toThrow(DispatchError);
      expect(call).toThrow(/read-only/);
    }
  });

  it("[SEC-agy-ro] argv never contains --dangerously-skip-permissions for any input", () => {
    const text = fc.oneof(
      fc.string(),
      fc.constantFrom("--dangerously-skip-permissions", "-p=x", "--mode", "\n--sandbox\n"),
    );
    fc.assert(
      fc.property(
        text,
        text,
        text,
        fc.integer({ min: 1, max: 10_000_000 }),
        fc.constantFrom("read-only", "worktree", "direct"),
        (prompt, model, effort, timeoutMs, autonomy) => {
          try {
            const inv = adapter.buildInvocation(
              buildArgs({
                autonomy,
                task: { ...buildArgs().task, prompt, timeoutMs },
                target: { instance: "agy", tier: "t", model, effort },
              }),
            );
            expect(autonomy).toBe("read-only");
            expect(inv.argv.some((a) => a === "--dangerously-skip-permissions")).toBe(false);
            expect(inv.argv.filter((a) => a.startsWith("--")).sort()).toEqual(
              [
                "--output-format",
                "--sandbox",
                "--disable-slash-commands",
                "--model",
                "--effort",
                "--print-timeout",
              ].sort(),
            );
            expect(inv.argv[0]?.startsWith("-p=")).toBe(true);
          } catch (e) {
            expect(e).toBeInstanceOf(DispatchError);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("rejects model/effort values that could be read as flags", () => {
    for (const bad of ["--dangerously-skip-permissions", "", "-x", "a b"]) {
      expect(() =>
        adapter.buildInvocation(
          buildArgs({ target: { instance: "agy", tier: "t", model: bad, effort: "low" } }),
        ),
      ).toThrow(/invalid model/);
      expect(() =>
        adapter.buildInvocation(
          buildArgs({ target: { instance: "agy", tier: "t", model: "m", effort: bad } }),
        ),
      ).toThrow(/invalid effort/);
    }
  });

  it("fails closed without a binary or when --help lacks required flags", () => {
    expect(() =>
      adapter.buildInvocation(buildArgs({ probe: { ...probe, binaryPath: null } })),
    ).toThrow(/not resolved/);
    expect(() =>
      adapter.buildInvocation(buildArgs({ probe: { ...probe, flags: ["--output-format"] } })),
    ).toThrow(/--sandbox/);
    const all = adapter.buildInvocation(
      buildArgs({ probe: { ...probe, flags: [...REQUIRED_FLAGS] } }),
    );
    expect(all.argv).toContain("--sandbox");
  });
});

describe("agy parse + finalize on recorded fixtures", () => {
  it("[UC4][SEC-agy-ro] SUCCESS with denied_actions maps to failed with the denial listed", () => {
    const f = fixture("plan_mode_write_denied");
    const { events, outcome } = replay(f.stdout, f.stderr, f.exitCode, { durationMs: 2831 });
    expect(AdapterOutcomeSchema.safeParse(outcome).success).toBe(true);
    expect(outcome).toMatchObject({
      outcome: "failed",
      deniedActions: ["write_file"],
      nativeError: "denied: write_file",
      summary: "",
      durationMs: 2831,
      usage: { inputTokens: 7830, outputTokens: 101, cachedTokens: 0 },
    });
    expect(events.map((e) => e.kind)).toEqual([
      "thinking",
      "thinking",
      "editing",
      "denied",
      "done",
    ]);
    expect(events.every((e) => NormalizedEventSchema.safeParse(e).success)).toBe(true);
    // the result event does not repeat the denial the tool step already reported
    expect(events.filter((e) => e.kind === "denied")).toHaveLength(1);
    expect(events[0]?.detail).toBe("model gemini-3.8-flash-low");
  });

  it("[UC4] the synthetic quota fixture is quota_exhausted without a reset time", () => {
    const f = fixture("quota_exhausted");
    const { events, outcome } = replay(f.stdout, f.stderr, f.exitCode);
    expect(outcome).toMatchObject({
      outcome: "quota_exhausted",
      quotaSignal: {
        source: "agy.agy_error.quota",
        raw: "You have exhausted your quota on this model.",
      },
    });
    expect(outcome.resetAt).toBeUndefined();
    expect(events.at(-1)).toMatchObject({ kind: "error" });
  });

  it("the -p - json fixture (not stream-json) yields no events and no result", () => {
    const line = readFileSync(join(FIXTURES, "prompt_dash_is_literal.json"), "utf8").trim();
    const { events, outcome } = replay([line], [], 0);
    expect(events).toEqual([]);
    expect(outcome.outcome).toBe("failed");
    expect(outcome.nativeError).toMatch(/no result event/);
  });
});

describe("agy parse + finalize on synthetic streams", () => {
  const ok = [
    json({ event: "init", init: { model: "gemini-3.8-flash-low", tools: [] } }),
    tool("ACTIVE", "view_file", 2, { AbsolutePath: `${WT}/src/a.ts` }),
    tool("DONE", "view_file", 2, { AbsolutePath: `${WT}/src/a.ts` }),
    tool("DONE", "grep_search", 3, { SearchPath: "/etc" }),
    tool("ACTIVE", "write_to_file", 4, { TargetFile: `${WT}/out.txt` }),
    tool("ACTIVE", "run_command", 5, { CommandLine: "ls" }),
    json({ event: "step_update", step_update: { step_index: 6, step_type: "agent_response" } }),
    json({ event: "step_update", step_update: { step_index: 0, step_type: "user_input" } }),
    result({
      response: "All good. Summary: nothing to change.",
      usage: { input_tokens: 100, output_tokens: 20, thinking_tokens: 5, cache_read_tokens: 40 },
    }),
  ];

  it("[UC4] SUCCESS with a response and no denials is success; tools map to event kinds", () => {
    const { events, outcome } = replay(ok, [], 0);
    expect(outcome).toMatchObject({
      outcome: "success",
      summary: "All good. Summary: nothing to change.",
      deniedActions: [],
      usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 40 },
    });
    expect(events.map((e) => [e.kind, e.path])).toEqual([
      ["thinking", undefined],
      ["reading", "src/a.ts"],
      ["reading", undefined],
      ["editing", "out.txt"],
      ["running", undefined],
      ["thinking", undefined],
      ["done", undefined],
    ]);
    // outside the worktree: no path, the target is kept in the detail only
    expect(events[2]?.detail).toBe("grep_search /etc");
  });

  it("[UC4] ERROR / CANCELED results are failed", () => {
    for (const status of ["ERROR", "CANCELED"]) {
      const { events, outcome } = replay([result({ status, error: "boom" })], [], 0);
      expect(outcome).toMatchObject({ outcome: "failed", nativeError: "boom" });
      expect(events.at(-1)).toMatchObject({ kind: "error", detail: "boom" });
    }
    const bare = replay([json({ event: "result", result: { status: "ERROR" } })], [], 0);
    expect(bare.outcome.nativeError).toContain("ERROR");
    const nested = replay([result({ status: "ERROR", error: { message: "deep" } })], [], 0);
    expect(nested.outcome.nativeError).toBe("deep");
  });

  it("a non-zero exit with a SUCCESS result, or a signal without a result, is failed", () => {
    expect(replay(ok, [], 3).outcome).toMatchObject({
      outcome: "failed",
      nativeError: "agy exited with code 3",
    });
    expect(replay([], [], null, { signal: "SIGSEGV" }).outcome.nativeError).toBe(
      "killed by SIGSEGV",
    );
    expect(replay([], ["fatal: something broke"], 1).outcome.nativeError).toBe(
      "fatal: something broke",
    );
  });

  it("[UC4] tool errors that are not denials become error events", () => {
    const { events } = replay(
      [tool("ERROR", "view_file", 1, {}, { type: "TOOL_ERROR", message: "no such file" })],
      [],
      0,
    );
    expect(events).toEqual([
      { kind: "error", ts: fx.T0, detail: "view_file failed: no such file" },
    ]);
  });

  it("[UC4] denials from the result alone (no tool step) still surface as denied events", () => {
    const { events, outcome } = replay(
      [
        result({
          denied_actions: [{ action: "command", display_name: "RunCommand" }, { nope: 1 }],
        }),
      ],
      ["jetski: no output produced"],
      0,
    );
    expect(events.map((e) => e.kind)).toEqual(["denied", "done"]);
    expect(outcome).toMatchObject({ outcome: "failed", deniedActions: ["command"] });
  });

  it("[UC4] quota: RESOURCE_EXHAUSTED / 429 / exhausted-quota map to quota_exhausted", () => {
    for (const msg of [
      "RESOURCE_EXHAUSTED: quota",
      "HTTP 429 Too Many Requests",
      "You have exhausted your quota on this model.",
    ]) {
      const { outcome } = replay([], [`AGY_ERROR: ${json({ short_error: msg })}`], 3);
      expect(outcome).toMatchObject({
        outcome: "quota_exhausted",
        quotaSignal: { source: "agy.agy_error.quota", raw: msg },
      });
    }
    // an ERROR result carrying the quota text counts too
    const viaResult = replay([result({ status: "ERROR", error: "RESOURCE_EXHAUSTED" })], [], 3);
    expect(viaResult.outcome.outcome).toBe("quota_exhausted");
  });

  it("[UC4] quota: 'Resets in 2h39m' becomes resetAt relative to the run's end time", () => {
    const msg = "You have exhausted your quota on this model. Resets in 2h39m.";
    const { outcome } = replay([], [`AGY_ERROR: ${json({ short_error: msg })}`], 3);
    expect(outcome.resetAt).toBe("2026-11-07T12:39:00.000Z");
    // without endedAt the reset stays unknown instead of reading a clock
    const ctx = ctxOf({ endedAt: undefined });
    expect(
      replay([], [`AGY_ERROR: ${json({ short_error: msg })}`], 3, {}, ctx).outcome.resetAt,
    ).toBeUndefined();
  });

  it("parses reset phrases", () => {
    expect(parseResetDelayMs("Resets in 2h39m")).toBe((2 * 60 + 39) * 60_000);
    expect(parseResetDelayMs("resets in 1 day 2 hours")).toBe(26 * 3_600_000);
    expect(parseResetDelayMs("Resets in 45 seconds.")).toBe(45_000);
    expect(parseResetDelayMs("resets in 0m")).toBeNull();
    expect(parseResetDelayMs("no reset info")).toBeNull();
  });

  it("[UC4] timeouts: runner kill, or --print-timeout on stderr (exit 3)", () => {
    expect(replay(ok.slice(0, 2), [], null, { timedOut: true }).outcome).toMatchObject({
      outcome: "timeout",
      nativeError: "killed by the runner timeout",
    });
    const printTimeout = replay(
      [],
      [`AGY_ERROR: ${json({ short_error: "print timeout exceeded (120s)" })}`],
      3,
    );
    expect(printTimeout.outcome).toMatchObject({
      outcome: "timeout",
      nativeError: "print timeout exceeded (120s)",
    });
    expect(replay([], ["error: print-timeout reached"], 3).outcome.outcome).toBe("timeout");
  });

  it("[UC4] an AGY_ERROR that is not quota or timeout is failed with its text", () => {
    const { outcome } = replay([], [`AGY_ERROR: ${json({ short_error: "model unavailable" })}`], 3);
    expect(outcome).toMatchObject({ outcome: "failed", nativeError: "model unavailable" });
    const raw = replay([], ["AGY_ERROR: not json"], 3).outcome;
    expect(raw.nativeError).toBe("not json");
  });

  it("bounds the retained stderr tail", () => {
    const ctx = ctxOf();
    for (let i = 0; i < 50; i++) adapter.parseLine("stderr", `line ${i}`, ctx);
    const { outcome } = replay([], [], 1, {}, ctx);
    expect(outcome.nativeError).toBe("line 49");
  });
});

describe("agy parseLine tolerance", () => {
  const junk = [
    "",
    "   ",
    "WARNING: not json at all",
    '{"event":"step_update","step_update":{"step_i',
    "null",
    "42",
    '"text"',
    "[1,2,3]",
    json({ event: "zz_unknown", payload: {} }),
    json({ type: "init" }),
    json({ event: "init" }),
    json({ event: "step_update" }),
    json({ event: "step_update", step_update: { step_type: "tool", state: "WEIRD" } }),
    json({ event: "step_update", step_update: { step_type: "tool", state: "DONE" } }),
    json({ event: "step_update", step_update: { step_type: "mystery" } }),
    json({ event: "result" }),
    json({ event: "result", result: { denied_actions: "nope", usage: 5 } }),
  ];

  it("[UC4] never throws and yields schema-valid events for junk", () => {
    const ctx = ctxOf();
    for (const stream of ["stdout", "stderr"] as const) {
      for (const line of junk) {
        const events = adapter.parseLine(stream, line, ctx);
        expect(events.every((e) => NormalizedEventSchema.safeParse(e).success)).toBe(true);
      }
    }
    expect(() =>
      adapter.finalize({ exitCode: 1, signal: null, timedOut: false, durationMs: 1 }, ctx),
    ).not.toThrow();
  });

  it("[UC4] never throws for arbitrary strings and JSON values", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc.json(),
          fc.json().map((s) => `{"event":"result","result":${s}}`),
        ),
        fc.constantFrom("stdout", "stderr"),
        (line, stream) => {
          const ctx = ctxOf();
          adapter.parseLine(stream, line, ctx);
          const out = adapter.finalize(
            { exitCode: 0, signal: null, timedOut: false, durationMs: 0 },
            ctx,
          );
          expect(AdapterOutcomeSchema.safeParse(out).success).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("stamps events from the system clock when the runner gave none", () => {
    const ctx: AdapterRunContext = { runId: "r", worktree: WT, scratch: { now: () => "bad" } };
    const [e] = adapter.parseLine("stdout", json({ event: "init", init: {} }), ctx);
    expect(e && NormalizedEventSchema.safeParse(e).success).toBe(true);
    expect(e?.detail).toBe("init");
  });
});

describe("agy version range", () => {
  it("[UC4] satisfies >=1.5.2 <1.6 only inside the range", () => {
    const r = AGY_CAPABILITIES.cliRange;
    expect(satisfiesRange("1.5.2", r)).toBe(true);
    expect(satisfiesRange("1.5.9", r)).toBe(true);
    expect(satisfiesRange("1.5.1", r)).toBe(false);
    expect(satisfiesRange("1.6.0", r)).toBe(false);
    expect(satisfiesRange("2.0.0", r)).toBe(false);
    expect(satisfiesRange("garbage", r)).toBe(false);
    expect(satisfiesRange("1.5.2", "")).toBe(false);
    expect(satisfiesRange("1.5.2", "~~")).toBe(false);
    expect(satisfiesRange("1.5.2", ">1.5.1 <=1.5.2")).toBe(true);
    expect(satisfiesRange("1.5.2", "=1.5.2")).toBe(true);
    expect(satisfiesRange("1.5", "1.5.0")).toBe(true);
  });
});

const HELP = [
  "Usage: agy [flags]",
  "  -p, --print string       run headless",
  "      --output-format      text|json|stream-json",
  "      --sandbox            run in sandbox",
  "      --disable-slash-commands",
  "      --model --effort --print-timeout",
  "      --dangerously-skip-permissions",
];

function deps(spawner: Spawner, binary: string | null = "/opt/homebrew/bin/agy"): AdapterDeps {
  return {
    spawner,
    clock: new FakeClock(),
    resolveBinary: async () => binary,
  };
}

describe("agy probe (scripted spawner)", () => {
  it("[UC4] reads version, flags and login; reports no range violation for 1.5.2", async () => {
    const spawner = new ScriptedSpawner([
      { stdout: ["1.5.2"] },
      { stdout: HELP },
      { stdout: [JSON.stringify({ status: "SUCCESS", response: "x" })] },
    ]);
    const p = await adapter.probe(instance, deps(spawner));
    expect(p).toMatchObject({
      binaryPath: "/opt/homebrew/bin/agy",
      version: "1.5.2",
      loggedIn: true,
      outsideCliRange: false,
      features: [],
    });
    expect(p.flags).toEqual(expect.arrayContaining([...REQUIRED_FLAGS, "--print"]));
    expect(spawner.requests.map((r) => r.argv)).toEqual([
      ["--version"],
      ["--help"],
      ["-p=/usage", "--output-format", "json"],
    ]);
    for (const req of spawner.requests) {
      expect(Object.keys(req.env).some((k) => k.startsWith("ANTIGRAVITY_"))).toBe(false);
      expect(req.argv).not.toContain("--dangerously-skip-permissions");
    }
  });

  it("[UC4] flags an auto-updated version outside the range", async () => {
    for (const v of ["1.6.0", "1.4.9"]) {
      const spawner = new ScriptedSpawner([{ stdout: [`agy ${v}`] }, { stdout: HELP }, {}]);
      expect((await adapter.probe(instance, deps(spawner))).outsideCliRange).toBe(true);
    }
    const unreadable = new ScriptedSpawner([{ stdout: ["???"] }, { stdout: HELP }, {}]);
    const p = await adapter.probe(instance, deps(unreadable));
    expect(p).toMatchObject({ version: null, outsideCliRange: true, loggedIn: null });
  });

  it("[UC4] logged out on an auth AGY_ERROR, unknown on other failures", async () => {
    const login = async (stderr: string[], stdout: string[] = []) =>
      (
        await adapter.probe(
          instance,
          deps(new ScriptedSpawner([{ stdout: ["1.5.2"] }, { stdout: HELP }, { stdout, stderr }])),
        )
      ).loggedIn;
    expect(await login(['AGY_ERROR: {"short_error":"You are not logged in."}'])).toBe(false);
    expect(await login(['AGY_ERROR: {"short_error":"network down"}'])).toBeNull();
    expect(await login([], ["not json", "{"])).toBeNull();
  });

  it("returns an empty probe when agy is not installed", async () => {
    const spawner = new ScriptedSpawner();
    const p = await adapter.probe(instance, deps(spawner, null));
    expect(p).toMatchObject({ binaryPath: null, version: null, loggedIn: null });
    expect(p.outsideCliRange).toBe(false);
    expect(spawner.requests).toHaveLength(0);
  });

  it("survives a spawner that throws", async () => {
    const boom: Spawner = {
      spawn: async () => {
        throw new Error("spawn failed");
      },
    };
    const p = await adapter.probe(instance, deps(boom));
    expect(p).toMatchObject({ version: null, flags: [], loggedIn: null, outsideCliRange: true });
  });
});

/** Real process spawner for tests only (src/runner owns the production one). */
const processSpawner: Spawner = {
  spawn: (req: SpawnRequest) =>
    new Promise<SpawnResult>((resolve, reject) => {
      const child = spawn(req.binary, [...req.argv], {
        cwd: req.cwd,
        env: { ...req.env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      for (const stream of ["stdout", "stderr"] as const) {
        let buf = "";
        child[stream].setEncoding("utf8").on("data", (d: string) => {
          buf += d;
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const l of lines) req.onLine?.(stream, l);
        });
        child[stream].on("end", () => buf && req.onLine?.(stream, buf));
      }
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut: false }));
    }),
};

describe("agy probe (fake CLI)", () => {
  it("[UC4] probes the fake agy: version, help flags, /usage login", async () => {
    await withFakes({ "agy:help": { stdout: `${HELP.join("\n")}\n` } }, async (ctx) => {
      const p = await adapter.probe(instance, deps(processSpawner, join(ctx.binDir, "agy")));
      expect(p).toMatchObject({ version: "1.5.2", loggedIn: true, outsideCliRange: false });
      expect(p.flags).toContain("--disable-slash-commands");
      expect(ctx.readLog({ cli: "agy" }).map((i) => i.key)).toEqual(["version", "help", "usage"]);
    });
  });

  it("[UC4] reports logged out when the fake /usage is unauthenticated", async () => {
    await withFakes(
      {
        "agy:help": { stdout: `${HELP.join("\n")}\n` },
        "agy:usage": { variant: "unauthenticated" },
      },
      async (ctx) => {
        const p = await adapter.probe(instance, deps(processSpawner, join(ctx.binDir, "agy")));
        expect(p.loggedIn).toBe(false);
      },
    );
  });
});

describe("agy fake CLI replay", () => {
  it("[UC4] feeds a fake agy run through parseLine + finalize (quota)", async () => {
    await withFakes({ agy: [{ scenario: "quota_exhausted" }] }, async (ctx) => {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const r = await processSpawner.spawn({
        binary: join(ctx.binDir, "agy"),
        argv: ["-p=x"],
        env: { ...(process.env as Record<string, string>) },
        cwd: ctx.stateDir,
        onLine: (s, l) => (s === "stdout" ? stdout : stderr).push(l),
      });
      const out = replay(stdout, stderr, r.exitCode);
      expect(out.outcome.outcome).toBe("quota_exhausted");
    });
  });

  it("[UC4] tolerates the fake 'malformed' scenario", async () => {
    await withFakes({ agy: [{ scenario: "malformed" }] }, async (ctx) => {
      const stdout: string[] = [];
      const r = await processSpawner.spawn({
        binary: join(ctx.binDir, "agy"),
        argv: ["-p=x"],
        env: { ...(process.env as Record<string, string>) },
        cwd: ctx.stateDir,
        onLine: (s, l) => s === "stdout" && stdout.push(l),
      });
      const out = replay(stdout, [], r.exitCode);
      expect(out.outcome.outcome).toBe("failed");
    });
  });
});
