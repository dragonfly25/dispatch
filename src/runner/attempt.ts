/**
 * One delegation attempt on one target (plan §2 "Runner"): quota re-check → lease → worktree →
 * probe → child env → invocation → spawn (events streamed to the store and the run log) →
 * finalize → quota bookkeeping → patch → cleanup (lease released, worktree disposed unless kept).
 */
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserRun, BuildInvocationWithBrowser } from "../browser/index.js";
import type {
  AdapterOutcome,
  AdapterRunContext,
  Autonomy,
  DecisionTarget,
  Task,
} from "../core/contracts.js";
import type { McpServer } from "../mcp/resolve.js";
import { ingestClaudeObservations } from "../quota/readers/claude-passive.js";
import { cacheDirFor, type SandboxNetwork } from "../sandbox/network.js";
import { buildPatch, type PatchResult } from "../sandbox/patch.js";
import type { WorktreeHandle } from "../sandbox/worktree.js";
import type { WebAccess } from "../web/index.js";
import { prepareBrowserDirs } from "./browser.js";
import { buildChildEnv } from "./env.js";
import { acquireLease, holdLease } from "./lease.js";
import type { ProbeCache } from "./lifecycle.js";
import { mcpVariables } from "./mcp.js";
import type { RunnerDeps } from "./orchestrate.js";
import type { RunLog } from "./runlog.js";

/** Everything the attempts of one run share. */
export interface RunContext {
  deps: RunnerDeps;
  probes: ProbeCache;
  task: Task;
  runId: string;
  runDir: string;
  log: RunLog;
  /** Directory the task was submitted from. */
  repoPath: string;
  /** Canonical root of the main repository (the submitted directory when it is not a git repo). */
  repoRoot: string;
  dispatchHome: string;
  /** Current nesting depth (the child gets depth + 1). */
  depth: number;
  /** Globs pinned to the host; the patch filter drops them (UC5). */
  pins: string[];
  /** Env values withheld from children; every log write and the summary are scrubbed of them. */
  secrets: string[];
  signal: AbortSignal;
  leaseWaitMs: number;
  /** MCP servers forwarded to the child (already re-resolved; routing only picked capable hosts). */
  mcpServers?: readonly McpServer[];
  /** Web access given to the child (routing only picked instances that can give it). */
  web?: WebAccess;
  /** True when worktree attempts get the sandbox network (`network:` config, see decideNetwork). */
  network?: boolean;
  /** The isolated browser given to worktree attempts (routing only picked capable instances). */
  browser?: BrowserRun;
}

/**
 * Creates the package-cache directory of a network-enabled worktree attempt (0700, canonical
 * path, under the child's TMPDIR, which both sandboxes may write).
 */
async function networkFor(
  rc: RunContext,
  autonomy: Autonomy,
  tmp: string,
  index: number,
): Promise<SandboxNetwork | undefined> {
  if (rc.network !== true || autonomy !== "worktree") return undefined;
  const dir = cacheDirFor(await realpath(tmp), rc.runId, index + 1);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  return { cacheDir: dir };
}

/** What one attempt produced. `outcome` is null when the target was skipped before spawning. */
export interface AttemptReport {
  target: DecisionTarget;
  /** Adapter id of the target's instance (null when the instance is unknown). */
  adapterId: string | null;
  outcome: AdapterOutcome | null;
  patch: PatchResult | null;
  /** True when this attempt's result is final (no further fallback). */
  final: boolean;
  /** One-line explanation used in the run log and the returned-to-host reason. */
  note: string;
}

/**
 * Withheld env values worth masking. Absolute paths (`DISPATCH_HOME`, `PWD`, `TEMP`, `APPDATA`, ...)
 * and plain numbers are not secrets, and masking them would corrupt the patch and log paths stored
 * with the run. Paths are recognized in POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) and UNC
 * (`\\\\server\\share`) form whatever the host platform.
 */
export function isSecretLike(value: string): boolean {
  const absolute =
    value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
  return !absolute && !/^\d+$/.test(value);
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function failed(message: string): AdapterOutcome {
  return { outcome: "failed", summary: "", nativeError: message, deniedActions: [], durationMs: 0 };
}

/**
 * Read-only tasks legitimately produce text only. agy maps `SUCCESS` with denied actions to
 * `failed` (it cannot tell a denied write from a useful one); when the task was read-only and the
 * agent still answered, the runner reports `success` and keeps the denials in the log.
 */
export function readOnlyOverride(outcome: AdapterOutcome, autonomy: Autonomy): AdapterOutcome {
  const deniedOnly =
    outcome.outcome === "failed" &&
    outcome.deniedActions.length > 0 &&
    (outcome.nativeError ?? "").startsWith("denied:");
  if (autonomy !== "read-only" || !deniedOnly || outcome.summary.trim() === "") return outcome;
  const { nativeError: _dropped, ...rest } = outcome;
  return { ...rest, outcome: "success" };
}

/** Decides whether an attempt ends the run (see {@link AttemptReport.final}). */
function classify(
  outcome: AdapterOutcome,
  patch: PatchResult | null,
): Pick<AttemptReport, "final" | "outcome"> {
  if (outcome.outcome === "success" && patch?.conflict !== undefined) {
    // UC13: the work does not apply to the current tree; return it with the conflict attached.
    const summary = `${outcome.summary}\n\npatch does not apply: ${patch.conflict}`.trim();
    return {
      final: true,
      outcome: { ...outcome, outcome: "failed", summary, nativeError: "patch does not apply" },
    };
  }
  if (outcome.outcome === "success") return { final: true, outcome };
  // A timeout that left work behind returns the partial patch (UC13); otherwise fall through.
  if (outcome.outcome === "timeout" && patch && !patch.empty) return { final: true, outcome };
  return { final: false, outcome };
}

/** Runs `target` (attempt number `index`, 0-based). Never throws: failures become the report. */
export async function runAttempt(
  rc: RunContext,
  target: DecisionTarget,
  index: number,
  isLast: boolean,
): Promise<AttemptReport> {
  const { deps, task, runId } = rc;
  const exec = deps.config.execution;
  const instance = exec.instances.find((i) => i.id === target.instance);
  const skip = (note: string, adapterId: string | null = null): AttemptReport => ({
    target,
    adapterId,
    outcome: null,
    patch: null,
    final: false,
    note,
  });
  if (!instance) return skip("unknown instance");
  const adapter = deps.adapters[instance.adapter];
  if (!adapter) return skip(`no adapter "${instance.adapter}"`, instance.adapter);

  // A previous attempt (or another run) may have exhausted this instance since the decision.
  const exhausted = deps.store
    .activeQuotaSignals(deps.clock.now())
    .find((s) => s.instanceId === instance.id);
  if (exhausted) return skip(`unavailable until ${exhausted.until}`, instance.adapter);

  const leased = await acquireLease(deps.store, instance.id, runId, {
    limit: instance.concurrency,
    clock: deps.clock,
    waitMs: isLast ? rc.leaseWaitMs : 0,
    signal: rc.signal,
  });
  if (!leased) return skip("concurrency limit reached", instance.adapter);
  const release = holdLease(deps.store, runId, deps.clock);

  let wt: WorktreeHandle | undefined;
  let network: SandboxNetwork | undefined;
  try {
    wt = await deps.sandbox.create({
      repoPath: rc.repoPath,
      runId: index === 0 ? runId : `${runId}-${index + 1}`,
      autonomy: task.autonomy,
      dispatchHome: rc.dispatchHome,
      bootstrap: { mode: exec.worktree.bootstrap, paths: exec.worktree.symlinkPaths },
    });
    // `direct` is not implemented in v0.1: it runs in a worktree like `worktree`.
    const autonomy: Autonomy = wt.readOnlyReason
      ? "read-only"
      : task.autonomy === "direct"
        ? "worktree"
        : task.autonomy;
    const attemptDir = join(rc.runDir, `attempt-${index + 1}`);
    await mkdir(attemptDir, { recursive: true, mode: 0o700 });
    const probe = await rc.probes.get(adapter, instance, {
      spawner: deps.spawner,
      clock: deps.clock,
      resolveBinary: deps.resolveBinary,
    });
    const mcpServers = rc.mcpServers ?? [];
    // Variables the forwarded servers reference reach the child by name (the user consented at
    // setup), even API-key-like names the deny-list would drop; their values are still redacted.
    const mcpVars = mcpVariables(mcpServers, deps.env);
    const child = buildChildEnv({
      parentEnv: deps.env,
      passthrough: instance.envPassthrough,
      extra: {},
      depth: rc.depth,
      runId,
      dangerouslyAllow: mcpVars.names,
    });
    const withheld = [...child.secrets, ...mcpVars.values].filter(isSecretLike);
    rc.secrets.push(...withheld);
    deps.addSecrets?.(withheld);
    const worktree = await realpath(wt.path);
    network = await networkFor(rc, autonomy, child.env.TMPDIR ?? tmpdir(), index);
    // The browser serves dev servers started from the agent's shell: worktree attempts only.
    const browser = rc.browser !== undefined && autonomy === "worktree" ? rc.browser : undefined;
    if (browser) await prepareBrowserDirs(attemptDir);
    const args: BuildInvocationWithBrowser = {
      task,
      target,
      autonomy,
      worktree,
      repoRoot: rc.repoRoot,
      runDir: attemptDir,
      instance,
      probe,
      baseEnv: child.env,
      mcpServers,
      ...(rc.web === undefined ? {} : { web: rc.web }),
      ...(network === undefined ? {} : { network }),
      ...(browser === undefined ? {} : { browser }),
    };
    const inv = adapter.buildInvocation(args);
    rc.log.write({
      type: "attempt.start",
      attempt: index + 1,
      target,
      autonomy,
      worktree,
      ...(network === undefined ? {} : { network: true }),
      ...(browser === undefined ? {} : { browser: true }),
    });

    const ctx: AdapterRunContext = {
      runId,
      worktree,
      scratch: { instanceId: instance.id, clock: deps.clock, now: () => deps.clock.now() },
    };
    const writes: Promise<void>[] = [];
    const started = deps.clock.monotonicMs();
    const res = await deps.spawner.spawn({
      binary: inv.binary,
      argv: inv.argv,
      env: inv.env,
      cwd: inv.cwd,
      ...(inv.stdin !== null ? { stdin: inv.stdin } : {}),
      timeoutMs: task.timeoutMs,
      signal: rc.signal,
      onLine: (stream, line) => {
        for (const ev of adapter.parseLine(stream, line, ctx)) {
          rc.log.write({ type: "event", attempt: index + 1, ...ev });
          writes.push(deps.store.appendEvent(runId, ev).catch(() => {}));
        }
      },
    });
    const durationMs = deps.clock.monotonicMs() - started;
    await Promise.all(writes);
    ctx.scratch.endedAt = deps.clock.now().toISOString();
    if (inv.outputFile) {
      const text = await readFile(inv.outputFile, "utf8").catch(() => undefined);
      if (text !== undefined) ctx.scratch.outputFileContent = text;
      // The child wrote it unredacted; its text lives on only in the redacted result (AC7).
      await rm(inv.outputFile, { force: true }).catch(() => {});
    }
    let outcome = readOnlyOverride(adapter.finalize({ ...res, durationMs }, ctx), autonomy);
    if (rc.signal.aborted && !res.timedOut) {
      outcome = { ...outcome, outcome: "failed", nativeError: "interrupted" };
    }

    await ingestClaudeObservations(deps.quota, ctx.scratch.quotaObservations);
    if (outcome.outcome === "quota_exhausted") {
      await deps.quota
        .recordObservation({
          instanceId: instance.id,
          at: deps.clock.now().toISOString(),
          exhausted: {
            resetAt: outcome.resetAt ?? null,
            ...(outcome.nativeError ? { error: outcome.nativeError } : {}),
          },
        })
        .catch(() => {});
    }

    let patch: PatchResult | null = null;
    if (
      autonomy !== "read-only" &&
      (outcome.outcome === "success" || outcome.outcome === "timeout")
    ) {
      patch = await buildPatch({
        worktree: wt,
        repoPath: rc.repoPath,
        runDir: rc.runDir,
        policy: { pins: rc.pins },
      });
    }
    const verdict = classify(outcome, patch);
    const final = verdict.outcome as AdapterOutcome;
    rc.log.write({
      type: "attempt.end",
      attempt: index + 1,
      instance: instance.id,
      outcome: final.outcome,
      nativeError: final.nativeError,
      deniedActions: final.deniedActions,
      durationMs: final.durationMs,
      patch: patch?.patch ?? null,
    });
    return {
      target,
      adapterId: instance.adapter,
      outcome: final,
      patch,
      final: verdict.final,
      note: final.outcome + (final.nativeError ? ` (${final.nativeError})` : ""),
    };
  } catch (err) {
    const outcome = failed(errText(err));
    rc.log.write({
      type: "attempt.error",
      attempt: index + 1,
      instance: instance.id,
      error: errText(err),
    });
    return {
      target,
      adapterId: instance.adapter,
      outcome,
      patch: null,
      final: false,
      note: `failed (${errText(err)})`,
    };
  } finally {
    release();
    if (network) await rm(network.cacheDir, { recursive: true, force: true }).catch(() => {});
    if (wt) await deps.sandbox.dispose(wt.path, exec.worktree.keep).catch(() => {});
  }
}
