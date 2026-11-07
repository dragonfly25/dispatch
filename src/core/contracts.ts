/**
 * Core contracts for Dispatch.
 *
 * Everything exported from this file is FROZEN once merged (see docs/adr/0001-frozen-contracts.md):
 * changing a schema, type or port requires a new ADR. The adapter and host-integration contracts
 * were frozen by WP1 (docs/adr/0002-wp1-contract-freeze.md).
 *
 * Conventions:
 * - Every data contract is a zod schema (`FooSchema`) plus its inferred type (`Foo`).
 * - Timestamps are ISO-8601 UTC strings (`2026-01-01T00:00:00.000Z`).
 * - Ports (side-effecting dependencies) are plain TS interfaces; stubs live in `test/stubs`.
 */
import { z } from "zod";

const IsoUtc = z.iso.datetime();
const NonEmpty = z.string().min(1);

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Tiers shipped by default. Users may redefine tiers, so `Tier` itself is any non-empty string. */
export const DEFAULT_TIERS = ["fast", "balanced", "max"] as const;
/** A model tier name (default set: {@link DEFAULT_TIERS}; user-definable). */
export const TierSchema = NonEmpty;
export type Tier = z.infer<typeof TierSchema>;

/** Effort levels shipped by default. Adapters map them to native effort; users may add more. */
export const DEFAULT_EFFORTS = ["low", "medium", "high"] as const;
/** A reasoning-effort level (default set: {@link DEFAULT_EFFORTS}; user-definable). */
export const EffortSchema = NonEmpty;
export type Effort = z.infer<typeof EffortSchema>;

/** What a delegated agent may do: read only, edit inside a worktree, or edit the repo directly. */
export const AutonomySchema = z.enum(["read-only", "worktree", "direct"]);
export type Autonomy = z.infer<typeof AutonomySchema>;

/** Billing pool an instance draws from. */
export const PoolSchema = z.enum(["subscription", "api_credit", "unknown"]);
export type Pool = z.infer<typeof PoolSchema>;

/** Final outcome of an attempt, as reported by an adapter or the runner. */
export const OutcomeSchema = z.enum([
  "success",
  "failed",
  "timeout",
  "quota_exhausted",
  "rejected",
]);
export type Outcome = z.infer<typeof OutcomeSchema>;

/** Process exit codes of the `dispatch` CLI (plan §2 "Commands"). */
export const ExitCode = {
  OK: 0,
  USAGE: 2,
  REJECTED: 3,
  FAILED: 4,
  QUOTA: 5,
  TIMEOUT_OR_STATE: 6,
  STILL_RUNNING: 75,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

// ---------------------------------------------------------------------------
// Task, host, instances
// ---------------------------------------------------------------------------

/** A unit of work submitted to Dispatch (by a host agent, a user, or a script). */
export const TaskSchema = z.object({
  id: NonEmpty,
  prompt: z.string(),
  /** Free-form classification used by mapping/profile rules (e.g. "review", "refactor"). */
  taskType: NonEmpty.optional(),
  /** Repo-relative paths the task is expected to touch; used by pins and path rules. */
  paths: z.array(z.string()),
  /** Model explicitly requested by the caller, if any. */
  requestedModel: NonEmpty.optional(),
  tier: TierSchema.optional(),
  effort: EffortSchema.optional(),
  autonomy: AutonomySchema,
  timeoutMs: z.number().int().positive(),
});
export type Task = z.infer<typeof TaskSchema>;

/** Where the request comes from. `self` is the instance id of the calling host (never chosen). */
export const HostContextSchema = z.object({
  self: NonEmpty.nullable(),
  /** The host session's model; `observed` is true when read from the host, false when guessed. */
  sessionModel: z.object({ value: NonEmpty, observed: z.boolean() }).optional(),
  /** Nesting depth (`DISPATCH_DEPTH`); 0 for a top-level call. */
  depth: z.number().int().nonnegative(),
});
export type HostContext = z.infer<typeof HostContextSchema>;

/** One configured provider account, e.g. `claude` or `claude-alt` with its own config dir. */
export const ProviderInstanceSchema = z.object({
  id: NonEmpty,
  /** Adapter id: "claude" | "codex" | "antigravity" | "fake" | ... */
  adapter: NonEmpty,
  configDir: NonEmpty.optional(),
  pool: PoolSchema,
  /** Explicit binary path; otherwise resolved via PATH and well-known dirs. */
  binary: NonEmpty.optional(),
});
export type ProviderInstance = z.infer<typeof ProviderInstanceSchema>;

// ---------------------------------------------------------------------------
// Quota
// ---------------------------------------------------------------------------

/** How trustworthy a quota number is. */
export const ReliabilitySchema = z.enum(["real", "estimated", "stale", "unknown"]);
export type Reliability = z.infer<typeof ReliabilitySchema>;

/** Usage within one rolling or calendar window of a provider plan. */
export const QuotaWindowSchema = z.object({
  /** Window label, e.g. "5h", "7d", "weekly", "monthly". */
  kind: NonEmpty,
  usedPct: z.number().min(0).max(100).nullable(),
  resetAt: IsoUtc.nullable(),
  /** Reader that produced the value, e.g. "claude-passive", "codex-app-server", "estimator". */
  source: NonEmpty,
  readAt: IsoUtc,
  reliability: ReliabilitySchema,
});
export type QuotaWindow = z.infer<typeof QuotaWindowSchema>;

/** Quota state of a single instance inside a snapshot. */
export const InstanceQuotaSchema = z.object({
  windows: z.array(QuotaWindowSchema),
  pool: PoolSchema,
  /** Set after a `quota_exhausted` signal; the instance is skipped until then. */
  unavailableUntil: IsoUtc.optional(),
  lastQuotaError: z.string().optional(),
});
export type InstanceQuota = z.infer<typeof InstanceQuotaSchema>;

/** Point-in-time view of every instance's quota, as fed to the router. */
export const QuotaSnapshotSchema = z.object({
  takenAt: IsoUtc,
  instances: z.record(z.string(), InstanceQuotaSchema),
});
export type QuotaSnapshot = z.infer<typeof QuotaSnapshotSchema>;

/** A single quota fact observed at runtime (a reading or an exhaustion signal). */
export const QuotaObservationSchema = z.object({
  instanceId: NonEmpty,
  at: IsoUtc,
  window: QuotaWindowSchema.optional(),
  exhausted: z.object({ resetAt: IsoUtc.nullable(), error: z.string().optional() }).optional(),
});
export type QuotaObservation = z.infer<typeof QuotaObservationSchema>;

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

/** One step of the rule chain the router walked; the basis of `explain`. */
export const RuleTraceSchema = z.object({
  layer: z.enum(["pin", "mapping", "profile", "preset", "default", "filter"]),
  ruleId: NonEmpty,
  matched: z.boolean(),
  /** Human-readable effect, e.g. "provider codex", "filtered: below hard limit". */
  effect: z.string(),
  note: z.string().optional(),
});
export type RuleTrace = z.infer<typeof RuleTraceSchema>;

/** Outcome of an earlier task in the same host session (used to avoid repeat failures). */
export const SessionHistoryEntrySchema = z.object({
  taskId: NonEmpty,
  instance: NonEmpty,
  outcome: OutcomeSchema,
});
export type SessionHistoryEntry = z.infer<typeof SessionHistoryEntrySchema>;

/**
 * Complete, canonical input of the pure router. Stored (redacted) with every decision so that
 * `explain --replay` can reproduce it. Must contain everything the router reads: no clock, no env.
 */
export const DecisionInputSchema = z.object({
  task: TaskSchema,
  host: HostContextSchema,
  // TODO(WP4): replace with RoutingConfigSchema once the config schema exists.
  routing: z.record(z.string(), z.unknown()),
  quota: QuotaSnapshotSchema,
  sessionHistory: z.array(SessionHistoryEntrySchema),
  /** Decision time, injected by the caller. */
  now: IsoUtc,
  routerVersion: NonEmpty,
});
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

/** A concrete delegation target chosen by the router. */
export const DecisionTargetSchema = z.object({
  instance: NonEmpty,
  tier: TierSchema,
  model: NonEmpty,
  effort: EffortSchema,
});
export type DecisionTarget = z.infer<typeof DecisionTargetSchema>;

/**
 * Router output. `targets` is ordered: for `fallback` they are tried in order, for `fanout` they
 * all run, for `single` there is one. It is empty when `action` is `host` or `reject`.
 */
export const DecisionSchema = z.object({
  action: z.enum(["delegate", "host", "reject"]),
  mode: z.enum(["single", "fallback", "fanout"]),
  targets: z.array(DecisionTargetSchema),
  chain: z.array(RuleTraceSchema),
  /** Hash of the canonical DecisionInput, for replay checks. */
  inputHash: NonEmpty,
  reason: z.string(),
});
export type Decision = z.infer<typeof DecisionSchema>;

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/** Provider-neutral progress event parsed from a child CLI's output. */
export const NormalizedEventSchema = z.object({
  /** `denied`: the child CLI refused a tool action (permission rule, sandbox, headless auto-deny). */
  kind: z.enum(["reading", "editing", "running", "thinking", "denied", "done", "error"]),
  ts: IsoUtc,
  detail: z.string().optional(),
  /** Worktree-relative path for reading/editing events. */
  path: z.string().optional(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

/** Token and cost accounting; every field is optional because providers report differently. */
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedTokens: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  /** Provider-native usage payload, kept for debugging. */
  raw: z.unknown().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

/** Which evidence classified a run as `quota_exhausted` (see docs/spikes/*.md). */
export const QuotaSignalSchema = z.object({
  source: z.enum([
    "claude.rate_limit_event.rejected",
    "claude.assistant.error",
    "claude.api_error_status_429",
    "claude.text",
    "codex.turn_failed.usage_limit",
    "agy.agy_error.quota",
  ]),
  /** The raw message or field value that matched. */
  raw: z.string(),
});
export type QuotaSignal = z.infer<typeof QuotaSignalSchema>;

/** What an adapter reports once its child process has ended. */
export const AdapterOutcomeSchema = z.object({
  outcome: OutcomeSchema,
  summary: z.string(),
  usage: UsageSchema.optional(),
  /** When quota is exhausted, the provider's announced reset time, if known. */
  resetAt: IsoUtc.optional(),
  nativeError: z.string().optional(),
  /**
   * Tool actions the child CLI denied (agy `denied_actions`, claude `permission_denials`).
   * agy reports `SUCCESS` even when it denied the only useful action, so adapters map a run with
   * denied actions and no output to `failed`.
   */
  deniedActions: z.array(z.string()),
  quotaSignal: QuotaSignalSchema.optional(),
  durationMs: z.number().nonnegative(),
});
export type AdapterOutcome = z.infer<typeof AdapterOutcomeSchema>;

/** Marker telling the host that `summary` is untrusted output from another agent. */
export const EXTERNAL_AGENT_MARKER = "EXTERNAL_AGENT_OUTPUT" as const;

/** The external agent that produced a result. */
export const ExternalAgentSchema = z.object({
  provider: NonEmpty,
  instance: NonEmpty,
  model: NonEmpty,
  marker: z.literal(EXTERNAL_AGENT_MARKER),
});
export type ExternalAgent = z.infer<typeof ExternalAgentSchema>;

/** Patch produced in a worktree. Dispatch never applies it; the patch is referenced by path. */
export const PatchInfoSchema = z.object({
  path: NonEmpty,
  diffstat: z.string(),
  /** Result of `git apply --check` against the current working tree. */
  applies: z.boolean(),
  /** Paths dropped by the patch filter. */
  rejectedPaths: z.array(z.string()),
  /** Set when the best-effort secret scan hit or the base was a dirty snapshot. */
  needsReview: z.boolean(),
});
export type PatchInfo = z.infer<typeof PatchInfoSchema>;

/**
 * Public result of `dispatch run --json` / `wait --json` (schema version 1).
 * `outcome` is null only while `status` is `running`. Fanout runs carry one child per target in
 * `results`.
 */
export interface RunResult {
  schemaVersion: 1;
  runId: string;
  status: "completed" | "running" | "returned_to_host" | "rejected";
  externalAgent: ExternalAgent | null;
  outcome: Outcome | null;
  /** External agent output; untrusted, flagged by `externalAgent.marker`. */
  summary: string;
  patch: PatchInfo | null;
  log: { path: string };
  decisions: Decision[];
  usage?: Usage | undefined;
  durationMs: number;
  results?: RunResult[] | undefined;
}
export const RunResultSchema: z.ZodType<RunResult> = z.object({
  schemaVersion: z.literal(1),
  runId: NonEmpty,
  status: z.enum(["completed", "running", "returned_to_host", "rejected"]),
  externalAgent: ExternalAgentSchema.nullable(),
  outcome: OutcomeSchema.nullable(),
  summary: z.string(),
  patch: PatchInfoSchema.nullable(),
  log: z.object({ path: NonEmpty }),
  decisions: z.array(DecisionSchema),
  usage: UsageSchema.optional(),
  durationMs: z.number().nonnegative(),
  get results() {
    return z.array(RunResultSchema).optional();
  },
});

// ---------------------------------------------------------------------------
// Persisted records (StateStore)
// ---------------------------------------------------------------------------

/** A stored routing decision with its canonical input. */
export const DecisionRecordSchema = z.object({
  id: NonEmpty,
  createdAt: IsoUtc,
  runId: NonEmpty.nullable(),
  input: DecisionInputSchema,
  decision: DecisionSchema,
});
export type DecisionRecord = z.infer<typeof DecisionRecordSchema>;

/** A stored run; `result` is filled once the run reaches a terminal status. */
export const RunRecordSchema = z.object({
  runId: NonEmpty,
  status: z.enum(["completed", "running", "returned_to_host", "rejected"]),
  createdAt: IsoUtc,
  updatedAt: IsoUtc,
  instance: NonEmpty.nullable(),
  pid: z.number().int().positive().nullable(),
  result: RunResultSchema.nullable(),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Time source. Inject it everywhere; the router receives `now` via DecisionInput instead. */
export interface Clock {
  now(): Date;
  /** Monotonic milliseconds, for timeouts and durations (never wall-clock). */
  monotonicMs(): number;
}

/** Request to spawn a child process. */
export interface SpawnRequest {
  binary: string;
  /** Arguments after the binary. */
  argv: readonly string[];
  /** Full environment of the child (no inheritance: the caller builds it from an allow-list). */
  env: Readonly<Record<string, string>>;
  cwd: string;
  stdin?: string;
  /** Kill the whole process group after this many monotonic ms. */
  timeoutMs?: number;
  /** Grace period between SIGTERM and SIGKILL (default 10 000 ms). */
  killGraceMs?: number;
  /** Aborting kills the process group like a timeout (without setting `timedOut`). */
  signal?: AbortSignal;
  /** Called for every complete output line (without the trailing newline). */
  onLine?: (stream: "stdout" | "stderr", line: string) => void;
}

/** Result of a finished child. */
export interface SpawnResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
}

/**
 * Process spawner. Implementations start the child in its own process group (setsid) and always
 * terminate the whole group on timeout/abort. Only `src/runner` may implement it.
 */
export interface Spawner {
  spawn(req: SpawnRequest): Promise<SpawnResult>;
}

/** Persistent state (SQLite in production). Implementations redact before every write. */
export interface StateStore {
  recordDecision(record: DecisionRecord): Promise<void>;
  recordRun(run: RunRecord): Promise<void>;
  /** Shallow-merges `patch` into the run; throws if the run does not exist. */
  updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<RunRecord>;
  getRun(runId: string): Promise<RunRecord | null>;
  appendEvent(runId: string, event: NormalizedEvent): Promise<void>;
  /** Decisions created at or after `since` (ISO UTC), oldest first. */
  listDecisions(since: string): Promise<DecisionRecord[]>;
}

/** Quota source combining readers, the estimator and exhaustion signals. Never blocks routing. */
export interface QuotaProvider {
  snapshot(instances: readonly ProviderInstance[]): Promise<QuotaSnapshot>;
  recordObservation(observation: QuotaObservation): Promise<void>;
}

/** Options for creating an isolated working copy. */
export interface SandboxCreateOptions {
  repoPath: string;
  runId: string;
  autonomy: Autonomy;
}

/** A created sandbox. `dirtySnapshot` is true when the base is a `git stash create` snapshot. */
export interface SandboxHandle {
  path: string;
  baseRef: string;
  dirtySnapshot: boolean;
}

/** Git-worktree sandbox. */
export interface Sandbox {
  create(opts: SandboxCreateOptions): Promise<SandboxHandle>;
  /** Removes the sandbox unless `keep` is true. */
  dispose(path: string, keep: boolean): Promise<void>;
}

// ---------------------------------------------------------------------------
// Adapter contracts (frozen by WP1, see docs/adr/0002-wp1-contract-freeze.md)
// ---------------------------------------------------------------------------

/** How the task prompt reaches the child CLI. agy ignores stdin, so it takes `-p=<prompt>`. */
export const PromptChannelSchema = z.enum(["stdin", "argv"]);
export type PromptChannel = z.infer<typeof PromptChannelSchema>;

/** What a child CLI can be isolated from, as verified by the WP1 spike (`doctor` prints it). */
export const AdapterIsolationSchema = z.object({
  /** claude `--safe-mode` / codex `--disable hooks`: disabled. agy: not_disableable. */
  userHooks: z.enum(["disabled", "not_disableable"]),
  /** claude `--safe-mode` still loads built-in plugins: builtin_only. */
  userPlugins: z.enum(["disabled", "builtin_only", "not_disableable"]),
  userMcp: z.enum(["disabled", "not_disableable"]),
  /** codex: disabled via the untrusted-project override. agy: `.agents/` still loads. */
  projectConfig: z.enum(["disabled", "not_disableable"]),
});
export type AdapterIsolation = z.infer<typeof AdapterIsolationSchema>;

export const AdapterCapabilitiesSchema = z.object({
  /** Adapter id: "claude" | "codex" | "antigravity" | "fake" | ... */
  id: NonEmpty,
  /** Adapter version (semver). */
  version: NonEmpty,
  /** Semver range of the CLI this adapter supports (has recorded fixtures for). */
  cliRange: NonEmpty,
  streaming: z.boolean(),
  /** Autonomy levels the adapter can enforce (antigravity: read-only only). */
  autonomy: z.array(AutonomySchema),
  /** passive = parsed from the run's own stream; reader = out-of-band `readQuota()`. */
  quotaChannel: z.enum(["passive", "reader", "passive+reader", "none"]),
  pool: PoolSchema,
  experimental: z.boolean(),
  promptChannel: PromptChannelSchema,
  isolation: AdapterIsolationSchema,
  /** Who enforces the filesystem boundary for the child's shell commands. */
  sandbox: z.enum(["os", "permission-only"]),
  /** Network available to the child's shell commands (all three CLIs: none by default). */
  childNetwork: z.enum(["none", "allowlist", "open"]),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

/** A fully built child command. The runner spawns it; adapters never spawn processes. */
export const InvocationSchema = z.object({
  /** Absolute, resolved binary path (never a bare name). */
  binary: NonEmpty,
  argv: z.array(z.string()),
  /** Complete child env, built from the allow-list; nothing is inherited. */
  env: z.record(z.string(), z.string()),
  /** The worktree. Load-bearing for agy, which has no cwd flag. */
  cwd: NonEmpty,
  /** Prompt bytes when `promptChannel` is "stdin"; null when the prompt is in argv. */
  stdin: z.string().nullable(),
  /** File the CLI writes its final message to (codex `-o`), read by `finalize()`. */
  outputFile: NonEmpty.optional(),
  /** argv indexes holding the prompt or settings JSON; redacted before logging or storing. */
  redactArgvIndexes: z.array(z.number().int().nonnegative()),
  /**
   * Named guards against known CLI side effects, asserted by golden-argv tests, e.g.
   * "codex-project-trust-untrusted", "codex-agents-disabled", "claude-safe-mode".
   */
  sideEffectGuards: z.array(NonEmpty),
});
export type Invocation = z.infer<typeof InvocationSchema>;

/** Result of probing an installed CLI. */
export interface ProbeResult {
  binaryPath: string | null;
  /** realpath of `binaryPath` (Homebrew Caskroom and versioned dirs differ from the symlink). */
  realpath: string | null;
  version: string | null;
  /** Flags seen in `--help`. */
  flags: string[];
  /** codex: `codex features list` names (unknown `--disable` names fail closed); others: []. */
  features: string[];
  loggedIn: boolean | null;
  /** True when `version` is outside `caps.cliRange` (doctor warns; runs are still allowed). */
  outsideCliRange: boolean;
}

/**
 * Side-effecting dependencies injected into adapters. Adapters must not import
 * `child_process` (only src/runner may spawn), so probes and quota readers go through `spawner`.
 */
export interface AdapterDeps {
  spawner: Spawner;
  clock: Clock;
  /** Binary resolution (config `binary:` → PATH → well-known dirs); null when not found. */
  resolveBinary(name: string, instance: ProviderInstance): Promise<string | null>;
}

/** Arguments of {@link Adapter.buildInvocation}. */
export interface BuildInvocationArgs {
  task: Task;
  target: DecisionTarget;
  autonomy: Autonomy;
  worktree: string;
  /** Main repository root (parent of the git common dir); codex needs it for the trust guard. */
  repoRoot: string;
  /** Per-run directory for `outputFile` and logs. */
  runDir: string;
  instance: ProviderInstance;
  probe: ProbeResult;
  /** Allow-listed base env computed by the runner (PATH, HOME, ..., DISPATCH_DEPTH). */
  baseEnv: Readonly<Record<string, string>>;
}

/** Per-run state shared by parseLine/finalize. */
export interface AdapterRunContext {
  readonly runId: string;
  /** Used to make absolute paths in events (codex `file_change`) worktree-relative. */
  readonly worktree: string;
  scratch: Record<string, unknown>;
}

/** A provider CLI adapter. Pure apart from the injected deps. */
export interface Adapter {
  readonly caps: AdapterCapabilities;
  probe(instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult>;
  buildInvocation(args: BuildInvocationArgs): Invocation;
  parseLine(stream: "stdout" | "stderr", line: string, ctx: AdapterRunContext): NormalizedEvent[];
  finalize(result: SpawnResult & { durationMs: number }, ctx: AdapterRunContext): AdapterOutcome;
  readQuota?(instance: ProviderInstance, deps: AdapterDeps): Promise<QuotaWindow[]>;
}

// ---------------------------------------------------------------------------
// Host integration contracts (frozen by WP1)
// ---------------------------------------------------------------------------

/**
 * One idempotent edit to a host file. `signature` identifies Dispatch's entry so it can be found
 * and removed byte-exactly. For `cli-command`, `file` is the binary and `content` the JSON argv.
 */
export const EditOpSchema = z.object({
  /** Absolute path (or the binary for cli-command). Always user/local scope. */
  file: NonEmpty,
  kind: z.enum(["json-entry", "text-block", "new-file", "rules-file", "cli-command"]),
  signature: NonEmpty,
  content: z.string(),
  /** Octal mode for new-file/rules-file, e.g. "0644" (the launcher is "0755"). */
  mode: z
    .string()
    .regex(/^0[0-7]{3}$/)
    .optional(),
  /** sha256 of the content Dispatch wrote (new-file/rules-file), checked before uninstall. */
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Non-null when the op grants the host extra authority; `setup` shows it verbatim. */
  trustGrant: z.string().nullable(),
});
export type EditOp = z.infer<typeof EditOpSchema>;

/** Context passed to host integrations. All paths are absolute. */
export interface HostPlanContext {
  home: string;
  /** Embedded in the Codex rule, skill and agent text. */
  launcherPath: string;
  /** Hook commands never rely on PATH. */
  nodePath: string;
  hookPath: string;
}

/**
 * How a host's native sub-agent spawn is handled in hard mode.
 * - none: soft mode only (Claude Code in v0.1).
 * - deny_redirect: PreToolUse denies the spawn; the reason tells the model to run
 *   `<launcher> run --detach` and then `wait` (UC3; proxying is not viable on Codex multi-agent V2).
 */
export const SubagentStrategySchema = z.enum(["none", "deny_redirect"]);
export type SubagentStrategy = z.infer<typeof SubagentStrategySchema>;

/** Hook stdin as sent by Claude Code and Codex (common fields; the rest passes through). */
export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  /** Present in Codex SessionStart/PreToolUse; absent in Claude `-p` SessionStart. */
  model?: string;
  /** Codex multi-agent V2 spawn: "collaborationspawn_agent". */
  tool_name?: string;
  /** Codex V2 spawn: `{ task_name, message }` where `message` is encrypted. */
  tool_input?: unknown;
  [key: string]: unknown;
}

/** Response of a hook handler: what to print and how to exit. */
export interface HookResponse {
  /** JSON `hookSpecificOutput` (permissionDecision, permissionDecisionReason, additionalContext). */
  stdout?: string;
  exitCode: number;
}

/** Host self-detection result, from the environment only (never from the PATH binary). */
export interface DetectedHost {
  host: string;
  version: string | null;
}

/** A host CLI that Dispatch integrates with (user/local scope only). */
export interface HostIntegration {
  readonly id: "claude-code" | "codex";
  readonly subagentStrategy: SubagentStrategy;
  /** PreToolUse matcher when the strategy is not "none" (codex: `spawn_agent|collaborationspawn_agent|Agent`). */
  readonly subagentMatcher: string | null;
  /** Default `wait --timeout` in seconds for calls from this host (Claude 100, Codex 280). */
  readonly waitTimeoutSec: number;
  /** `CLAUDECODE` / `CODEX_THREAD_ID` based detection; null when this host is not the caller. */
  detectSelf(env: Readonly<Record<string, string | undefined>>): DetectedHost | null;
  detect(ctx: HostPlanContext): Promise<boolean>;
  plan(ctx: HostPlanContext): EditOp[];
  /** Keyed by hook event name (e.g. "SessionStart", "PreToolUse"). */
  hookHandlers: Record<string, (input: HookInput) => Promise<HookResponse>>;
}
