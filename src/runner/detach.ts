/**
 * Detached runs (plan §2 "Runner", UC3): `run --detach` records the run and hands it to a
 * supervisor process (`dispatch __supervise <runId>`) started in a new session / process group,
 * so the host's tool call returns at once and the host collects the result with `wait`.
 *
 * - The task travels in a 0600 file inside the run directory, never in argv or env.
 * - The supervisor beats every {@link SUPERVISOR_HEARTBEAT_MS} (the run's `updatedAt`), ignores
 *   SIGHUP, and turns SIGTERM/SIGINT (`cancel`) into a cancelled result after the child group is
 *   killed, its lease released and its worktree disposed.
 * - Idempotency (red-team R4): the same key returns the existing run instead of starting another
 *   one, so a host that retries the redirected call does not double the work.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import type { Clock, HostContext, RunRecord, RunResult, Task } from "../core/contracts.js";
import { newRunId } from "../core/ids.js";
import type { HostDetection } from "../platform/host.js";
import { canonicalJson } from "../router/canonical.js";
import { repoRoot as gitRepoRoot } from "../sandbox/git.js";
import type { SqliteStateStore } from "../state/store.js";
import { withWeb } from "../web/index.js";
import { type ExecuteOptions, executeTask, type RunnerDeps } from "./orchestrate.js";
import { failedRun, toHost } from "./result.js";
import { EVENTS_FILE, resolveRunDir } from "./runlog.js";

/** File (in the run directory) that carries the task to the supervisor. */
export const TASK_FILE = "task.json";
/** Supervisor stdout/stderr (in the run directory). */
export const SUPERVISOR_LOG = "supervisor.log";
/** Name of the hidden CLI command that runs a detached task. */
export const SUPERVISE_COMMAND = "__supervise";
/** Heartbeat period of a supervisor. */
export const SUPERVISOR_HEARTBEAT_MS = 5_000;
/** How long `startDetached` waits for the supervisor's first heartbeat. */
export const START_WAIT_MS = 2_000;
/** Summary of a cancelled run. */
export const CANCELLED = "cancelled";

type Env = Readonly<Record<string, string | undefined>>;

/** A run started from a Claude hard-mode handoff (`run --handoff`). */
export interface DetachHandoff {
  /** The custom agent's name. */
  agent: string;
  /** Recorded as a passthrough when the run hands the task back. */
  passthroughKey: string;
  autoApply: boolean;
  /** MCP servers the agent needs; the supervisor re-resolves and forwards them (names only). */
  mcpServers: string[];
  /** The agent needs web access (see `webAccessOf`). Absent: none. */
  web?: boolean;
  /** The agent declares WebFetch (absent with `web`: treated as true). */
  webFetch?: boolean;
}

/** What the supervisor needs to run the task (the content of {@link TASK_FILE}). */
export interface DetachPayload {
  task: Task;
  /** Directory the task was submitted from. */
  repoPath: string;
  sessionModel?: HostContext["sessionModel"];
  /** `run --provider <instance>`, re-applied by the supervisor when it loads the config. */
  provider?: string;
  /** Set for `run --handoff`. */
  handoff?: DetachHandoff;
}

/** Store operations used to start a detached run. */
export type DetachStore = Pick<
  SqliteStateStore,
  "recordRun" | "getRun" | "updateRun" | "getOrCreateIdempotent"
>;

/** Dependencies of {@link startDetached}. */
export interface DetachDeps {
  store: DetachStore;
  clock: Clock;
  /** Environment handed to the supervisor (it filters what reaches agents itself). */
  env: Env;
  dispatchHome: string;
  host: HostDetection;
  /**
   * Command that starts the Dispatch CLI: default `[node, --disable-warning=ExperimentalWarning,
   * <this cli script>]`.
   */
  cli?: readonly string[];
  /** Default {@link START_WAIT_MS}. */
  startWaitMs?: number;
}

/** Per-call options of {@link startDetached}. */
export interface DetachOptions extends Omit<DetachPayload, "task"> {
  /** Explicit idempotency key (`--idempotency-key`). */
  idempotencyKey?: string;
}

/** Result of {@link startDetached}. */
export interface Detached {
  runId: string;
  /** False when an idempotency key matched an existing run (nothing new was started). */
  created: boolean;
}

/**
 * The idempotency key of a submission: the explicit key, else (inside a host session) a hash of
 * the session id and the canonical task without its per-call id. Null when neither exists.
 */
export function idempotencyKey(task: Task, host: HostDetection, explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") return `key:${explicit}`;
  if (!host.sessionId) return null;
  const { id: _perCall, ...stable } = task;
  const hash = createHash("sha256")
    .update(`${host.host ?? ""}\u0000${host.sessionId}\u0000${canonicalJson(stable)}`)
    .digest("hex");
  return `auto:${hash}`;
}

function defaultCli(): string[] {
  return [process.execPath, "--disable-warning=ExperimentalWarning", process.argv[1] ?? ""];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True once the supervisor has beaten (or the run already ended). */
function started(run: RunRecord | null): boolean {
  return run !== null && (run.status !== "running" || run.updatedAt > run.createdAt);
}

/**
 * Records `task` as a running run and starts its supervisor in a new session (detached, stdio to
 * `<runDir>/supervisor.log`, unref'd). Waits up to 2 s for the supervisor's first heartbeat; a
 * supervisor that is merely slow is left alone (`wait` judges liveness later).
 */
export async function startDetached(
  deps: DetachDeps,
  task: Task,
  opts: DetachOptions,
): Promise<Detached> {
  const { store, clock } = deps;
  const key = idempotencyKey(task, deps.host, opts.idempotencyKey);
  let runId = newRunId(clock);
  if (key !== null) {
    const bound = store.getOrCreateIdempotent(key, () => runId);
    runId = bound.runId;
    if (!bound.created && (await store.getRun(runId)) !== null) return { runId, created: false };
  }

  const repoRoot = await realpath((await gitRepoRoot(opts.repoPath)) ?? opts.repoPath);
  const runDir = resolveRunDir(repoRoot, deps.dispatchHome, runId);
  const payload: DetachPayload = {
    task,
    repoPath: opts.repoPath,
    ...(opts.sessionModel ? { sessionModel: opts.sessionModel } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.handoff !== undefined ? { handoff: opts.handoff } : {}),
  };
  writeFileSync(join(runDir, TASK_FILE), JSON.stringify(payload), { mode: 0o600 });
  const createdAt = clock.now().toISOString();
  await store.recordRun({
    runId,
    status: "running",
    createdAt,
    updatedAt: createdAt,
    instance: null,
    pid: null,
    result: null,
  });

  const [command = process.execPath, ...args] = deps.cli ?? defaultCli();
  const env = Object.fromEntries(
    Object.entries(deps.env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  const out = openSync(join(runDir, SUPERVISOR_LOG), "a", 0o600);
  let spawnError: Error | null = null;
  try {
    const child = spawn(command, [...args, SUPERVISE_COMMAND, runId, "--run-dir", runDir], {
      cwd: opts.repoPath,
      env,
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.on("error", (err) => {
      spawnError = err;
    });
    child.unref();
    if (child.pid !== undefined) {
      await store.updateRun(runId, { pid: child.pid, updatedAt: createdAt });
    }
  } finally {
    closeSync(out);
  }

  const deadline = clock.monotonicMs() + (deps.startWaitMs ?? START_WAIT_MS);
  while (clock.monotonicMs() < deadline) {
    if (spawnError !== null || started(await store.getRun(runId))) break;
    await sleep(50);
  }
  if (spawnError !== null) {
    const message = `the supervisor could not start: ${(spawnError as Error).message}`;
    await recordSupervisorFailure(store, runId, runDir, message);
  }
  return { runId, created: true };
}

/**
 * Ends a detached run whose supervisor could not run it (spawn error, unreadable task file,
 * broken config): the task returns to the host with the reason (spec §2.7).
 */
export async function recordSupervisorFailure(
  store: Pick<SqliteStateStore, "updateRun">,
  runId: string,
  runDir: string,
  message: string,
): Promise<RunResult> {
  const result: RunResult = {
    schemaVersion: 1,
    runId,
    ...toHost(null, message),
    log: { path: join(runDir, EVENTS_FILE) },
    decisions: [],
    durationMs: 0,
  };
  await store.updateRun(runId, { status: result.status, result });
  return result;
}

/** Dependencies of {@link superviseRun}. */
export interface SuperviseDeps {
  /** Builds the runner dependencies for the payload (config is loaded from its repo). */
  build(payload: DetachPayload): Promise<RunnerDeps & { close(): void }>;
  /** Where SIGTERM/SIGINT/SIGHUP are handled: default `process`. */
  signals?: Pick<NodeJS.Process, "on" | "off">;
  /** Default {@link SUPERVISOR_HEARTBEAT_MS}. */
  heartbeatMs?: number;
  /** Called with the final result (errors are ignored). */
  onFinished?(payload: DetachPayload, result: RunResult): void;
}

/**
 * Body of `__supervise <runId>`: reads (and deletes) the task file, runs the task, beats while it
 * runs and records the final result. SIGHUP is ignored; SIGTERM/SIGINT cancel the run.
 */
export async function superviseRun(
  deps: SuperviseDeps,
  runId: string,
  runDir: string,
): Promise<RunResult> {
  const file = join(runDir, TASK_FILE);
  const payload = JSON.parse(readFileSync(file, "utf8")) as DetachPayload;
  rmSync(file, { force: true });
  const signals = deps.signals ?? process;
  const controller = new AbortController();
  let cancelled = false;
  const onTerm = () => {
    cancelled = true;
    controller.abort();
  };
  const ignore = () => {};
  signals.on("SIGHUP", ignore);
  signals.on("SIGTERM", onTerm);
  signals.on("SIGINT", onTerm);
  const runner = await deps.build(payload);
  const beat = () => runner.store.updateRun(runId, {}).catch(() => {});
  await runner.store.updateRun(runId, { pid: process.pid });
  const timer = setInterval(beat, deps.heartbeatMs ?? SUPERVISOR_HEARTBEAT_MS);
  try {
    const opts: ExecuteOptions = {
      repoPath: payload.repoPath,
      runId,
      recorded: true,
      signal: controller.signal,
      signals: null,
      ...(payload.sessionModel ? { sessionModel: payload.sessionModel } : {}),
      ...(payload.handoff?.mcpServers.length ? { mcpServers: payload.handoff.mcpServers } : {}),
      ...withWeb(payload.handoff),
      ...(payload.handoff ? { agent: payload.handoff.agent } : {}),
    };
    let result = await executeTask(runner, payload.task, opts);
    if (cancelled && result.outcome !== "success") {
      result = { ...result, ...failedRun(CANCELLED) };
      await runner.store.updateRun(runId, { status: result.status, result });
    }
    try {
      deps.onFinished?.(payload, result);
    } catch {
      // best effort: the result is recorded either way
    }
    return result;
  } finally {
    clearInterval(timer);
    signals.off("SIGHUP", ignore);
    signals.off("SIGTERM", onTerm);
    signals.off("SIGINT", onTerm);
    runner.close();
  }
}
