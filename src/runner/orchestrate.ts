/**
 * Runner core (WP19): one task, decided once, delegated to a single target or along an ordered
 * fallback chain, with the host as the implicit last step (spec §2.7: a task is never lost).
 *
 * Flow: depth check → DecisionInput → `decide` → `recordDecisionWithShadow` → per target
 * {@link runAttempt} → {@link RunResult} (schema v1). Fanout, detach/wait/cancel and idempotency
 * are WP23. Everything side-effecting arrives through {@link RunnerDeps}; this module never loads
 * configuration.
 */
import { realpath } from "node:fs/promises";
import type { EffectiveConfig } from "../config/load.js";
import { dispatchHome as defaultDispatchHome } from "../config/paths.js";
import {
  type Adapter,
  type AdapterDeps,
  type Clock,
  type Decision,
  type DecisionInput,
  EXTERNAL_AGENT_MARKER,
  type HostContext,
  type QuotaProvider,
  type RunResult,
  type SessionHistoryEntry,
  type Spawner,
  type StateStore,
  type Task,
} from "../core/contracts.js";
import { newRunId } from "../core/ids.js";
import type { HostDetection } from "../platform/host.js";
import { decide, ROUTER_VERSION } from "../router/index.js";
import { repoRoot as gitRepoRoot } from "../sandbox/git.js";
import type { WorktreeCreateOptions, WorktreeHandle } from "../sandbox/worktree.js";
import { recordDecisionWithShadow } from "../shadow/record.js";
import { redact } from "../state/redact.js";
import type { SqliteStateStore } from "../state/store.js";
import { type AttemptReport, type RunContext, runAttempt } from "./attempt.js";
import { assertDepthAllowed, RecursionRejectedError } from "./depth.js";
import {
  type ProbeCache,
  processProbeCache,
  type SignalTarget,
  trapTermination,
} from "./lifecycle.js";
import { RunLog, resolveRunDir } from "./runlog.js";

/** Longest summary handed back to the host (characters). */
export const MAX_SUMMARY_CHARS = 8 * 1024;
/** Default bounded wait for a concurrency slot on the last target. */
export const DEFAULT_LEASE_WAIT_MS = 30_000;

/** The state-store operations the runner uses (the port plus SQLite extras). */
export type RunnerStore = StateStore &
  Pick<
    SqliteStateStore,
    "recordShadow" | "acquireLease" | "releaseLease" | "heartbeat" | "activeQuotaSignals"
  >;

/** Worktree sandbox as the runner uses it. */
export interface RunnerSandbox {
  create(opts: WorktreeCreateOptions): Promise<WorktreeHandle>;
  dispose(path: string, keep: boolean): Promise<void>;
}

/** Injected dependencies of {@link executeTask} (built by `createRunnerDeps` or a test). */
export interface RunnerDeps {
  config: Pick<EffectiveConfig, "routing" | "execution">;
  store: RunnerStore;
  quota: QuotaProvider;
  clock: Clock;
  spawner: Spawner;
  sandbox: RunnerSandbox;
  /** Adapters by adapter id (`claude`, `codex`, `antigravity`, ...). */
  adapters: Readonly<Record<string, Adapter>>;
  resolveBinary: AdapterDeps["resolveBinary"];
  /** The environment Dispatch itself runs in (source of the child allow-list and depth). */
  env: Readonly<Record<string, string | undefined>>;
  host: HostDetection;
  /** Default: `$DISPATCH_HOME` or `~/.dispatch` from `env`. */
  dispatchHome?: string;
  /** Receives env values withheld from children, so the store redactor masks them too. */
  addSecrets?: (values: readonly string[]) => void;
  /** Earlier outcomes of the host session (the store has no session index yet). Default: none. */
  sessionHistory?: (sessionId: string) => Promise<SessionHistoryEntry[]>;
  /** Default: the process-wide cache. */
  probes?: ProbeCache;
}

/** Per-call options of {@link executeTask}. */
export interface ExecuteOptions {
  /** Directory the task was submitted from (normally the cwd). */
  repoPath: string;
  runId?: string;
  /** The host session's model, when the host reported it. */
  sessionModel?: HostContext["sessionModel"];
  /** Bounded wait for a lease on the last target (default 30 s). */
  leaseWaitMs?: number;
  /** Aborting cancels the run like SIGINT (child group killed, lease released, worktree disposed). */
  signal?: AbortSignal;
  /** Where SIGINT/SIGTERM are trapped: default `process`; null disables trapping. */
  signals?: SignalTarget | null;
}

/** Host id (from env detection) → adapter id of the instance it runs on. */
const HOST_ADAPTER: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
};

function selfInstance(deps: RunnerDeps): string | null {
  const adapter = deps.host.host ? HOST_ADAPTER[deps.host.host] : undefined;
  if (!adapter) return null;
  const all = deps.config.execution.instances.filter((i) => i.adapter === adapter);
  return (all.find((i) => i.id === adapter) ?? all[0])?.id ?? adapter;
}

/** Pins whose action keeps paths on the host; their globs are enforced again at patch time. */
function pinnedGlobs(deps: RunnerDeps): string[] {
  return deps.config.routing.pins
    .filter((r) => r.action.type === "host")
    .flatMap((r) => r.match.paths ?? []);
}

function truncate(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  return `${text.slice(0, MAX_SUMMARY_CHARS)}\n…[truncated ${text.length - MAX_SUMMARY_CHARS} chars]`;
}

/**
 * Executes `task` end to end and returns its {@link RunResult}. Never throws for an agent, quota,
 * sandbox or patch failure: those become the result. Throws only when the run cannot even be
 * recorded (e.g. the state store is broken).
 */
export async function executeTask(
  deps: RunnerDeps,
  task: Task,
  opts: ExecuteOptions,
): Promise<RunResult> {
  const { clock, store } = deps;
  const startedMs = clock.monotonicMs();
  const runId = opts.runId ?? newRunId(clock);
  const home = deps.dispatchHome ?? defaultDispatchHome(deps.env);
  const repoRoot = await realpath((await gitRepoRoot(opts.repoPath)) ?? opts.repoPath);
  const runDir = resolveRunDir(repoRoot, home, runId);
  const secrets: string[] = [];
  const log = new RunLog(runDir, () => secrets);
  const decisions: Decision[] = [];
  const createdAt = clock.now().toISOString();
  await store.recordRun({
    runId,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    instance: null,
    pid: process.pid,
    result: null,
  });

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  if (opts.signal?.aborted) controller.abort();
  const signals = opts.signals === undefined ? process : opts.signals;
  const untrap = signals
    ? trapTermination(signals, (sig) => {
        log.write({ type: "signal", signal: sig });
        controller.abort();
      })
    : () => {};

  const finish = async (
    parts: Pick<RunResult, "status" | "outcome" | "summary" | "externalAgent" | "patch"> &
      Pick<Partial<RunResult>, "usage">,
  ): Promise<RunResult> => {
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      ...parts,
      summary: truncate(redact(parts.summary, secrets)),
      log: { path: log.path },
      decisions,
      durationMs: Math.max(0, clock.monotonicMs() - startedMs),
    };
    if (parts.usage === undefined) delete result.usage;
    log.write({ type: "run.end", status: result.status, outcome: result.outcome });
    await store.updateRun(runId, {
      status: result.status,
      updatedAt: clock.now().toISOString(),
      instance: result.externalAgent?.instance ?? null,
      result,
    });
    return result;
  };

  try {
    const exec = deps.config.execution;
    let depth: number;
    try {
      depth = assertDepthAllowed(deps.env, exec.maxDepth);
    } catch (err) {
      if (!(err instanceof RecursionRejectedError)) throw err;
      return await finish(rejected(err.message));
    }

    const input: DecisionInput = {
      task,
      host: {
        self: selfInstance(deps),
        ...(opts.sessionModel ? { sessionModel: opts.sessionModel } : {}),
        depth,
      },
      routing: deps.config.routing as unknown as Record<string, unknown>,
      quota: await deps.quota.snapshot(exec.instances),
      sessionHistory:
        deps.sessionHistory && deps.host.sessionId
          ? await deps.sessionHistory(deps.host.sessionId)
          : [],
      now: clock.now().toISOString(),
      routerVersion: ROUTER_VERSION,
    };
    const decision = decide(input);
    decisions.push(decision);
    await recordDecisionWithShadow(store, input, decision, { runId, clock });
    log.write({
      type: "decision",
      action: decision.action,
      mode: decision.mode,
      reason: decision.reason,
      targets: decision.targets,
    });

    if (decision.action === "reject") return await finish(rejected(decision.reason));
    if (decision.action === "host") return await finish(toHost(null, decision.reason));
    if (decision.mode === "fanout") return await finish(rejected("fanout not implemented yet"));

    const rc: RunContext = {
      deps,
      probes: deps.probes ?? processProbeCache,
      task,
      runId,
      runDir,
      log,
      repoPath: opts.repoPath,
      repoRoot,
      dispatchHome: home,
      depth,
      pins: pinnedGlobs(deps),
      secrets,
      signal: controller.signal,
      leaseWaitMs: opts.leaseWaitMs ?? DEFAULT_LEASE_WAIT_MS,
    };
    const reports: AttemptReport[] = [];
    for (const [i, target] of decision.targets.entries()) {
      if (controller.signal.aborted) break;
      const report = await runAttempt(rc, target, i, i === decision.targets.length - 1);
      reports.push(report);
      if (report.final && report.outcome) return await finish(completed(report));
    }
    const lastOutcome = reports.findLast((r) => r.outcome)?.outcome?.outcome ?? null;
    const why = reports.map((r) => `${r.target.instance}: ${r.note}`).join("; ");
    const reason = controller.signal.aborted
      ? `interrupted; ${why || "no attempt started"}`
      : `all delegation targets exhausted: ${why}`;
    return await finish(toHost(lastOutcome, reason));
  } catch (err) {
    // E.g. an invalid routing config or a quota provider bug: the task still goes back (§2.7).
    const message = err instanceof Error ? err.message : String(err);
    log.write({ type: "run.error", error: message });
    return await finish(toHost(null, `dispatch could not run the task: ${message}`));
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    untrap();
  }
}

function rejected(summary: string) {
  return {
    status: "rejected",
    outcome: "rejected",
    summary,
    externalAgent: null,
    patch: null,
  } as const;
}

function toHost(outcome: RunResult["outcome"], summary: string) {
  return {
    status: "returned_to_host",
    outcome,
    summary,
    externalAgent: null,
    patch: null,
  } as const;
}

function completed(report: AttemptReport) {
  const out = report.outcome as NonNullable<AttemptReport["outcome"]>;
  const patch = report.patch && !report.patch.empty ? report.patch.patch : null;
  return {
    status: "completed",
    outcome: out.outcome,
    summary: out.summary,
    externalAgent: {
      provider: report.adapterId ?? report.target.instance,
      instance: report.target.instance,
      model: report.target.model,
      marker: EXTERNAL_AGENT_MARKER,
    },
    patch,
    usage: out.usage,
  } as const;
}
