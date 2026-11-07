/** Canonical sample values for every core contract; reused by later WPs' tests. */
import type {
  AdapterCapabilities,
  AdapterOutcome,
  Decision,
  DecisionInput,
  DecisionRecord,
  EditOp,
  Invocation,
  NormalizedEvent,
  ProbeResult,
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
  deniedActions: [],
  durationMs: 4200,
};

/** agy-style run: SUCCESS on the wire, but the only useful action was denied. */
export const deniedOutcome: AdapterOutcome = {
  outcome: "failed",
  summary: "",
  nativeError: "denied: write_file",
  deniedActions: ["write_file"],
  durationMs: 2831,
};

/** Codex usage-limit failure (docs/spikes/codex.md). */
export const quotaOutcome: AdapterOutcome = {
  outcome: "quota_exhausted",
  summary: "",
  resetAt: "2026-01-01T15:05:00.000Z",
  nativeError: "You\u2019ve hit your usage limit. Try again at 3:05 PM.",
  deniedActions: [],
  quotaSignal: {
    source: "codex.turn_failed.usage_limit",
    raw: "You\u2019ve hit your usage limit. Try again at 3:05 PM.",
  },
  durationMs: 900,
};

export const events: NormalizedEvent[] = [
  { kind: "reading", ts: T0, path: "src/math.js" },
  { kind: "editing", ts: T0, path: "src/math.js" },
  { kind: "denied", ts: T0, detail: "write_file hello.txt" },
  { kind: "done", ts: T0 },
];

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
  argv: [
    "exec",
    "--json",
    "--ephemeral",
    "-c",
    "agents.enabled=false",
    "-c",
    'projects={"/tmp/wt"={trust_level="untrusted"},"/tmp/repo"={trust_level="untrusted"}}',
    "-o",
    "/tmp/run/last.txt",
    "-",
  ],
  env: { PATH: "/usr/bin:/bin", DISPATCH_DEPTH: "1" },
  cwd: "/tmp/wt",
  stdin: "## Task data\n...",
  outputFile: "/tmp/run/last.txt",
  redactArgvIndexes: [],
  sideEffectGuards: ["codex-project-trust-untrusted", "codex-agents-disabled"],
};

/** agy takes the prompt in argv (`-p=<prompt>`), so stdin is null and argv[0] is redacted. */
export const argvInvocation: Invocation = {
  binary: "/opt/homebrew/bin/agy",
  argv: ["-p=## Task data\n...", "--output-format", "stream-json", "--sandbox"],
  env: { PATH: "/usr/bin:/bin", DISPATCH_DEPTH: "1" },
  cwd: "/tmp/wt",
  stdin: null,
  redactArgvIndexes: [0],
  sideEffectGuards: ["agy-no-skip-permissions"],
};

export const editOp: EditOp = {
  file: "/home/u/.codex/hooks.json",
  kind: "json-entry",
  signature: "dispatch:SessionStart",
  content: '{"command":"..."}',
  trustGrant: null,
};

export const rulesEditOp: EditOp = {
  file: "/home/u/.codex/rules/dispatch.rules",
  kind: "rules-file",
  signature: "dispatch:rules",
  content: "prefix_rule(...)\n",
  mode: "0644",
  sha256: "0".repeat(64),
  trustGrant:
    "Lets /home/u/.dispatch/bin/dispatch run|wait|cancel|status run outside the Codex sandbox",
};

export const codexCaps: AdapterCapabilities = {
  id: "codex",
  version: "0.1.0",
  cliRange: ">=0.167.0 <0.168.0",
  streaming: true,
  autonomy: ["read-only", "worktree"],
  quotaChannel: "passive+reader",
  pool: "subscription",
  experimental: false,
  promptChannel: "stdin",
  isolation: {
    userHooks: "disabled",
    userPlugins: "disabled",
    userMcp: "disabled",
    projectConfig: "disabled",
  },
  sandbox: "os",
  childNetwork: "none",
};

export const agyCaps: AdapterCapabilities = {
  id: "antigravity",
  version: "0.1.0",
  cliRange: ">=1.5.2 <1.6.0",
  streaming: true,
  autonomy: ["read-only"],
  quotaChannel: "reader",
  pool: "subscription",
  experimental: true,
  promptChannel: "argv",
  isolation: {
    userHooks: "not_disableable",
    userPlugins: "not_disableable",
    userMcp: "not_disableable",
    projectConfig: "not_disableable",
  },
  sandbox: "permission-only",
  childNetwork: "none",
};

export const probeResult: ProbeResult = {
  binaryPath: "/opt/homebrew/bin/codex",
  realpath: "/opt/homebrew/Caskroom/codex/0.167.0/codex",
  version: "0.167.0",
  flags: ["--json", "--ephemeral", "--ignore-user-config"],
  features: ["hooks", "plugins", "apps", "memories", "multi_agent"],
  loggedIn: true,
  outsideCliRange: false,
};
