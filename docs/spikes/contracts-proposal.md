# WP1 contract freeze proposal

This proposes final shapes for the `@provisional — frozen by WP1` items in `src/core/contracts.ts` (WP0 branch). Everything not listed stays as WP0 wrote it. Each change is justified by a spike finding; references point to `codex.md`, `claude-code.md`, `agy.md` and `hosts.md`.

## Summary of changes vs WP0

| Item | Change | Why |
|---|---|---|
| `AdapterCapabilities` | add `promptChannel`, `isolation`, `sandbox`, `childNetwork`; `quotaChannel` gains `"passive+reader"` | agy cannot take the prompt on stdin. agy user hooks cannot be disabled. Claude has passive events, Codex has the app-server, agy has `/usage`. |
| `Invocation` | `stdin` becomes nullable; add `outputFile`, `sideEffectGuards`, `redactArgvIndexes` | agy prompt goes in argv. Codex `-o last.txt`. The Codex trust-write guard must be visible and tested. |
| `ProbeResult` | add `features`, `realpath`, `hostBundled` | Codex feature names must be validated. The desktop host binary differs from the PATH binary. |
| `AdapterOutcome` | add `deniedActions`, `quotaSignal` | agy reports `SUCCESS` with denied actions. The quota signal source must be recorded. |
| `NormalizedEvent.kind` | add `"denied"` | Permission denials appear in all three CLIs (Claude `permission_denied` and `permission_denials`, agy `TOOL_ERROR`/`denied_actions`, Codex none). |
| `HostIntegration` | add `subagentStrategy`, `waitTimeoutSec`, `detectSelf(env)`, typed hook I/O | UC3 resolves to `deny_redirect`. Timeouts differ per host. Self-detection uses env only. |
| `EditOp` | add `mode`, `sha256`, `trustGrant`; kinds unchanged | Rules file and hooks need byte-exact uninstall plus explicit trust disclosure. |

## Final TypeScript

```ts
// ---------------------------------------------------------------------------
// Adapter contracts (frozen by WP1)
// ---------------------------------------------------------------------------

/** How the task prompt reaches the child CLI. */
export const PromptChannelSchema = z.enum(["stdin", "argv"]);
export type PromptChannel = z.infer<typeof PromptChannelSchema>;

export const AdapterCapabilitiesSchema = z.object({
  id: NonEmpty,                       // "claude" | "codex" | "antigravity" | "fake"
  version: NonEmpty,                  // adapter version (semver)
  /** Semver range of the CLI this adapter supports (has fixtures for). */
  cliRange: NonEmpty,                 // claude ">=2.1.301 <2.2", codex ">=0.167.0 <0.168", agy ">=1.5.2 <1.6"
  streaming: z.boolean(),
  /** Autonomy levels the adapter can enforce. agy: ["read-only"] only. */
  autonomy: z.array(AutonomySchema),
  /** passive = parsed from the run's own stream; reader = out-of-band readQuota(). */
  quotaChannel: z.enum(["passive", "reader", "passive+reader", "none"]),
  pool: PoolSchema,
  experimental: z.boolean(),
  /** claude/codex: "stdin"; agy: "argv" (-p=<prompt>; stdin is ignored, `-p -` is literal). */
  promptChannel: PromptChannelSchema,
  /** What the child is isolated from, as verified by WP1 (doctor prints this). */
  isolation: z.object({
    userHooks: z.enum(["disabled", "not_disableable"]),   // claude --safe-mode / codex --disable hooks / agy: not_disableable
    userPlugins: z.enum(["disabled", "builtin_only", "not_disableable"]), // claude: builtin_only
    userMcp: z.enum(["disabled", "not_disableable"]),
    projectConfig: z.enum(["disabled", "not_disableable"]), // codex: untrusted override; agy: .agents/ loads
  }),
  /** Who enforces the filesystem boundary for shell commands in the child. */
  sandbox: z.enum(["os", "permission-only"]),           // claude/codex: os (seatbelt/bwrap); agy: permission-only
  /** Network inside the child's shell commands. All three: "none" by default. */
  childNetwork: z.enum(["none", "allowlist", "open"]),
});
export type AdapterCapabilities = z.infer<typeof AdapterCapabilitiesSchema>;

export const InvocationSchema = z.object({
  /** Absolute, resolved binary path (never a bare name). */
  binary: NonEmpty,
  argv: z.array(z.string()),
  /** Complete child env, built from the allow-list; no inheritance. */
  env: z.record(z.string(), z.string()),
  /** The worktree (agy has no cwd flag, so cwd is load-bearing). */
  cwd: NonEmpty,
  /** Prompt bytes when promptChannel is "stdin"; null when the prompt is in argv. */
  stdin: z.string().nullable(),
  /** File the CLI writes its final message to (codex -o), read by finalize(). */
  outputFile: NonEmpty.optional(),
  /** argv indexes holding the prompt or settings JSON: redacted before logging/state. */
  redactArgvIndexes: z.array(z.number().int().nonnegative()),
  /**
   * Named guards against known CLI side effects on user files, asserted in golden-argv tests.
   * e.g. "codex-project-trust-untrusted" (prevents exec from persisting [projects] trust into
   * ~/.codex/config.toml), "claude-safe-mode", "codex-agents-disabled".
   */
  sideEffectGuards: z.array(NonEmpty),
});
export type Invocation = z.infer<typeof InvocationSchema>;

export interface ProbeResult {
  /** Resolved path and its realpath (Caskroom/versioned dirs). */
  binaryPath: string | null;
  realpath: string | null;
  version: string | null;
  /** Flags seen in --help. */
  flags: string[];
  /** Codex: `codex features list` names; others: []. Unknown --disable names fail closed. */
  features: string[];
  loggedIn: boolean | null;
  /** True when the version is outside caps.cliRange (doctor warns; run still allowed). */
  outsideCliRange: boolean;
}

export interface BuildInvocationArgs {
  task: Task;
  target: DecisionTarget;
  autonomy: Autonomy;
  worktree: string;
  /** Main repository root (git common dir parent); codex needs it for the trust guard. */
  repoRoot: string;
  /** Run directory for outputFile, logs. */
  runDir: string;
  instance: ProviderInstance;
  probe: ProbeResult;
  /** Base env allow-list already computed by the runner (PATH, HOME, ..., DISPATCH_DEPTH). */
  baseEnv: Readonly<Record<string, string>>;
}

export interface AdapterRunContext {
  readonly runId: string;
  readonly worktree: string;          // to relativize codex file_change paths
  scratch: Record<string, unknown>;
}

export const NormalizedEventSchema = z.object({
  kind: z.enum(["reading", "editing", "running", "thinking", "denied", "done", "error"]),
  ts: IsoUtc,
  detail: z.string().optional(),
  /** Worktree-relative path for reading/editing. */
  path: z.string().optional(),
});

export const QuotaSignalSchema = z.object({
  /** Which evidence classified the run as quota_exhausted. */
  source: z.enum([
    "claude.rate_limit_event.rejected", "claude.assistant.error", "claude.api_error_status_429", "claude.text",
    "codex.turn_failed.usage_limit", "agy.agy_error.quota",
  ]),
  raw: z.string(),
});

export const AdapterOutcomeSchema = z.object({
  outcome: OutcomeSchema,
  summary: z.string(),
  usage: UsageSchema.optional(),
  resetAt: IsoUtc.optional(),
  nativeError: z.string().optional(),
  /** Tool actions the child CLI denied (agy denied_actions, claude permission_denials). */
  deniedActions: z.array(z.string()),
  quotaSignal: QuotaSignalSchema.optional(),
  durationMs: z.number().nonnegative(),
});

export interface Adapter {
  readonly caps: AdapterCapabilities;
  probe(instance: ProviderInstance): Promise<ProbeResult>;
  buildInvocation(args: BuildInvocationArgs): Invocation;
  parseLine(stream: "stdout" | "stderr", line: string, ctx: AdapterRunContext): NormalizedEvent[];
  finalize(result: SpawnResult & { durationMs: number }, ctx: AdapterRunContext): AdapterOutcome;
  readQuota?(instance: ProviderInstance): Promise<QuotaWindow[]>;
}

// ---------------------------------------------------------------------------
// Host integration contracts (frozen by WP1)
// ---------------------------------------------------------------------------

export const EditOpSchema = z.object({
  /** Absolute path (or binary for cli-command). Always under user/local scope. */
  file: NonEmpty,
  kind: z.enum(["json-entry", "text-block", "new-file", "rules-file", "cli-command"]),
  /** Identifies Dispatch's entry for idempotent re-apply and byte-exact removal. */
  signature: NonEmpty,
  content: z.string(),
  /** For new-file/rules-file: octal mode, e.g. "0644"; the launcher is "0755". */
  mode: z.string().regex(/^0[0-7]{3}$/).optional(),
  /** sha256 of the file content Dispatch wrote (new-file/rules-file), checked before uninstall. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** Non-null when applying this op grants the host extra authority; shown verbatim by setup. */
  trustGrant: z.string().nullable(),
});
export type EditOp = z.infer<typeof EditOpSchema>;

export interface HostPlanContext {
  home: string;
  launcherPath: string;   // absolute; embedded in rules + skill + agent text
  nodePath: string;       // absolute; hook commands never rely on PATH
  hookPath: string;
}

/** How a host's native sub-agent spawn is handled in hard mode. */
export type SubagentStrategy =
  | "none"            // soft mode only (Claude Code v0.1)
  | "deny_redirect";  // PreToolUse deny; reason instructs the model to run `<launcher> run --detach` then `wait`

export interface HookInput {
  hook_event_name: string;
  session_id: string;
  cwd: string;
  /** Present in Codex SessionStart/PreToolUse; absent in Claude -p SessionStart. */
  model?: string;
  tool_name?: string;           // codex V2: "collaborationspawn_agent"
  tool_input?: unknown;         // codex V2 spawn: { task_name, message: <encrypted> }
  [k: string]: unknown;
}

export interface HookResponse {
  stdout?: string;   // JSON: hookSpecificOutput {permissionDecision, permissionDecisionReason, additionalContext}
  exitCode: number;
}

export interface HostIntegration {
  readonly id: "claude-code" | "codex";
  readonly subagentStrategy: SubagentStrategy;
  /** Matcher written for PreToolUse when subagentStrategy != "none". Codex: "spawn_agent|collaborationspawn_agent|Agent". */
  readonly subagentMatcher: string | null;
  /** Default `wait --timeout` seconds for calls from this host (Claude 100, Codex 280). */
  readonly waitTimeoutSec: number;
  /** Env-only self detection (CLAUDECODE / CODEX_THREAD_ID); returns instance hint or null. */
  detectSelf(env: Readonly<Record<string, string | undefined>>): { host: string; version: string | null } | null;
  detect(ctx: HostPlanContext): Promise<boolean>;
  plan(ctx: HostPlanContext): EditOp[];
  hookHandlers: Record<string, (input: HookInput) => Promise<HookResponse>>;
}
```

## Concrete adapter values

| | claude | codex | antigravity |
|---|---|---|---|
| autonomy | read-only, worktree | read-only, worktree | read-only |
| quotaChannel | passive (+reader via `/usage` text: display only) | passive+reader (turn.failed text + app-server) | reader (`/usage`) |
| promptChannel | stdin | stdin | argv |
| isolation.userHooks / plugins / mcp / projectConfig | disabled / builtin_only / disabled / disabled | disabled / disabled / disabled / disabled (untrusted override) | not_disableable ×3 / not_disableable |
| sandbox / childNetwork | os / none | os / none | permission-only / none |
| sideEffectGuards | `claude-safe-mode`, `claude-sandbox-fail-closed` | `codex-project-trust-untrusted`, `codex-agents-disabled` | `agy-no-skip-permissions` |
