/**
 * Core contracts for Dispatch.
 *
 * Everything exported from this file is FROZEN once merged (see docs/adr/0001-frozen-contracts.md):
 * changing a schema, type or port requires a new ADR. Items tagged `@provisional — frozen by WP1`
 * may still change until the WP1 live spike freezes them.
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
  kind: z.enum(["reading", "editing", "running", "thinking", "done", "error"]),
  ts: IsoUtc,
  detail: z.string().optional(),
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

/** What an adapter reports once its child process has ended. */
export const AdapterOutcomeSchema = z.object({
  outcome: OutcomeSchema,
  summary: z.string(),
  usage: UsageSchema.optional(),
  /** When quota is exhausted, the provider's announced reset time, if known. */
  resetAt: IsoUtc.optional(),
  nativeError: z.string().optional(),
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
// Provisional contracts (frozen by WP1)
// ---------------------------------------------------------------------------

/** @provisional — frozen by WP1 */
export const AdapterCapabilitiesSchema = z.object({
  id: NonEmpty,
  version: NonEmpty,
  /** Semver range of the CLI this adapter supports. */
  cliRange: NonEmpty,
  streaming: z.boolean(),
  autonomy: z.array(AutonomySchema),
  quotaChannel: z.enum(["passive", "reader", "none"]),
  pool: PoolSchema,
  experimental: z.boolean(),
});
/** @provisional — frozen by WP1 */
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

/** @provisional — frozen by WP1 */
export const InvocationSchema = z.object({
  binary: NonEmpty,
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  cwd: NonEmpty,
  stdin: z.string(),
});
/** @provisional — frozen by WP1 */
export type Invocation = z.infer<typeof InvocationSchema>;

/** Result of probing an installed CLI. @provisional — frozen by WP1 */
export interface ProbeResult {
  binaryPath: string | null;
  version: string | null;
  flags: string[];
  loggedIn: boolean | null;
}

/** Arguments of {@link Adapter.buildInvocation}. @provisional — frozen by WP1 */
export interface BuildInvocationArgs {
  task: Task;
  target: DecisionTarget;
  autonomy: Autonomy;
  worktree: string;
  instance: ProviderInstance;
  probe: ProbeResult;
}

/** Per-run mutable scratch space shared by parseLine/finalize. @provisional — frozen by WP1 */
export interface AdapterRunContext {
  readonly runId: string;
  scratch: Record<string, unknown>;
}

/** @provisional — frozen by WP1 */
export interface Adapter {
  readonly caps: AdapterCapabilities;
  probe(instance: ProviderInstance): Promise<ProbeResult>;
  buildInvocation(args: BuildInvocationArgs): Invocation;
  parseLine(line: string, ctx: AdapterRunContext): NormalizedEvent[];
  finalize(result: SpawnResult & { durationMs: number }, ctx: AdapterRunContext): AdapterOutcome;
  readQuota?(instance: ProviderInstance): Promise<QuotaWindow[]>;
}

/**
 * One idempotent edit to a host file. `signature` identifies Dispatch's entry so it can be found
 * and removed byte-exactly. For `cli-command`, `file` is the binary and `content` the JSON argv.
 * @provisional — frozen by WP1
 */
export const EditOpSchema = z.object({
  file: NonEmpty,
  kind: z.enum(["json-entry", "text-block", "new-file", "rules-file", "cli-command"]),
  signature: NonEmpty,
  content: z.string(),
});
/** @provisional — frozen by WP1 */
export type EditOp = z.infer<typeof EditOpSchema>;

/** Context passed to host integrations. @provisional — frozen by WP1 */
export interface HostPlanContext {
  home: string;
  launcherPath: string;
  hookPath: string;
}

/** Response of a hook handler: what to print and how to exit. @provisional — frozen by WP1 */
export interface HookResponse {
  stdout?: string;
  exitCode: number;
}

/** @provisional — frozen by WP1 */
export interface HostIntegration {
  readonly id: string;
  detect(ctx: HostPlanContext): Promise<boolean>;
  plan(ctx: HostPlanContext): EditOp[];
  /** Keyed by hook event name (e.g. "SessionStart"). */
  hookHandlers: Record<string, (input: unknown) => Promise<HookResponse>>;
}
