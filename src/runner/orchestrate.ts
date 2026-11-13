/**
 * Runner core (WP19): one task, decided once, delegated to a single target or along an ordered
 * fallback chain, with the host as the implicit last step (spec §2.7: a task is never lost).
 *
 * Flow: depth check → DecisionInput → `decide` → `recordDecisionWithShadow` → per target
 * {@link runAttempt} → {@link RunResult} (schema v1). Fanout, detach/wait/cancel and idempotency
 * are WP23 (`fanout.ts`, `detach.ts`, `wait.ts`). Everything side-effecting arrives through {@link RunnerDeps}; this module never loads
 * configuration.
 */
import { realpath } from "node:fs/promises";
import { excludePlatformBlocked } from "../adapters/platform.js";
import { browserReadiness, type Readiness } from "../browser/index.js";
import type { EffectiveConfig } from "../config/load.js";
import { dispatchHome as defaultDispatchHome } from "../config/paths.js";
import type {
  Adapter,
  AdapterDeps,
  Clock,
  Decision,
  DecisionInput,
  HostContext,
  QuotaProvider,
  RunResult,
  SessionHistoryEntry,
  Spawner,
  StateStore,
  Task,
} from "../core/contracts.js";
import { newRunId } from "../core/ids.js";
import type { HostDetection } from "../platform/host.js";
import { homeDir, type OsPlatform } from "../platform/os.js";
import {
  decide,
  describeExclusions,
  type InstanceExclusion,
  ROUTER_VERSION,
} from "../router/index.js";
import { repoRoot as gitRepoRoot } from "../sandbox/git.js";
import { decideNetwork, type NetworkDecision, runAgent } from "../sandbox/network.js";
import type { WorktreeCreateOptions, WorktreeHandle } from "../sandbox/worktree.js";
import { recordDecisionWithShadow } from "../shadow/record.js";
import { redact } from "../state/redact.js";
import type { SqliteStateStore } from "../state/store.js";
import type { WebAccess } from "../web/index.js";
import { type AttemptReport, type RunContext, runAttempt } from "./attempt.js";
import { planBrowser } from "./browser.js";
import { assertDepthAllowed, RecursionRejectedError } from "./depth.js";
import { runFanout } from "./fanout.js";
import {
  type ProbeCache,
  processProbeCache,
  type SignalTarget,
  trapTermination,
} from "./lifecycle.js";
import { type McpResolver, planMcp } from "./mcp.js";
import { completed, type ResultParts, rejected, toHost, truncate } from "./result.js";
import { RunLog, resolveRunDir } from "./runlog.js";
import { planWeb } from "./web.js";

export { MAX_SUMMARY_CHARS, reportedPatch } from "./result.js";
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

/** Injected dependencies of {@link executeTask} (built by `runnerDeps` (src/app/runner.ts) or a test). */
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
  /**
   * Instance id of the host session (null: outside any host), as resolved from the environment by
   * the composition root (UC12: `CLAUDE_CONFIG_DIR` selects the account). When absent, the default
   * instance of the detected host's adapter is assumed.
   */
  hostSelf?: string | null;
  /** Default: `$DISPATCH_HOME` or `~/.dispatch` from `env`. */
  dispatchHome?: string;
  /** Receives env values withheld from children, so the store redactor masks them too. */
  addSecrets?: (values: readonly string[]) => void;
  /** Earlier outcomes of the host session (the store has no session index yet). Default: none. */
  sessionHistory?: (sessionId: string) => Promise<SessionHistoryEntry[]>;
  /** Default: the process-wide cache. */
  probes?: ProbeCache;
  /** Resolver of forwarded MCP servers (default: the user's Claude config, read only). */
  resolveMcp?: McpResolver;
  /** Readiness of the isolated browser (tests inject one); default: {@link browserReadiness}. */
  browserReadiness?: () => Readiness;
  /** Node that runs the browser server; default `process.execPath`. */
  nodePath?: string;
  /** OS the children run on (adapters it cannot run are not routed to); default `process.platform`. */
  platform?: OsPlatform;
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
  /** The run is already recorded as `running` (a detached run): update it instead of inserting. */
  recorded?: boolean;
  /**
   * MCP server names the delegated agent needs (a Claude Code handoff's `mcpServers`). They are
   * re-resolved from the user's Claude config at run time ({@link planMcp}); when consent is off,
   * a server is not forwardable or no provider can host them, the task returns to the host.
   */
  mcpServers?: readonly string[];
  /**
   * Web access the delegated agent needs (a handoff of an agent that declares `WebSearch` /
   * `WebFetch`). Only instances that can give it are routed to; when web forwarding is off or none
   * can, the task returns to the host.
   */
  web?: WebAccess;
  /**
   * The custom agent of a Claude Code handoff (its name), for the `network` scope. Absent: the run
   * belongs to `general-purpose` when a host session started it, else to nobody (by hand).
   */
  agent?: string;
  /**
   * The run is for an agent that uses the Claude desktop browser tools: only browser-capable
   * instances (codex) are routed to, with the isolated browser; otherwise the task returns to the
   * host (browser off or not installed, no Chrome, no sandbox network).
   */
  browser?: boolean;
}

/** A run result plus the sandbox network decision (structural superset of the frozen RunResult). */
export type RunResultWithNetwork = RunResult & { sandboxNetwork?: NetworkDecision };

/** `reason` followed by the instances left out on this OS, when any. */
function withExclusions(reason: string, excluded: readonly InstanceExclusion[]): string {
  return excluded.length === 0
    ? reason
    : `${reason} (not available on this OS: ${describeExclusions(excluded)})`;
}

/** The isolated browser's readiness for this run (injected, else checked on disk). */
function readinessOf(deps: RunnerDeps, dispatchHome: string): Readiness {
  if (deps.browserReadiness) return deps.browserReadiness();
  return browserReadiness({
    enabled: deps.config.execution.browser === true,
    dispatchHome,
    platform: deps.platform ?? process.platform,
    home: homeDir(deps.env),
  });
}

/** Host id (from env detection) → adapter id of the instance it runs on. */
const HOST_ADAPTER: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
};

function selfInstance(deps: RunnerDeps): string | null {
  if (deps.hostSelf !== undefined) return deps.hostSelf;
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
  if (opts.recorded) await store.updateRun(runId, { pid: process.pid });
  else {
    await store.recordRun({
      runId,
      status: "running",
      createdAt,
      updatedAt: createdAt,
      instance: null,
      pid: process.pid,
      result: null,
    });
  }

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

  let network: NetworkDecision | null = null;
  const finish = async (parts: ResultParts): Promise<RunResult> => {
    const result: RunResultWithNetwork = {
      schemaVersion: 1,
      runId,
      ...parts,
      summary: truncate(redact(parts.summary, secrets)),
      log: { path: log.path },
      decisions,
      durationMs: Math.max(0, clock.monotonicMs() - startedMs),
    };
    if (parts.usage === undefined) delete result.usage;
    if (parts.results === undefined) delete result.results;
    // Recorded only when the user opted in (scope not off): the default stays as before.
    if (network !== null && network.scope !== "off") result.sandboxNetwork = network;
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

    // Adapters that cannot run on this OS (claude, agy on native Windows) are routed around like
    // an unavailable provider; the reasons reach the run log and, when nothing is left, the result.
    const os = excludePlatformBlocked(deps.config.routing, deps.platform ?? process.platform);
    if (os.excluded.length > 0) {
      log.write({ type: "platform.unsupported", instances: os.excluded });
    }
    const withOs = (reason: string) => withExclusions(reason, os.excluded);

    const mcp = planMcp({
      wanted: opts.mcpServers ?? [],
      forwardMcp: exec.forwardMcp === true,
      repoRoot,
      env: deps.env,
      routing: os.routing,
      ...(deps.resolveMcp ? { resolve: deps.resolveMcp } : {}),
    });
    if (!mcp.ok) {
      log.write({ type: "mcp.unavailable", reason: mcp.reason });
      return await finish(toHost(null, withOs(mcp.reason)));
    }
    if (mcp.servers.length > 0) {
      log.write({
        type: "mcp.forward",
        servers: mcp.servers.map((s) => s.name),
        excludedInstances: mcp.excluded,
      });
    }

    const web = planWeb({
      wanted: opts.web,
      forwardWeb: exec.forwardWeb !== false,
      routing: mcp.routing,
    });
    if (!web.ok) {
      log.write({ type: "web.unavailable", reason: web.reason });
      return await finish(toHost(null, withOs(web.reason)));
    }
    if (web.web !== undefined) {
      log.write({ type: "web.forward", access: web.web, excludedInstances: web.excluded });
    }

    network = decideNetwork({
      scope: exec.network,
      agents: exec.networkAgents,
      agent: runAgent(opts.agent, deps.host.host !== null),
    });
    if (network.scope !== "off") log.write({ type: "network", ...network });

    const browser = planBrowser({
      wanted: opts.browser === true,
      readiness: opts.browser ? readinessOf(deps, home) : { ready: false, reason: "not requested" },
      network,
      autonomy: task.autonomy,
      routing: web.routing,
      nodePath: deps.nodePath ?? process.execPath,
      repoRoot,
    });
    if (!browser.ok) {
      log.write({ type: "browser.unavailable", reason: browser.reason });
      return await finish(toHost(null, withOs(browser.reason)));
    }
    if (browser.browser !== undefined) {
      log.write({
        type: "browser.forward",
        origins: browser.browser.origins,
        excludedInstances: browser.excluded,
      });
    }

    const input: DecisionInput = {
      task,
      host: {
        self: selfInstance(deps),
        ...(opts.sessionModel ? { sessionModel: opts.sessionModel } : {}),
        depth,
      },
      routing: browser.routing as unknown as Record<string, unknown>,
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
    if (decision.action === "host") return await finish(toHost(null, withOs(decision.reason)));

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
      mcpServers: mcp.servers,
      ...(web.web === undefined ? {} : { web: web.web }),
      ...(network.enabled ? { network: true } : {}),
      ...(browser.browser === undefined ? {} : { browser: browser.browser }),
    };
    if (decision.mode === "fanout") return await finish(await runFanout(rc, decision.targets));
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
    return await finish(toHost(lastOutcome, withOs(reason)));
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
