import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AdapterOutcomeSchema,
  DecisionInputSchema,
  DecisionRecordSchema,
  DecisionSchema,
  EditOpSchema,
  ExitCode,
  HostContextSchema,
  InvocationSchema,
  QuotaSnapshotSchema,
  RunRecordSchema,
  RunResultSchema,
  TaskSchema,
} from "../../src/core/contracts.js";
import * as fx from "../fixtures/contracts.js";

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
    ["Invocation", InvocationSchema, fx.invocation],
    ["EditOp", EditOpSchema, fx.editOp],
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
});
