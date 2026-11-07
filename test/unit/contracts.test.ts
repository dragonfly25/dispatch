import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Adapter,
  AdapterCapabilitiesSchema,
  AdapterOutcomeSchema,
  DecisionInputSchema,
  DecisionRecordSchema,
  DecisionSchema,
  EditOpSchema,
  ExitCode,
  HostContextSchema,
  type HostIntegration,
  InvocationSchema,
  NormalizedEventSchema,
  QuotaSignalSchema,
  QuotaSnapshotSchema,
  RunRecordSchema,
  RunResultSchema,
  SubagentStrategySchema,
  TaskSchema,
} from "../../src/core/contracts.js";
import * as fx from "../fixtures/contracts.js";
import { FakeClock, ScriptedSpawner } from "../stubs/index.js";

const roundTrip = (schema: z.ZodType, value: unknown) =>
  schema.parse(JSON.parse(JSON.stringify(value)));

describe("core contracts", () => {
  it.each([
    ["Task", TaskSchema, fx.task],
    ["QuotaSnapshot", QuotaSnapshotSchema, fx.quota],
    ["DecisionInput", DecisionInputSchema, fx.decisionInput],
    ["Decision", DecisionSchema, fx.decision],
    ["AdapterOutcome", AdapterOutcomeSchema, fx.adapterOutcome],
    ["RunResult", RunResultSchema, fx.runResult],
    ["RunResult (fanout)", RunResultSchema, fx.fanoutResult],
    ["DecisionRecord", DecisionRecordSchema, fx.decisionRecord],
    ["RunRecord", RunRecordSchema, fx.runRecord],
    ["AdapterOutcome (denied)", AdapterOutcomeSchema, fx.deniedOutcome],
    ["AdapterOutcome (quota)", AdapterOutcomeSchema, fx.quotaOutcome],
    ["Invocation", InvocationSchema, fx.invocation],
    ["Invocation (argv prompt)", InvocationSchema, fx.argvInvocation],
    ["EditOp", EditOpSchema, fx.editOp],
    ["EditOp (rules file)", EditOpSchema, fx.rulesEditOp],
    ["AdapterCapabilities (codex)", AdapterCapabilitiesSchema, fx.codexCaps],
    ["AdapterCapabilities (agy)", AdapterCapabilitiesSchema, fx.agyCaps],
  ] as const)("%s survives a JSON round trip", (_name, schema, value) => {
    expect(roundTrip(schema, value)).toEqual(value);
  });

  it("accepts user-defined tiers and efforts", () => {
    expect(TaskSchema.parse({ ...fx.task, tier: "ultra", effort: "xhigh" }).tier).toBe("ultra");
  });

  it("allows a host context without a known self", () => {
    expect(HostContextSchema.parse({ self: null, depth: 0 })).toEqual({ self: null, depth: 0 });
  });

  it.each([
    ["non-UTC timestamp", { ...fx.decisionInput, now: "2026-01-01T01:00:00+01:00" }],
    ["unknown autonomy", { ...fx.decisionInput, task: { ...fx.task, autonomy: "yolo" } }],
    ["negative depth", { ...fx.decisionInput, host: { self: null, depth: -1 } }],
    ["empty tier", { ...fx.decisionInput, task: { ...fx.task, tier: "" } }],
  ])("rejects %s", (_name, value) => {
    expect(DecisionInputSchema.safeParse(value).success).toBe(false);
  });

  it("rejects a RunResult with the wrong schema version or marker", () => {
    expect(RunResultSchema.safeParse({ ...fx.runResult, schemaVersion: 2 }).success).toBe(false);
    const ext = { ...fx.runResult.externalAgent, marker: "TRUSTED" };
    expect(RunResultSchema.safeParse({ ...fx.runResult, externalAgent: ext }).success).toBe(false);
  });

  it("validates nested fanout results", () => {
    const bad = { ...fx.fanoutResult, results: [{ ...fx.runResult, outcome: "maybe" }] };
    expect(RunResultSchema.safeParse(bad).success).toBe(false);
  });

  it("keeps the documented exit codes", () => {
    expect(ExitCode).toEqual({
      OK: 0,
      USAGE: 2,
      REJECTED: 3,
      FAILED: 4,
      QUOTA: 5,
      TIMEOUT_OR_STATE: 6,
      STILL_RUNNING: 75,
    });
  });

  it("RunResult v1 JSON Schema is stable", async () => {
    const schema = z.toJSONSchema(RunResultSchema);
    await expect(`${JSON.stringify(schema, null, 2)}\n`).toMatchFileSnapshot(
      "../__snapshots__/run-result.v1.schema.json",
    );
  });

  it("accepts the WP1 event kinds and paths", () => {
    for (const ev of fx.events) expect(NormalizedEventSchema.parse(ev)).toEqual(ev);
    expect(NormalizedEventSchema.safeParse({ kind: "blocked", ts: fx.T0 }).success).toBe(false);
  });

  it.each([
    [
      "Invocation without guards",
      InvocationSchema,
      { ...fx.invocation, sideEffectGuards: undefined },
    ],
    ["Invocation with undefined stdin", InvocationSchema, { ...fx.invocation, stdin: undefined }],
    ["EditOp with a bad mode", EditOpSchema, { ...fx.rulesEditOp, mode: "644" }],
    ["EditOp with a bad sha256", EditOpSchema, { ...fx.rulesEditOp, sha256: "xyz" }],
    ["EditOp without trustGrant", EditOpSchema, { ...fx.editOp, trustGrant: undefined }],
    [
      "AdapterOutcome without deniedActions",
      AdapterOutcomeSchema,
      { ...fx.adapterOutcome, deniedActions: undefined },
    ],
    ["unknown quota signal", QuotaSignalSchema, { source: "codex.guess", raw: "x" }],
    [
      "unknown prompt channel",
      AdapterCapabilitiesSchema,
      { ...fx.codexCaps, promptChannel: "file" },
    ],
    ["proxy_subagent strategy", SubagentStrategySchema, "proxy_subagent"],
  ] as const)("rejects %s", (_name, schema, value) => {
    expect((schema as z.ZodType).safeParse(value).success).toBe(false);
  });

  it("an adapter probes and reads quota through the injected Spawner", async () => {
    const adapter: Adapter = {
      caps: fx.codexCaps,
      async probe(_instance, deps) {
        const lines: string[] = [];
        const binaryPath = await deps.resolveBinary("codex", _instance);
        await deps.spawner.spawn({
          binary: binaryPath ?? "codex",
          argv: ["--version"],
          env: {},
          cwd: "/",
          onLine: (_s, l) => lines.push(l),
        });
        return { ...fx.probeResult, binaryPath, version: lines[0]?.split(" ").pop() ?? null };
      },
      buildInvocation: (args) => ({ ...fx.invocation, cwd: args.worktree }),
      parseLine: (_stream, line, ctx) =>
        line.includes("file_change")
          ? [
              {
                kind: "editing",
                ts: fx.T0,
                path: `${ctx.worktree}/a.js`.slice(ctx.worktree.length + 1),
              },
            ]
          : [],
      finalize: (res, _ctx) => ({
        ...fx.adapterOutcome,
        outcome: res.exitCode === 0 ? "success" : "failed",
        durationMs: res.durationMs,
      }),
      async readQuota(_instance, deps) {
        await deps.spawner.spawn({ binary: "codex", argv: ["app-server"], env: {}, cwd: "/" });
        return [];
      },
    };
    const spawner = new ScriptedSpawner([{ stdout: ["codex-cli 0.167.0"] }]);
    const deps = {
      spawner,
      clock: new FakeClock(),
      resolveBinary: async () => "/opt/homebrew/bin/codex",
    };
    const instance = { id: "codex", adapter: "codex", pool: "subscription" as const };
    const probe = await adapter.probe(instance, deps);
    expect(probe.version).toBe("0.167.0");
    expect(await adapter.readQuota?.(instance, deps)).toEqual([]);
    expect(spawner.requests.map((r) => r.argv[0])).toEqual(["--version", "app-server"]);
    const ctx = { runId: "r", worktree: "/tmp/wt", scratch: {} };
    expect(adapter.parseLine("stdout", '{"type":"file_change"}', ctx)).toEqual([
      { kind: "editing", ts: fx.T0, path: "a.js" },
    ]);
    expect(adapter.parseLine("stderr", "noise", ctx)).toEqual([]);
    const outcome = adapter.finalize(
      { exitCode: 1, signal: null, timedOut: false, durationMs: 5 },
      ctx,
    );
    expect(AdapterOutcomeSchema.parse(outcome).outcome).toBe("failed");
    const built = adapter.buildInvocation({ worktree: "/tmp/wt2" } as never);
    expect(InvocationSchema.parse(built).cwd).toBe("/tmp/wt2");
  });

  it("a host integration exposes the deny_redirect strategy and env-only detection", async () => {
    const host: HostIntegration = {
      id: "codex",
      subagentStrategy: "deny_redirect",
      subagentMatcher: "spawn_agent|collaborationspawn_agent|Agent",
      waitTimeoutSec: 280,
      detectSelf: (env) =>
        env.CODEX_THREAD_ID ? { host: "codex", version: env.CODEX_VERSION ?? null } : null,
      detect: async () => true,
      plan: () => [fx.rulesEditOp],
      hookHandlers: {
        PreToolUse: async (input) => ({
          exitCode: 0,
          stdout: JSON.stringify({
            hookSpecificOutput: {
              hookEventName: input.hook_event_name,
              permissionDecision: "deny",
              permissionDecisionReason: "run the launcher instead",
            },
          }),
        }),
      },
    };
    expect(SubagentStrategySchema.parse(host.subagentStrategy)).toBe("deny_redirect");
    expect(host.detectSelf({ CODEX_THREAD_ID: "t", CODEX_VERSION: "0.167.0" })).toEqual({
      host: "codex",
      version: "0.167.0",
    });
    expect(host.detectSelf({})).toBeNull();
    const ctx = { home: "/h", launcherPath: "/h/l", nodePath: "/n", hookPath: "/h/k" };
    expect(await host.detect(ctx)).toBe(true);
    expect(EditOpSchema.parse(host.plan(ctx)[0])).toEqual(fx.rulesEditOp);
    const res = await host.hookHandlers.PreToolUse?.({
      hook_event_name: "PreToolUse",
      session_id: "s",
      cwd: "/r",
      tool_name: "collaborationspawn_agent",
    });
    expect(res?.stdout).toContain('"permissionDecision":"deny"');
  });
});
