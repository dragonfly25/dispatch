import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CODEX_CAPABILITIES,
  CODEX_SIDE_EFFECT_GUARDS,
  codexVersionInRange,
  createCodexAdapter,
  parseResetAt,
  tomlString,
  untrustedProjectsOverride,
  wrapPrompt,
} from "../../../src/adapters/codex/index.js";
import { parseFeatureList, parseHelpFlags, probeCodex } from "../../../src/adapters/codex/probe.js";
import {
  AdapterCapabilitiesSchema,
  type AdapterDeps,
  AdapterOutcomeSchema,
  type AdapterRunContext,
  type BuildInvocationArgs,
  type Invocation,
  InvocationSchema,
  NormalizedEventSchema,
  type ProviderInstance,
  type Spawner,
  type SpawnRequest,
  type SpawnResult,
} from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import { toSpawnCommand } from "../../../src/platform/spawnable.js";
import { probeResult, task } from "../../fixtures/contracts.js";
import { FakeClock, ScriptedSpawner } from "../../stubs/index.js";
import { withFakes } from "../../support/index.js";

const adapter = createCodexAdapter();
/** Builds the POSIX argv on any host (Windows adds its sandbox override; codex-windows tests cover it). */
const posix = createCodexAdapter({ platform: "linux" });
const FIXTURES = join(import.meta.dirname, "..", "..", "fixtures", "codex", "0.167.0");
const WT = "/work/repo/.dispatch/wt/run1";
const ROOT = "/work/repo";
const RUN_DIR = "/home/u/.dispatch/runs/run1";
const instance: ProviderInstance = { id: "codex", adapter: "codex", pool: "subscription" };

function args(over: Partial<BuildInvocationArgs> = {}): BuildInvocationArgs {
  return {
    task,
    target: { instance: "codex", tier: "fast", model: "gpt-6-luna", effort: "low" },
    autonomy: "worktree",
    worktree: WT,
    repoRoot: ROOT,
    runDir: RUN_DIR,
    instance,
    probe: { ...probeResult, binaryPath: "/opt/homebrew/bin/codex" },
    baseEnv: { PATH: "/usr/bin:/bin", HOME: "/home/u", DISPATCH_DEPTH: "1" },
    ...over,
  };
}

function ctx(worktree = WT, scratch: Record<string, unknown> = {}): AdapterRunContext {
  return { runId: "run1", worktree, scratch: { clock: new FakeClock(), ...scratch } };
}

const done = (over: Partial<SpawnResult> = {}) => ({
  exitCode: 0,
  signal: null,
  timedOut: false,
  durationMs: 1234,
  ...over,
});

function replay(lines: string[], c: AdapterRunContext) {
  return lines.flatMap((l) => adapter.parseLine("stdout", l, c));
}

/** Expected argv for a full feature list; only `-s` differs between autonomy levels. */
function golden(sandbox: string): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--disable",
    "hooks",
    "--disable",
    "plugins",
    "--disable",
    "apps",
    "--disable",
    "memories",
    "-c",
    "agents.enabled=false",
    "-c",
    `projects={"${WT}"={trust_level="untrusted"},"${ROOT}"={trust_level="untrusted"}}`,
    "-C",
    WT,
    "-m",
    "gpt-6-luna",
    "-c",
    "model_reasoning_effort=low",
    "-o",
    `${RUN_DIR}/last.txt`,
    "-s",
    sandbox,
    "-",
  ];
}

describe("codex capabilities", () => {
  it("are valid and match the spike [UC13]", () => {
    expect(AdapterCapabilitiesSchema.parse(CODEX_CAPABILITIES)).toEqual(CODEX_CAPABILITIES);
    expect(adapter.caps).toMatchObject({
      id: "codex",
      cliRange: ">=0.167.0 <0.168",
      quotaChannel: "reader",
      promptChannel: "stdin",
      sandbox: "os",
      childNetwork: "none",
      autonomy: ["read-only", "worktree"],
    });
    expect(adapter.readQuota).toBeUndefined();
  });
});

describe("codex buildInvocation", () => {
  it.each([
    ["worktree", "workspace-write"],
    ["read-only", "read-only"],
  ] as const)("golden argv for %s autonomy [UC2] [SEC-trust]", (autonomy, sandbox) => {
    const inv = posix.buildInvocation(args({ autonomy }));
    expect(InvocationSchema.parse(inv)).toEqual(inv);
    expect(inv.argv).toEqual(golden(sandbox));
    expect(inv.binary).toBe("/opt/homebrew/bin/codex");
    expect(inv.cwd).toBe(WT);
    expect(inv.outputFile).toBe(`${RUN_DIR}/last.txt`);
    expect(inv.redactArgvIndexes).toEqual([]);
    expect(inv.sideEffectGuards).toEqual([
      "codex-project-trust-untrusted",
      "codex-agents-disabled",
      "codex-user-config-ignored",
    ]);
  });

  it("always carries every side-effect guard, for any paths and feature set [SEC-trust]", () => {
    const pathArb = fc.string({ minLength: 1 }).map((s) => `/${s}`);
    fc.assert(
      fc.property(
        pathArb,
        pathArb,
        fc.constantFrom("read-only", "worktree") as fc.Arbitrary<"read-only" | "worktree">,
        fc.subarray(["apps", "memories", "multi_agent"]),
        (wt, root, autonomy, extra) => {
          const probe = { ...probeResult, features: ["hooks", "plugins", ...extra] };
          const inv = posix.buildInvocation(
            args({ worktree: wt, repoRoot: root, autonomy, probe }),
          );
          const a = inv.argv;
          const flagValue = (flag: string, value: string) =>
            a.some((x, i) => x === flag && a[i + 1] === value);
          expect(inv.sideEffectGuards).toEqual([...CODEX_SIDE_EFFECT_GUARDS]);
          expect(flagValue("-c", untrustedProjectsOverride([wt, root]))).toBe(true);
          expect(flagValue("-c", "agents.enabled=false")).toBe(true);
          expect(flagValue("--disable", "hooks")).toBe(true);
          expect(flagValue("--disable", "plugins")).toBe(true);
          for (const f of [
            "--ignore-user-config",
            "--ignore-rules",
            "--strict-config",
            "--ephemeral",
          ])
            expect(a).toContain(f);
          expect(a.at(-1)).toBe("-");
        },
      ),
    );
  });

  it("escapes quotes, backslashes and control chars in the projects override [SEC-trust]", () => {
    const wt = '/tmp/we"ird\\path\n},"x"={trust_level="trusted"}';
    const override = untrustedProjectsOverride([wt, ROOT]);
    expect(override).toBe(
      `projects={"/tmp/we\\"ird\\\\path\\u000a},\\"x\\"={trust_level=\\"trusted\\"}"={trust_level="untrusted"},"${ROOT}"={trust_level="untrusted"}}`,
    );
    // Decoding the TOML basic string (JSON-compatible escapes here) gives back the raw path.
    expect(JSON.parse(tomlString(wt))).toBe(wt);
    expect(tomlString("a\u007fb")).toBe('"a\\u007fb"');
  });

  it("deduplicates the override when the worktree is the repo root", () => {
    expect(untrustedProjectsOverride([ROOT, ROOT])).toBe(
      `projects={"${ROOT}"={trust_level="untrusted"}}`,
    );
  });

  it("sets CODEX_HOME only for an instance with a config dir [UC12]", () => {
    const plain = posix.buildInvocation(args());
    expect(plain.env).toEqual({ PATH: "/usr/bin:/bin", HOME: "/home/u", DISPATCH_DEPTH: "1" });
    const alt = posix.buildInvocation(
      args({ instance: { ...instance, id: "codex-alt", configDir: "/home/u/.codex-alt" } }),
    );
    expect(alt.env.CODEX_HOME).toBe("/home/u/.codex-alt");
    expect(alt.env.DISPATCH_DEPTH).toBe("1");
  });

  it("puts the wrapped prompt on stdin [UC2]", () => {
    const inv = posix.buildInvocation(args());
    expect(inv.stdin).toBe(wrapPrompt(task.prompt));
    expect(inv.stdin).toContain("Do not run `dispatch`");
    expect(inv.stdin?.endsWith(task.prompt)).toBe(true);
    expect(inv.argv.join(" ")).not.toContain(task.prompt);
  });

  it("omits optional --disable names the CLI does not list", () => {
    const probe = { ...probeResult, features: ["hooks", "plugins"] };
    const inv = posix.buildInvocation(args({ probe }));
    expect(inv.argv.filter((_x, i) => inv.argv[i - 1] === "--disable")).toEqual([
      "hooks",
      "plugins",
    ]);
  });

  it.each([
    ["direct autonomy", args({ autonomy: "direct" }), "adapter.autonomy_unsupported"],
    [
      "missing hooks feature",
      args({ probe: { ...probeResult, features: ["plugins"] } }),
      "adapter.codex.feature_missing",
    ],
    [
      "empty feature list",
      args({ probe: { ...probeResult, features: [] } }),
      "adapter.codex.feature_missing",
    ],
    ["no binary", args({ probe: { ...probeResult, binaryPath: null } }), "adapter.codex.no_binary"],
    [
      "flag-like model",
      args({ target: { instance: "codex", tier: "fast", model: "--yolo", effort: "low" } }),
      "adapter.codex.invalid_target",
    ],
    [
      "TOML in effort",
      args({ target: { instance: "codex", tier: "fast", model: "m", effort: 'x"\nprojects={}' } }),
      "adapter.codex.invalid_target",
    ],
  ])("fails closed on %s [SEC-trust]", (_name, a, code) => {
    expect(() => posix.buildInvocation(a)).toThrow(DispatchError);
    try {
      posix.buildInvocation(a);
    } catch (err) {
      expect((err as DispatchError).code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------- fixtures

interface Meta {
  exitCode: number;
  argv: string[];
}

const fixtureNames = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".stdout.jsonl"))
  .map((f) => f.replace(".stdout.jsonl", ""));

const EXPECTED: Record<string, { outcome: string; summary?: RegExp; edits?: string[] }> = {
  edit_workspace_write: {
    outcome: "success",
    summary: /Added and exported `sub/,
    edits: ["math.js"],
  },
  invalid_model_turn_failed: { outcome: "failed", summary: /not supported/ },
  quota_exhausted: { outcome: "quota_exhausted" },
  spawn_agent_v2_hook_deny: { outcome: "success", summary: /Tool call blocked/ },
  spawn_agent_v2_hook_deny_redirect: { outcome: "success", summary: /HEAD finds its way home/ },
  spawn_agent_v2_hook_updated_input: { outcome: "success", summary: /Agent errored/ },
  spawn_agent_v2_unmatched_hook: { outcome: "success", summary: /^pong$/ },
};

describe("codex fixtures replay [UC2] [UC4]", () => {
  it("covers every recorded stream fixture", () => {
    expect(fixtureNames.sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  it.each(fixtureNames)("%s", (name) => {
    const meta = JSON.parse(readFileSync(join(FIXTURES, `${name}.meta.json`), "utf8")) as Meta;
    const tmp = "/fixture-tmp";
    const raw = readFileSync(join(FIXTURES, `${name}.stdout.jsonl`), "utf8").replaceAll(
      "<TMP>",
      tmp,
    );
    const cIdx = meta.argv.indexOf("-C");
    const worktree = (meta.argv[cIdx + 1] ?? WT).replaceAll("<TMP>", tmp).replace("<WT>", WT);
    const c = ctx(worktree);
    const events = replay(raw.split("\n"), c);
    for (const e of events) expect(NormalizedEventSchema.parse(e)).toEqual(e);
    const stderr = readFileSync(join(FIXTURES, `${name}.stderr.txt`), "utf8");
    for (const l of stderr.split("\n")) expect(adapter.parseLine("stderr", l, c)).toEqual([]);

    const out = adapter.finalize(done({ exitCode: meta.exitCode }), c);
    expect(AdapterOutcomeSchema.parse(out)).toEqual(out);
    const exp = EXPECTED[name];
    expect(out.outcome).toBe(exp?.outcome);
    if (exp?.summary) expect(out.summary).toMatch(exp.summary);
    if (exp?.edits) {
      expect(events.filter((e) => e.kind === "editing").map((e) => e.path)).toEqual(exp.edits);
    }
    if (out.outcome === "success") {
      expect(out.usage?.inputTokens).toBeGreaterThan(0);
      expect(events.at(-1)?.kind).toBe("done");
    }
  });

  it("maps the edit run to running/editing/thinking events and sums usage", () => {
    const raw = readFileSync(
      join(FIXTURES, "edit_workspace_write.stdout.jsonl"),
      "utf8",
    ).replaceAll("<TMP>", "/t");
    const c = ctx("/t/cx-edit");
    const events = replay(raw.split("\n"), c);
    expect(events.map((e) => e.kind)).toEqual([
      "thinking",
      "running",
      "running",
      "editing",
      "running",
      "thinking",
      "done",
    ]);
    expect(events[1]?.detail).toContain("rg --files");
    expect(events.every((e) => e.ts === "2026-01-01T00:00:00.000Z")).toBe(true);
    const out = adapter.finalize(done(), c);
    expect(out.usage).toMatchObject({ inputTokens: 76187, cachedTokens: 67072, outputTokens: 401 });
    expect(out.deniedActions).toEqual([]);
    expect(out.durationMs).toBe(1234);
  });

  it("classifies the usage-limit fixture as quota_exhausted with resetAt [UC4]", () => {
    const raw = readFileSync(join(FIXTURES, "quota_exhausted.stdout.jsonl"), "utf8");
    const clock = new FakeClock(new Date(2026, 10, 7, 9, 0));
    const c = ctx(WT, { clock });
    replay(raw.split("\n"), c);
    const out = adapter.finalize(done({ exitCode: 1 }), c);
    expect(out.outcome).toBe("quota_exhausted");
    expect(out.quotaSignal).toEqual({
      source: "codex.turn_failed.usage_limit",
      raw: "You’ve hit your usage limit. Try again at 3:05 PM.",
    });
    expect(out.resetAt).toBe(new Date(2026, 10, 7, 15, 5).toISOString());
  });
});

// ---------------------------------------------------------------- parse / finalize details

describe("codex parseLine / finalize", () => {
  const line = (o: unknown) => JSON.stringify(o);

  it("never throws on malformed or unknown input [UC13]", () => {
    const c = ctx();
    for (const l of [
      "",
      "not json",
      "{broken",
      "[1,2]",
      "{}",
      "null",
      line({ type: "zz_unknown" }),
      line({ type: "item.completed" }),
      line({ type: "item.completed", item: { type: "todo_list", items: [] } }),
      line({ type: "item.started", item: { type: "file_change", changes: "nope" } }),
      line({ type: "turn.completed", usage: { input_tokens: -5, output_tokens: "x" } }),
      line({ type: "turn.failed" }),
      line({ type: "error" }),
    ]) {
      expect(() => adapter.parseLine("stdout", l, c)).not.toThrow();
    }
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (s) => {
        const evs = adapter.parseLine("stdout", s, ctx());
        for (const e of evs) NormalizedEventSchema.parse(e);
      }),
    );
  });

  it("maps reasoning, mcp, web_search and item errors; ignores todo_list", () => {
    const c = ctx();
    const evs = replay(
      [
        line({ type: "item.started", item: { id: "r", type: "reasoning", text: "x".repeat(500) } }),
        line({ type: "item.completed", item: { id: "r", type: "reasoning", text: "x" } }),
        line({
          type: "item.started",
          item: { id: "m", type: "mcp_tool_call", server: "s", tool: "t" },
        }),
        line({
          type: "item.updated",
          item: { id: "m", type: "mcp_tool_call", server: "s", tool: "t" },
        }),
        line({ type: "item.started", item: { id: "w", type: "web_search", query: "q" } }),
        line({ type: "item.updated", item: { id: "td", type: "todo_list", items: [] } }),
        line({ type: "item.completed", item: { id: "e", type: "error", message: "warn" } }),
        line({ type: "item.started", item: { id: "rx", type: "reasoning" } }),
      ],
      c,
    );
    expect(evs.map((e) => [e.kind, e.detail?.length ?? 0])).toEqual([
      ["thinking", 200],
      ["running", 7],
      ["running", 12],
      ["error", 4],
      ["thinking", 0],
    ]);
  });

  it("relativizes file_change paths and keeps outside paths absolute", () => {
    const c = ctx();
    const evs = adapter.parseLine(
      "stdout",
      line({
        type: "item.completed",
        item: {
          id: "f",
          type: "file_change",
          status: "completed",
          changes: [
            { path: `${WT}/src/a.ts`, kind: "add" },
            { path: "/etc/hosts", kind: "update" },
            { path: "rel/b.ts" },
            { path: WT, kind: "update" },
          ],
        },
      }),
      c,
    );
    expect(evs.map((e) => [e.kind, e.path, e.detail])).toEqual([
      ["editing", "src/a.ts", "add"],
      ["editing", "/etc/hosts", "update"],
      ["editing", "rel/b.ts", "update"],
      ["editing", ".", "update"],
    ]);
  });

  it("reports declined commands and edits as denied; denied with no output is failed", () => {
    const c = ctx();
    const evs = replay(
      [
        line({
          type: "item.started",
          item: { id: "c", type: "command_execution", command: "rm x" },
        }),
        line({
          type: "item.completed",
          item: { id: "c", type: "command_execution", command: "rm x", status: "declined" },
        }),
        line({
          type: "item.completed",
          item: {
            id: "f",
            type: "file_change",
            status: "declined",
            changes: [{ path: `${WT}/a` }],
          },
        }),
        line({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }),
      ],
      c,
    );
    expect(evs.map((e) => e.kind)).toEqual(["running", "denied", "denied", "done"]);
    const out = adapter.finalize(done(), c);
    expect(out.outcome).toBe("failed");
    expect(out.deniedActions).toEqual(["command: rm x", "edit: a"]);
  });

  it("prefers the -o output file content as summary", () => {
    const c = ctx(WT, { outputFileContent: "  final from file\n" });
    adapter.parseLine(
      "stdout",
      line({ type: "item.completed", item: { id: "a", type: "agent_message", text: "stream" } }),
      c,
    );
    expect(adapter.finalize(done(), c).summary).toBe("final from file");
    const c2 = ctx(WT, { outputFileContent: "   " });
    adapter.parseLine(
      "stdout",
      line({ type: "item.completed", item: { id: "a", type: "agent_message", text: "stream" } }),
      c2,
    );
    expect(adapter.finalize(done(), c2).summary).toBe("stream");
  });

  it("classifies timeout, signal and bare non-zero exits", () => {
    expect(
      adapter.finalize(done({ timedOut: true, exitCode: null, signal: "SIGKILL" }), ctx()).outcome,
    ).toBe("timeout");
    const sig = adapter.finalize(done({ exitCode: null, signal: "SIGTERM" }), ctx());
    expect(sig).toMatchObject({ outcome: "failed", nativeError: "killed by SIGTERM" });
    const c = ctx();
    adapter.parseLine("stderr", "boom: bad config", c);
    adapter.parseLine("stderr", "  ", c);
    expect(adapter.finalize(done({ exitCode: 2 }), c)).toMatchObject({
      outcome: "failed",
      nativeError: "boom: bad config",
      summary: "boom: bad config",
    });
    expect(adapter.finalize(done({ exitCode: 1 }), ctx())).toMatchObject({
      outcome: "failed",
      nativeError: "exit code 1",
    });
    const e = ctx();
    adapter.parseLine("stdout", line({ type: "error", message: "stream disconnected" }), e);
    expect(adapter.finalize(done({ exitCode: 1 }), e).nativeError).toBe("stream disconnected");
    expect(adapter.finalize(done(), ctx())).toMatchObject({ outcome: "success", summary: "" });
    expect(adapter.finalize(done(), ctx()).usage).toBeUndefined();
  });

  it("keeps only the stderr tail", () => {
    const c = ctx();
    for (let i = 0; i < 30; i++) adapter.parseLine("stderr", `line ${i}`, c);
    expect(adapter.finalize(done({ exitCode: 3 }), c).nativeError).toBe("line 29");
  });

  it.each([
    ["You've hit your usage limit. Upgrade to Pro or try again later.", undefined],
    ["Your workspace is out of credits. Add credits to continue.", undefined],
    ["You hit your spend cap for this month.", undefined],
  ])("detects quota message %j (straight apostrophe, workspace variants) [UC4]", (msg) => {
    const c = ctx();
    adapter.parseLine("stdout", line({ type: "turn.failed", error: { message: msg } }), c);
    const out = adapter.finalize(done({ exitCode: 1 }), c);
    expect(out).toMatchObject({
      outcome: "quota_exhausted",
      quotaSignal: { source: "codex.turn_failed.usage_limit", raw: msg },
    });
    expect(out.resetAt).toBeUndefined();
  });

  it("detects a usage-limit message that only reached stderr [UC4]", () => {
    const c = ctx();
    adapter.parseLine("stderr", "ERROR: You’ve hit your usage limit. Try again at 11:59 PM.", c);
    expect(adapter.finalize(done({ exitCode: 1 }), c).outcome).toBe("quota_exhausted");
  });
});

describe("parseResetAt", () => {
  const now = new Date(2026, 10, 7, 16, 0);
  it("parses today's time, rolling to tomorrow when already past", () => {
    expect(parseResetAt("Try again at 5:30 PM.", now)).toBe(
      new Date(2026, 10, 7, 17, 30).toISOString(),
    );
    expect(parseResetAt("try again at 3:05 pm", now)).toBe(
      new Date(2026, 10, 8, 15, 5).toISOString(),
    );
    expect(parseResetAt("Try again at 12:10 AM.", now)).toBe(
      new Date(2026, 10, 8, 0, 10).toISOString(),
    );
  });
  it("parses a dated reset", () => {
    expect(parseResetAt("or try again at Nov 9th, 2026 3:05 PM.", now)).toBe(
      new Date(2026, 10, 9, 15, 5).toISOString(),
    );
  });
  it("returns undefined for unparseable times", () => {
    expect(parseResetAt("Try again later.", now)).toBeUndefined();
    expect(parseResetAt("Try again at 13:05 PM.", now)).toBeUndefined();
    expect(parseResetAt("Try again at Foo 9th, 2026 3:05 PM.", now)).toBeUndefined();
  });
});

// ---------------------------------------------------------------- probe

/** Minimal real Spawner for tests (only src/runner may spawn in production code). */
const testSpawner: Spawner & { requests: SpawnRequest[] } = {
  requests: [],
  spawn(req) {
    this.requests.push(req);
    return new Promise((resolve, reject) => {
      // Windows: the fake is an npm cmd-shim, unwrapped to `node <script>` like production does.
      const { command, args: argv } = toSpawnCommand(req.binary, req.argv);
      const child = spawn(command, argv, { cwd: req.cwd, env: req.env });
      const pipe = (stream: "stdout" | "stderr") =>
        createInterface({ input: child[stream] }).on("line", (l) => req.onLine?.(stream, l));
      pipe("stdout");
      pipe("stderr");
      child.on("error", reject);
      child.on("close", (exitCode, signal) => resolve({ exitCode, signal, timedOut: false }));
      child.stdin.end(req.stdin ?? "");
    });
  },
};

const HELP = `Run Codex non-interactively

Usage: codex exec [OPTIONS] [PROMPT]

Options:
  -c, --config <key=value>   Override a configuration value
      --enable <FEATURE>     Enable a feature
      --disable <FEATURE>    Disable a feature
  -m, --model <MODEL>        Model
  -s, --sandbox <MODE>       [possible values: read-only, workspace-write]
  -C, --cd <DIR>             Working root
      --json                 Print events to stdout as JSONL
      --ephemeral            Do not persist session files
      --ignore-user-config   Ignore $CODEX_HOME/config.toml
      --ignore-rules         Ignore user and project rules
      --strict-config        Fail on unknown config keys
  -o, --output-last-message <FILE>
`;

describe("codex probe", () => {
  it("parses version, flags, features and login via the fake CLI [UC13]", async () => {
    await withFakes({ "codex:help": { stdout: HELP } }, async ({ bin, env, readLog }) => {
      const deps: AdapterDeps = {
        spawner: testSpawner,
        clock: new FakeClock(),
        resolveBinary: async () => bin("codex"),
      };
      const alt = { ...instance, configDir: "/tmp/codex-alt-home" };
      const res = await probeCodex(alt, deps, {
        ...env,
        HOME: "/tmp/no-home",
        SECRET_TOKEN: "x",
      });
      expect(res).toMatchObject({
        binaryPath: bin("codex"),
        version: "0.167.0",
        features: [
          "hooks",
          "plugins",
          "multi_agent",
          "multi_agent_v2",
          "apps",
          "unified_exec",
          "memories",
        ],
        loggedIn: true,
        outsideCliRange: false,
      });
      // POSIX: a symlink into test/fakes/bin; Windows: a copy of the cmd-shim in the temp bin dir.
      expect(res.realpath).toMatch(
        process.platform === "win32" ? /codex\.cmd$/i : /test\/fakes\/bin\/codex$/,
      );
      for (const f of [
        "--json",
        "--ephemeral",
        "--ignore-user-config",
        "--strict-config",
        "--disable",
        "-C",
        "-o",
        "-s",
      ])
        expect(res.flags).toContain(f);
      const calls = readLog({ cli: "codex" });
      expect(calls.map((c) => c.args.join(" "))).toEqual([
        "--version",
        "exec --help",
        "features list",
        "login status",
      ]);
      expect(calls.every((c) => c.env.CODEX_HOME === "/tmp/codex-alt-home")).toBe(true);
      expect(calls.every((c) => c.env.SECRET_TOKEN === undefined)).toBe(true);
      // The probed result feeds buildInvocation directly.
      expect(posix.buildInvocation(args({ probe: res })).argv).toEqual(golden("workspace-write"));
    });
  });

  it("reports logged-out from the fake CLI", async () => {
    await withFakes({ "codex:login": { loggedIn: false } }, async ({ bin }) => {
      const deps: AdapterDeps = {
        spawner: testSpawner,
        clock: new FakeClock(),
        resolveBinary: async () => bin("codex"),
      };
      expect((await adapter.probe(instance, deps)).loggedIn).toBe(false);
    });
  });

  it("returns an empty result when the binary is missing", async () => {
    const deps: AdapterDeps = {
      spawner: new ScriptedSpawner(),
      clock: new FakeClock(),
      resolveBinary: async () => null,
    };
    expect(await adapter.probe(instance, deps)).toEqual({
      binaryPath: null,
      realpath: null,
      version: null,
      flags: [],
      features: [],
      loggedIn: null,
      outsideCliRange: false,
    });
  });

  it("flags out-of-range versions and tolerates failing subcommands", async () => {
    const spawner = new ScriptedSpawner([
      { stdout: ["codex-cli 0.170.2"] },
      { result: { exitCode: 2 } },
      { result: { exitCode: null, timedOut: true } },
      { result: { exitCode: 3 } },
    ]);
    const deps: AdapterDeps = {
      spawner,
      clock: new FakeClock(),
      resolveBinary: async () => "/nonexistent/codex",
    };
    const res = await adapter.probe(instance, deps);
    expect(res).toMatchObject({
      version: "0.170.2",
      outsideCliRange: true,
      flags: [],
      features: [],
      loggedIn: null,
      realpath: null,
    });
    expect(() => posix.buildInvocation(args({ probe: res }))).toThrow(/hooks, plugins/);
  });

  it("survives a spawner that throws", async () => {
    const deps: AdapterDeps = {
      spawner: { spawn: async () => Promise.reject(new Error("ENOENT")) },
      clock: new FakeClock(),
      resolveBinary: async () => "/nonexistent/codex",
    };
    expect(await adapter.probe(instance, deps)).toMatchObject({
      version: null,
      loggedIn: null,
      outsideCliRange: false,
    });
  });

  it("parsers and range check", () => {
    expect(codexVersionInRange("0.167.0")).toBe(true);
    expect(codexVersionInRange("0.167.9")).toBe(true);
    expect(codexVersionInRange("0.167.1-alpha.1")).toBe(false);
    expect(codexVersionInRange("0.168.0")).toBe(false);
    expect(codexVersionInRange("garbage")).toBe(false);
    expect(parseFeatureList("Feature  Stage\nhooks stable true\n\n  plugins x\n")).toEqual([
      "hooks",
      "plugins",
    ]);
    expect(parseHelpFlags("  -h, --help  Print help\n[--foo]")).toEqual(["-h", "--help", "--foo"]);
  });
});

// ---------------------------------------------------------------- end to end with the fake CLI

describe("codex invocation against the fake CLI", () => {
  it("runs the built invocation and classifies its stream [UC2] [UC4]", async () => {
    await withFakes(
      { codex: [{ scenario: "quota_exhausted" }] },
      async ({ bin, binDir, env, readLog }) => {
        const probe = { ...probeResult, binaryPath: bin("codex") };
        const inv: Invocation = adapter.buildInvocation(
          args({ probe, worktree: binDir, repoRoot: binDir, baseEnv: env }),
        );
        const c = ctx(binDir);
        const events: unknown[] = [];
        const res = await testSpawner.spawn({
          binary: inv.binary,
          argv: inv.argv,
          env: inv.env,
          cwd: inv.cwd,
          ...(inv.stdin !== null ? { stdin: inv.stdin } : {}),
          onLine: (s, l) => events.push(...adapter.parseLine(s, l, c)),
        });
        const out = adapter.finalize({ ...res, durationMs: 5 }, c);
        expect(out.outcome).toBe("quota_exhausted");
        expect(events.length).toBeGreaterThan(0);
        const [call] = readLog({ cli: "codex", kind: "run" });
        expect(call?.args).toEqual(inv.argv);
        expect(call?.stdin).toBe(inv.stdin);
      },
    );
  });
});
