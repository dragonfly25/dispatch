/** WP23 runner multi, in process: fanout (UC7), wait/cancel logic, idempotency keys, exit codes. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAppContext } from "../../src/app/context.js";
import { runnerDeps } from "../../src/app/runner.js";
import { renderRunResult } from "../../src/cli/commands/run.js";
import { renderRun } from "../../src/cli/commands/runs.js";
import type { ExecutionConfig } from "../../src/config/load.js";
import { systemClock } from "../../src/core/clock.js";
import {
  ExitCode,
  type ProbeResult,
  type RunResult,
  RunResultSchema,
  type Task,
} from "../../src/core/contracts.js";
import { DispatchError } from "../../src/core/errors.js";
import type { RoutingConfig, Rule } from "../../src/core/routing.js";
import { CANCELLED, idempotencyKey } from "../../src/runner/detach.js";
import { fanoutChildId } from "../../src/runner/fanout.js";
import { SELF_PID_START } from "../../src/runner/lease.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { executeTask } from "../../src/runner/orchestrate.js";
import { exitCodeForResult } from "../../src/runner/result.js";
import {
  cancelRun,
  defaultWaitSeconds,
  findRunDir,
  SUPERVISOR_LOST,
  supervisorAlive,
  type WaitDeps,
  waitForRun,
} from "../../src/runner/wait.js";
import { SqliteStateStore } from "../../src/state/store.js";
import { probeResult } from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  snapshotTree,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";
import { makeConfig } from "./router/fixtures.js";

const instance = (id: string, adapter: string) => ({
  id,
  adapter,
  pool: "subscription" as const,
  enabled: true,
  maxAutonomy: "worktree" as const,
  concurrency: 1,
  envPassthrough: [] as string[],
});

const execution = (): ExecutionConfig => ({
  autonomy: "worktree",
  instances: [instance("claude", "claude"), instance("codex", "codex")],
  concurrency: { perProvider: 1, total: 4 },
  maxDepth: 1,
  network: "off",
  worktree: { bootstrap: "none", symlinkPaths: [], keep: false },
  timeouts: { defaultTaskMs: 60_000 },
  quota: { cacheMinutes: 5, readers: {} },
});

function routing(action: Rule["action"]): RoutingConfig {
  const base = makeConfig();
  return makeConfig({
    instances: base.instances.filter((i) => i.id === "claude" || i.id === "codex"),
    activeProfile: "test",
    profiles: { ...base.profiles, test: { rules: [{ id: "r", match: {}, action }] } },
  });
}

const FANOUT: Rule["action"] = { type: "fanout", instances: ["claude", "codex"] };

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  prompt: "add sub to math.js",
  paths: ["math.js"],
  autonomy: "worktree",
  timeoutMs: 20_000,
  ...over,
});

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = undefined;
});

function setup(scenarios: FakeScenarioMap, leaseWaitMs = 0) {
  fakes = createFakes(scenarios);
  home = tempHome();
  repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
  const probes = new ProbeCache();
  const probe = (cli: string): ProbeResult => ({
    ...probeResult,
    binaryPath: join(fakes?.binDir ?? "", cli),
    flags: ["--safe-mode"],
    features: ["hooks", "plugins", "apps", "memories"],
  });
  probes.set("claude", "claude", probe("claude"));
  probes.set("codex", "codex", probe("codex"));
  const ctx = loadAppContext({ cwd: repo.dir, env: { ...fakes.env, ...home.env } });
  ctx.config = { ...ctx.config, routing: routing(FANOUT), execution: execution() };
  const deps = runnerDeps(ctx, { probes });
  closers.push(() => ctx.close());
  const store = deps.store as SqliteStateStore;
  const run = () =>
    executeTask(deps, task(), { repoPath: repo?.dir ?? "", signals: null, leaseWaitMs });
  return { deps, store, run, repo, fakes };
}

describe("[UC7] fanout (second opinion)", () => {
  it("[UC7] runs both providers concurrently in separate worktrees and returns both results", async () => {
    const { run, repo, fakes, store } = setup({
      claude: [{ scenario: "success_edit", file: "a.txt", content: "from claude\n" }],
      codex: [{ scenario: "success_edit", file: "b.txt", content: "from codex\n" }],
    });
    const before = snapshotTree(repo.dir);
    const r = await run();
    expect(RunResultSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ status: "completed", outcome: "success", patch: null });
    expect(r.results).toHaveLength(2);
    const [a, b] = r.results as RunResult[];
    expect(a?.runId).toBe(fanoutChildId(r.runId, 0));
    expect(a?.externalAgent).toMatchObject({ instance: "claude", marker: "EXTERNAL_AGENT_OUTPUT" });
    expect(b?.externalAgent).toMatchObject({ instance: "codex", marker: "EXTERNAL_AGENT_OUTPUT" });
    expect(readFileSync(a?.patch?.path ?? "", "utf8")).toContain("+from claude");
    expect(readFileSync(b?.patch?.path ?? "", "utf8")).toContain("+from codex");
    expect(a?.patch?.path).not.toBe(b?.patch?.path);
    // Two different worktrees, neither the working copy, which is untouched.
    const cwds = fakes.readLog({ kind: "run" }).map((e) => e.cwd);
    expect(new Set(cwds).size).toBe(2);
    expect(cwds).not.toContain(repo.dir);
    expect(snapshotTree(repo.dir)).toEqual(before);
    expect(r.summary).toContain("nothing merged");
    // Children are runs of their own; every lease is released.
    expect((await store.getRun(b?.runId ?? ""))?.result?.outcome).toBe("success");
    expect(store.listLeases()).toEqual([]);
    expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("[UC7] the two agents overlap in time", async () => {
    const slow = { scenario: "slow" as const, delayMs: 150 };
    const { run, fakes } = setup({ claude: [slow], codex: [slow] });
    const r = await run();
    expect(r.results?.map((c) => c.outcome)).toEqual(["success", "success"]);
    const [x, y] = fakes.readLog({ kind: "run" });
    expect(x?.startedAt && y?.endedAt && x.startedAt < y.endedAt).toBe(true);
    expect(y?.startedAt && x?.endedAt && y.startedAt < x.endedAt).toBe(true);
  });

  it("[UC7] one success is enough; all failures return the task to the host with both results", async () => {
    const mixed = setup({
      claude: [{ scenario: "quota_exhausted" }],
      codex: [{ scenario: "success_edit", file: "b.txt", content: "x\n" }],
    });
    const r = await mixed.run();
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    expect(r.results?.map((c) => c.outcome)).toEqual(["quota_exhausted", "success"]);
    for (const c of closers.splice(0)) c();
    fakes?.dispose();
    home?.cleanup();
    repo?.cleanup();

    const bad = setup({ claude: [{ scenario: "fail" }], codex: [{ scenario: "fail" }] });
    const r2 = await bad.run();
    expect(r2).toMatchObject({ status: "returned_to_host", outcome: "failed" });
    expect(r2.summary).toMatch(/no fanout target succeeded: claude: failed; codex: failed/);
    expect(r2.results).toHaveLength(2);
  });

  it("[UC7] respects per-instance concurrency: a full instance is skipped, the other runs", async () => {
    const { run, store } = setup({
      claude: [{ scenario: "success_edit", file: "a.txt", content: "a\n" }],
      codex: [{ scenario: "success_edit", file: "b.txt", content: "b\n" }],
    });
    const busy = store.acquireLease("codex", "other-run", {
      pid: process.pid,
      pidStart: SELF_PID_START,
      limit: 1,
      now: new Date(),
      isAlive: () => true,
    });
    expect(busy).toBe(true);
    const r = await run();
    expect(r.outcome).toBe("success");
    const codex = r.results?.[1];
    expect(codex).toMatchObject({ status: "returned_to_host", outcome: null, externalAgent: null });
    expect(codex?.summary).toContain("concurrency limit reached");
    expect(store.listLeases().map((l) => l.runId)).toEqual(["other-run"]);
  });
});

// ---------------------------------------------------------------- wait / cancel

const NOW = "2026-11-07T10:00:00.000Z";

function storeAt(clock = new FakeClock(NOW)) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-wait-")));
  const store = SqliteStateStore.open(join(dir, "dispatch.db"), { clock });
  closers.push(() => store.close());
  return { dir, store, clock };
}

const done = (runId: string, over: Partial<RunResult> = {}): RunResult => ({
  schemaVersion: 1,
  runId,
  status: "completed",
  outcome: "success",
  externalAgent: null,
  summary: "ok",
  patch: null,
  log: { path: "/x/events.jsonl" },
  decisions: [],
  durationMs: 1,
  ...over,
});

async function running(store: SqliteStateStore, runId: string, pid: number | null = 42) {
  await store.recordRun({
    runId,
    status: "running",
    createdAt: NOW,
    updatedAt: NOW,
    instance: null,
    pid,
    result: null,
  });
}

describe("wait", () => {
  it("[UC3] returns a finished run with its mapped exit code", async () => {
    const { store, clock } = storeAt();
    await running(store, "r1");
    await store.updateRun("r1", { status: "completed", result: done("r1", { outcome: "failed" }) });
    const w = await waitForRun({ store, clock }, "r1", 0);
    expect(w.exitCode).toBe(ExitCode.FAILED);
    expect(w.result.status).toBe("completed");
  });

  it("[UC3] exits 75 with progress while running; concurrent waits all see the result", async () => {
    const { store } = storeAt(new FakeClock(new Date().toISOString()));
    const deps: WaitDeps = { store, clock: systemClock, isAlive: () => true, pollMs: 10 };
    await store.recordRun({
      runId: "r2",
      status: "running",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      instance: null,
      pid: 1,
      result: null,
    });
    await store.appendEvent("r2", { kind: "editing", ts: NOW, path: "a.ts" });
    const early = await waitForRun(deps, "r2", 0);
    expect(early.exitCode).toBe(ExitCode.STILL_RUNNING);
    expect(early.result).toMatchObject({ status: "running", runId: "r2", outcome: null });
    expect("progress" in early.result && early.result.progress[0]?.kind).toBe("editing");
    const waits = [1, 2, 3].map(() => waitForRun(deps, "r2", 10_000));
    setTimeout(() => {
      void store.updateRun("r2", { status: "completed", result: done("r2") });
    }, 50);
    const all = await Promise.all(waits);
    expect(all.map((w) => w.exitCode)).toEqual([0, 0, 0]);
  });

  it("marks a stale run whose supervisor is gone as supervisor_lost (exit 4)", async () => {
    const { store, clock, dir } = storeAt();
    await running(store, "r3");
    const deps: WaitDeps = { store, clock, isAlive: () => true, runDir: () => dir };
    clock.advance(31_000);
    expect((await waitForRun(deps, "r3", 0)).exitCode).toBe(ExitCode.STILL_RUNNING);
    const lost = await waitForRun({ ...deps, isAlive: () => false }, "r3", 0);
    expect(lost.exitCode).toBe(ExitCode.FAILED);
    expect(lost.result).toMatchObject({ status: "completed", outcome: "failed" });
    expect((lost.result as RunResult).summary).toContain(SUPERVISOR_LOST);
    expect((lost.result as RunResult).log.path).toBe(join(dir, "events.jsonl"));
    expect((await store.getRun("r3"))?.result?.summary).toContain(SUPERVISOR_LOST);
  });

  it("rejects an unknown run id with a usage error", async () => {
    const { store, clock } = storeAt();
    await expect(waitForRun({ store, clock }, "nope", 0)).rejects.toMatchObject({
      exitCode: ExitCode.USAGE,
    });
    await expect(cancelRun({ store, clock }, "nope")).rejects.toBeInstanceOf(DispatchError);
  });
});

describe("cancel", () => {
  it("returns a finished run unchanged and ends a run whose supervisor is gone", async () => {
    const { store, clock } = storeAt();
    await running(store, "c1");
    await store.updateRun("c1", { status: "completed", result: done("c1") });
    expect((await cancelRun({ store, clock }, "c1")).outcome).toBe("success");
    await running(store, "c2", null);
    const r = await cancelRun({ store, clock }, "c2");
    expect(r).toMatchObject({ status: "completed", outcome: "failed", summary: CANCELLED });
  });

  it("sends SIGTERM, then SIGKILL after the grace period, and records the cancel", async () => {
    const { store } = storeAt();
    await running(store, "c3", 4242);
    const sent: string[] = [];
    let alive = true;
    const deps: WaitDeps = { store, clock: systemClock, isAlive: () => alive, pollMs: 5 };
    const r = await cancelRun(deps, "c3", {
      graceMs: 30,
      kill: (pid, sig) => {
        sent.push(`${pid}:${sig}`);
        if (sig === "SIGKILL") alive = false;
      },
    });
    expect(sent).toEqual(["4242:SIGTERM", "4242:SIGKILL"]);
    expect(r.summary).toBe(CANCELLED);
  });

  it("returns the supervisor's own result when it finishes after SIGTERM", async () => {
    const { store } = storeAt();
    await running(store, "c4", 4343);
    const deps: WaitDeps = { store, clock: systemClock, isAlive: () => true, pollMs: 5 };
    const r = await cancelRun(deps, "c4", {
      kill: () => {
        void store.updateRun("c4", {
          status: "completed",
          result: done("c4", { outcome: "failed", summary: "cancelled by supervisor" }),
        });
      },
    });
    expect(r.summary).toBe("cancelled by supervisor");
  });
});

describe("runner multi helpers", () => {
  it("[UC7] renders a fanout result with each child's agent and patch", () => {
    const patch = {
      path: "/r/patch.diff",
      diffstat: "",
      applies: false,
      rejectedPaths: [],
      needsReview: false,
    };
    const agent = (instance: string) => ({
      provider: instance,
      instance,
      model: "m",
      marker: "EXTERNAL_AGENT_OUTPUT" as const,
    });
    const parsedParent = done("p", {
      externalAgent: agent("codex"),
      patch,
      results: [
        done("p-f1", { externalAgent: agent("claude"), patch }),
        done("p-f2", { outcome: null, status: "returned_to_host" }),
      ],
    });
    const text = renderRun(
      done("p", {
        externalAgent: agent("codex"),
        patch,
        results: [
          done("p-f1", { externalAgent: agent("claude"), patch }),
          done("p-f2", { outcome: null, status: "returned_to_host" }),
        ],
      }),
    );
    // The same printer as `run`, with each fanout child indented under the parent.
    expect(text).toBe(renderRunResult(JSON.parse(JSON.stringify(parsedParent))));
    expect(text).toContain("Provider: codex (instance codex), model m");
    expect(text).toContain("  | Run p-f1: completed (success)");
    expect(text).toContain("  | Provider: claude (instance claude), model m");
    expect(text).toContain("  | Run p-f2: returned_to_host");
    const progress = renderRun({
      schemaVersion: 1,
      runId: "p",
      status: "running",
      outcome: null,
      progress: [
        { kind: "editing", ts: NOW, detail: "a.ts" },
        { kind: "thinking", ts: NOW },
      ],
    });
    expect(progress).toContain(`${NOW} editing a.ts`);
  });

  it("maps results to exit codes", () => {
    const code = (status: RunResult["status"], outcome: RunResult["outcome"]) =>
      exitCodeForResult({ status, outcome });
    expect(code("running", null)).toBe(75);
    expect(code("rejected", "rejected")).toBe(3);
    expect(code("returned_to_host", "failed")).toBe(0);
    expect(code("completed", "success")).toBe(0);
    expect(code("completed", "rejected")).toBe(3);
    expect(code("completed", "quota_exhausted")).toBe(5);
    expect(code("completed", "timeout")).toBe(6);
    expect(code("completed", "failed")).toBe(4);
  });

  it("has per-host wait defaults (Claude 100 s, Codex 280 s, none outside a host)", () => {
    expect(defaultWaitSeconds("claude-code")).toBe(100);
    expect(defaultWaitSeconds("codex")).toBe(280);
    expect(defaultWaitSeconds("antigravity")).toBe(100);
    expect(defaultWaitSeconds(null)).toBeNull();
  });

  it("[SEC-R4] idempotency keys: explicit wins, else session + canonical task without its id", () => {
    const host = { host: "codex" as const, sessionId: "s1", depth: 0, evidence: [] };
    expect(idempotencyKey(task(), host, "k")).toBe("key:k");
    const a = idempotencyKey(task({ id: "x" }), host);
    expect(a).toMatch(/^auto:[0-9a-f]{64}$/);
    expect(idempotencyKey(task({ id: "y" }), host)).toBe(a);
    expect(idempotencyKey(task({ prompt: "other" }), host)).not.toBe(a);
    expect(idempotencyKey(task(), { ...host, sessionId: "s2" })).not.toBe(a);
    expect(idempotencyKey(task(), { host: null, depth: 0, evidence: [] })).toBeNull();
  });

  it("judges supervisor liveness by pid, start time and zombie state", () => {
    const now = new Date().toISOString();
    expect(supervisorAlive(null, now)).toBe(false);
    expect(supervisorAlive(process.pid, new Date(Date.now() - 3_600_000).toISOString())).toBe(
      false,
    );
    // This process started before `now`, within the start window of a run created at its start.
    const startedAt = new Date(Number(SELF_PID_START)).toISOString();
    expect(supervisorAlive(process.pid, startedAt)).toBe(true);
    expect(supervisorAlive(2 ** 22 + 12_345, now)).toBe(false);
  });

  it("finds a run directory in the repo first, then under the Dispatch home", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "dispatch-find-")));
    const home2 = join(root, "home");
    expect(findRunDir(root, home2, "r")).toBeNull();
    mkdirSync(join(home2, "runs", "r"), { recursive: true });
    expect(findRunDir(null, home2, "r")).toBe(join(home2, "runs", "r"));
    mkdirSync(join(root, ".dispatch", "state", "runs", "r"), { recursive: true });
    expect(findRunDir(root, home2, "r")).toBe(join(root, ".dispatch", "state", "runs", "r"));
  });
});
