/** Canonical sample values for every core contract; reused by later WPs' tests. */
import type {
  AdapterOutcome,
  Decision,
  DecisionInput,
  DecisionRecord,
  EditOp,
  Invocation,
  QuotaSnapshot,
  RunRecord,
  RunResult,
  Task,
} from "../../src/core/contracts.js";

export const T0 = "2026-01-01T00:00:00.000Z";

export const task: Task = {
  id: "task-1",
  prompt: "Add a unit test for parseConfig",
  taskType: "test",
  paths: ["src/config/parse.ts"],
  tier: "balanced",
  effort: "medium",
  autonomy: "worktree",
  timeoutMs: 300_000,
};

export const quota: QuotaSnapshot = {
  takenAt: T0,
  instances: {
    claude: {
      pool: "subscription",
      windows: [
        {
          kind: "5h",
          usedPct: 42,
          resetAt: "2026-01-01T03:00:00.000Z",
          source: "claude-passive",
          readAt: T0,
          reliability: "real",
        },
      ],
    },
    codex: {
      pool: "subscription",
      windows: [
        {
          kind: "7d",
          usedPct: null,
          resetAt: null,
          source: "estimator",
          readAt: T0,
          reliability: "unknown",
        },
      ],
      unavailableUntil: "2026-01-01T05:00:00.000Z",
      lastQuotaError: "usage limit reached",
    },
  },
};

export const decisionInput: DecisionInput = {
  task,
  host: { self: "claude", sessionModel: { value: "claude-opus-5-5", observed: true }, depth: 0 },
  routing: { profile: "balance" },
  quota,
  sessionHistory: [{ taskId: "task-0", instance: "codex", outcome: "quota_exhausted" }],
  now: T0,
  routerVersion: "0.1.0",
};

export const decision: Decision = {
  action: "delegate",
  mode: "fallback",
  targets: [
    { instance: "codex", tier: "balanced", model: "gpt-5.5", effort: "medium" },
    { instance: "agy", tier: "balanced", model: "gemini-3-pro", effort: "medium" },
  ],
  chain: [
    { layer: "pin", ruleId: "pins", matched: false, effect: "none" },
    { layer: "profile", ruleId: "balance/tests", matched: true, effect: "fallback codex, agy" },
    { layer: "filter", ruleId: "self", matched: true, effect: "excluded claude", note: "host" },
  ],
  inputHash: "sha256:abc",
  reason: "profile balance: tests go to codex",
};

export const adapterOutcome: AdapterOutcome = {
  outcome: "success",
  summary: "Added 3 tests",
  usage: {
    inputTokens: 1200,
    outputTokens: 300,
    cachedTokens: 0,
    costUsd: 0,
    raw: { any: "thing" },
  },
  durationMs: 4200,
};

export const runResult: RunResult = {
  schemaVersion: 1,
  runId: "01KA0000000000000000000000",
  status: "completed",
  externalAgent: {
    provider: "codex",
    instance: "codex",
    model: "gpt-5.5",
    marker: "EXTERNAL_AGENT_OUTPUT",
  },
  outcome: "success",
  summary: "Added 3 tests",
  patch: {
    path: "/home/u/.dispatch/runs/01KA/patch.diff",
    diffstat: " 1 file changed, 30 insertions(+)",
    applies: true,
    rejectedPaths: [],
    needsReview: false,
  },
  log: { path: "/home/u/.dispatch/runs/01KA/log.jsonl" },
  decisions: [decision],
  usage: { inputTokens: 1200 },
  durationMs: 4200,
};

export const fanoutResult: RunResult = {
  ...runResult,
  runId: "01KA0000000000000000000001",
  externalAgent: null,
  patch: null,
  summary: "",
  results: [runResult, { ...runResult, runId: "01KA0000000000000000000002", outcome: "failed" }],
};

export const decisionRecord: DecisionRecord = {
  id: "d-1",
  createdAt: T0,
  runId: runResult.runId,
  input: decisionInput,
  decision,
};

export const runRecord: RunRecord = {
  runId: runResult.runId,
  status: "running",
  createdAt: T0,
  updatedAt: T0,
  instance: "codex",
  pid: 1234,
  result: null,
};

export const invocation: Invocation = {
  binary: "/usr/local/bin/codex",
  argv: ["exec", "--json", "-"],
  env: { PATH: "/usr/bin:/bin", DISPATCH_DEPTH: "1" },
  cwd: "/tmp/wt",
  stdin: "## Task data\n...",
};

export const editOp: EditOp = {
  file: "~/.codex/hooks.json",
  kind: "json-entry",
  signature: "dispatch:SessionStart",
  content: '{"command":"..."}',
};
