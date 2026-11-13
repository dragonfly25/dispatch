/** WP19 runner core: end-to-end with fake CLIs, temp HOME/DISPATCH_HOME and temp git repos. */
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { disabledReaders, loadAppContext } from "../../src/app/context.js";
import { runnerDeps } from "../../src/app/runner.js";
import { renderRunResult } from "../../src/cli/commands/run.js";
import type { ExecutionConfig } from "../../src/config/load.js";
import type {
  ProbeResult,
  RunResult,
  Spawner,
  SpawnRequest,
  Task,
} from "../../src/core/contracts.js";
import { RunResultSchema } from "../../src/core/contracts.js";
import type { RoutingConfig, Rule } from "../../src/core/routing.js";
import { isSecretLike, readOnlyOverride } from "../../src/runner/attempt.js";
import { acquireLease, isProcessAlive, SELF_PID_START } from "../../src/runner/lease.js";
import { ProbeCache, trapTermination } from "../../src/runner/lifecycle.js";
import {
  executeTask,
  MAX_SUMMARY_CHARS,
  type RunnerDeps,
  type RunResultWithNetwork,
  reportedPatch,
} from "../../src/runner/orchestrate.js";
import { ProcessSpawner } from "../../src/runner/proc.js";
import type { SqliteStateStore } from "../../src/state/store.js";
import { probeResult } from "../fixtures/contracts.js";
import {
  createFakes,
  FAKE_LEAKS,
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

function execution(over: Partial<ExecutionConfig> = {}): ExecutionConfig {
  return {
    autonomy: "worktree",
    instances: [instance("claude", "claude"), instance("codex", "codex")],
    concurrency: { perProvider: 1, total: 4 },
    maxDepth: 1,
    network: "off",
    worktree: { bootstrap: "none", symlinkPaths: [], keep: false },
    timeouts: { defaultTaskMs: 60_000 },
    quota: { cacheMinutes: 5, readers: {} },
    ...over,
  };
}

function routing(rule: Rule["action"], over: Partial<RoutingConfig> = {}): RoutingConfig {
  const base = makeConfig();
  return makeConfig({
    instances: base.instances.filter((i) => i.id === "claude" || i.id === "codex"),
    activeProfile: "test",
    profiles: { ...base.profiles, test: { rules: [{ id: "r", match: {}, action: rule }] } },
    ...over,
  });
}

const task = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  prompt: "add sub to math.js",
  paths: ["math.js"],
  autonomy: "worktree",
  timeoutMs: 20_000,
  ...over,
});

const FALLBACK: Rule["action"] = {
  type: "fallback",
  instances: ["claude", "codex"],
  strategy: "ordered",
};
const CODEX: Rule["action"] = { type: "provider", instance: "codex" };

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

interface SetupOptions {
  scenarios?: FakeScenarioMap;
  action?: Rule["action"];
  exec?: Partial<ExecutionConfig>;
  routing?: Partial<RoutingConfig>;
  env?: Record<string, string>;
  overrides?: Partial<RunnerDeps>;
}

function setup(o: SetupOptions = {}) {
  fakes = createFakes(o.scenarios ?? {});
  home = tempHome();
  repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
  const env = { ...fakes.env, ...home.env, ...o.env };
  const probes = new ProbeCache();
  const probe = (cli: string): ProbeResult => ({
    ...probeResult,
    binaryPath: join(fakes?.binDir ?? "", cli),
    flags: ["--safe-mode"],
    features: ["hooks", "plugins", "apps", "memories"],
  });
  probes.set("claude", "claude", probe("claude"));
  probes.set("codex", "codex", probe("codex"));
  const ctx = loadAppContext({ cwd: repo.dir, env });
  ctx.config = {
    ...ctx.config,
    routing: routing(o.action ?? CODEX, o.routing),
    execution: execution(o.exec),
  };
  const deps = runnerDeps(ctx, { probes, ...o.overrides });
  closers.push(() => ctx.close());
  const run = (t: Partial<Task> = {}) =>
    executeTask(deps, task(t), { repoPath: repo?.dir ?? "", signals: null, leaseWaitMs: 0 });
  return { deps, env, run, repo, home, fakes };
}

const valid = (r: RunResult) => expect(RunResultSchema.safeParse(r).success).toBe(true);

describe("executeTask", () => {
  it("[UC10] runs without a host: valid RunResult, patch applies, working copy untouched", async () => {
    const { run, repo, deps, fakes, home } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "changed\n" }] },
    });
    const before = snapshotTree(repo.dir);
    const r = await run();
    valid(r);
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    expect(r.externalAgent).toMatchObject({
      provider: "codex",
      instance: "codex",
      marker: "EXTERNAL_AGENT_OUTPUT",
    });
    expect(r.summary).toContain("sub(a, b)");
    expect(r.patch?.applies).toBe(true);
    expect(readFileSync(r.patch?.path ?? "", "utf8")).toContain("+changed");
    expect(r.patch?.path.startsWith(join(home.dispatchHome, "runs", r.runId))).toBe(true);
    expect(snapshotTree(repo.dir)).toEqual(before);
    expect(r.decisions).toHaveLength(1);
    expect(r.decisions[0]?.action).toBe("delegate");
    // The host self is none; the store holds the run, decision and events; worktree is gone.
    const store = deps.store as SqliteStateStore;
    const stored = await store.getRun(r.runId);
    expect(stored?.status).toBe("completed");
    expect(stored?.result?.patch?.path).toBe(r.patch?.path);
    expect((await store.listDecisions("2000-01-01T00:00:00.000Z"))[0]?.input.host.self).toBeNull();
    expect(store.listEvents(r.runId).length).toBeGreaterThan(0);
    expect(store.listLeases()).toEqual([]);
    expect(existsSync(join(home.dispatchHome, "worktrees"))).toBe(true);
    expect(repo.git("worktree", "list").split("\n")).toHaveLength(1);
    const log = readFileSync(r.log.path, "utf8");
    expect(log).toContain('"type":"attempt.end"');
    expect(fakes.readLog({ cli: "codex", kind: "run" })[0]?.cwd).not.toBe(repo.dir);
  });

  it("[UC10] puts the run dir inside the repo when .dispatch/ exists", async () => {
    const { run, repo } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "n.txt", content: "x\n" }] },
    });
    mkdirSync(join(repo.dir, ".dispatch"));
    const r = await run();
    expect(r.patch?.path).toBe(join(repo.dir, ".dispatch", "state", "runs", r.runId, "patch.diff"));
  });

  it("[UC4] quota_exhausted on the first target falls back, then returns to host with reasons", async () => {
    const { run, deps } = setup({
      action: FALLBACK,
      scenarios: {
        claude: [{ scenario: "quota_exhausted" }],
        codex: [{ scenario: "quota_exhausted" }],
      },
    });
    const r = await run();
    valid(r);
    expect(r.status).toBe("returned_to_host");
    expect(r.outcome).toBe("quota_exhausted");
    expect(r.externalAgent).toBeNull();
    expect(r.summary).toMatch(/claude: quota_exhausted.*codex: quota_exhausted/);
    const signals = (deps.store as SqliteStateStore).activeQuotaSignals(new Date());
    expect(signals.map((s) => s.instanceId)).toEqual(["claude", "codex"]);
    // The next run skips both without spawning: the router filters them out.
    const again = await run();
    expect(again.status).toBe("returned_to_host");
  });

  it("[UC12] the host instance is the one the composition root resolved, never invoked", async () => {
    // E.g. a session on the second Claude account: `hostSelf` names that instance, whatever the
    // adapter's default instance is called.
    const { run, fakes } = setup({
      action: FALLBACK,
      overrides: { hostSelf: "claude" },
      scenarios: { codex: [{ scenario: "success_edit", file: "a.txt", content: "a\n" }] },
    });
    const r = await run();
    expect(r.externalAgent?.instance).toBe("codex");
    expect(r.decisions[0]?.chain.find((c) => c.ruleId === "claude")?.effect).toMatch(/self/);
    expect(fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
  });

  it("[UC4] second target succeeds after the first one is exhausted", async () => {
    const { run, fakes } = setup({
      action: FALLBACK,
      scenarios: {
        claude: [{ scenario: "quota_exhausted" }],
        codex: [{ scenario: "success_edit", file: "math.js", content: "y\n" }],
      },
    });
    const r = await run();
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    expect(r.externalAgent?.instance).toBe("codex");
    expect(fakes.readLog({ kind: "run" }).map((c) => c.cli)).toEqual(["claude", "codex"]);
  });

  it("[UC4] skips a target whose quota signal appeared after the decision", async () => {
    const { run, deps, fakes } = setup({
      action: FALLBACK,
      scenarios: { codex: [{ scenario: "success_edit", file: "a.txt", content: "a\n" }] },
    });
    const store = deps.store as SqliteStateStore;
    const snapshot = deps.quota.snapshot.bind(deps.quota);
    deps.quota.snapshot = async (i) => {
      const s = await snapshot(i);
      store.recordQuotaSignal("claude", new Date(Date.now() + 3_600_000), "late");
      return s;
    };
    const r = await run();
    expect(r.externalAgent?.instance).toBe("codex");
    expect(fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
  });

  it("[UC13] a slow child hits the timeout; without work it falls back to the host", async () => {
    const { run } = setup({ scenarios: { codex: [{ scenario: "slow", delayMs: 2_000 }] } });
    const r = await run({ timeoutMs: 300 });
    expect(r).toMatchObject({ status: "returned_to_host", outcome: "timeout" });
  });

  it("[UC13] a timeout with partial work returns the partial patch", async () => {
    const spawner: Spawner = {
      async spawn(req: SpawnRequest) {
        writeFileSync(join(req.cwd, "partial.txt"), "half done\n");
        return { exitCode: null, signal: "SIGTERM", timedOut: true };
      },
    };
    const { run } = setup({ overrides: { spawner } });
    const r = await run();
    expect(r).toMatchObject({ status: "completed", outcome: "timeout" });
    expect(r.patch?.diffstat).toContain("partial.txt");
  });

  it("[UC13] a patch that no longer applies is failed with the conflict; worktree kept on request", async () => {
    const real = new ProcessSpawner();
    let repoDir = "";
    const spawner: Spawner = {
      async spawn(req) {
        const res = await real.spawn(req);
        writeFileSync(join(repoDir, "math.js"), "user edit\n");
        return res;
      },
    };
    const { run, repo, home } = setup({
      scenarios: {
        codex: [{ scenario: "success_edit", file: "math.js", content: "agent edit\n" }],
      },
      exec: { worktree: { bootstrap: "none", symlinkPaths: [], keep: true } },
      overrides: { spawner },
    });
    repoDir = repo.dir;
    const r = await run();
    expect(r).toMatchObject({ status: "completed", outcome: "failed" });
    expect(r.patch?.applies).toBe(false);
    expect(r.summary).toContain("patch does not apply");
    expect(readFileSync(join(repo.dir, "math.js"), "utf8")).toBe("user edit\n");
    expect(repo.git("worktree", "list")).toContain(home.dispatchHome);
  });

  it("[AC4] delegates with every quota reader disabled", async () => {
    const readers = { claude: { enabled: false }, codex: { enabled: false } };
    const exec = execution({ quota: { cacheMinutes: 5, readers } });
    const ctx = loadAppContext({ cwd: process.cwd(), env: tempHome().env });
    expect(disabledReaders({ ...ctx.config, execution: exec }, ctx.readers)).toEqual([
      "claude-passive",
      "claude-usage",
      "codex-app-server",
    ]);
    ctx.close();
    const { run } = setup({
      exec: { quota: { cacheMinutes: 5, readers } },
      scenarios: { codex: [{ scenario: "success_edit", file: "b.txt", content: "b\n" }] },
    });
    expect((await run()).outcome).toBe("success");
  });

  it("[UC2] rejects recursion beyond max_depth without deciding", async () => {
    const { run, fakes } = setup({ env: { DISPATCH_DEPTH: "1" } });
    const r = await run();
    valid(r);
    expect(r).toMatchObject({ status: "rejected", outcome: "rejected", decisions: [] });
    expect(r.summary).toContain("recursion");
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("returns host and reject decisions without spawning", async () => {
    const host = setup({ action: { type: "host" } });
    const r = await host.run();
    expect(r).toMatchObject({ status: "returned_to_host", outcome: null });
    expect(r.decisions[0]?.action).toBe("host");
    const rej = await executeTask(
      {
        ...host.deps,
        config: { ...host.deps.config, routing: routing({ type: "reject", reason: "nope" }) },
      },
      task(),
      { repoPath: host.repo.dir, signals: null },
    );
    expect(rej).toMatchObject({ status: "rejected", outcome: "rejected" });
    expect(host.fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("[SEC-env] the child gets only the allow-listed env plus depth and run id", async () => {
    const { run, fakes } = setup({
      env: {
        OPENAI_API_KEY: "sk-canary-openai-0001",
        MY_SECRET: "canary-value-0002",
        NODE_OPTIONS: "--x",
      },
      scenarios: { codex: [{ scenario: "leak_secret", secret: "canary-value-0002" }] },
    });
    const r = await run({ autonomy: "read-only" });
    const child = fakes.readLog({ cli: "codex", kind: "run" })[0];
    expect(child?.env.OPENAI_API_KEY).toBeUndefined();
    expect(child?.env.MY_SECRET).toBeUndefined();
    expect(child?.env.NODE_OPTIONS).toBeUndefined();
    expect(child?.env.DISPATCH_DEPTH).toBe("1");
    expect(child?.env.DISPATCH_RUN_ID).toBe(r.runId);
    expect(child?.env.TERM).toBe("dumb");
    // [AC7] the summary, the run log and the stored events are redacted.
    expect(r.outcome).toBe("success");
    const log = readFileSync(r.log.path, "utf8");
    for (const text of [r.summary, log, JSON.stringify(r)]) {
      for (const leak of [...Object.values(FAKE_LEAKS), "canary-value-0002"]) {
        expect(text).not.toContain(leak);
      }
    }
    expect(r.summary).toContain("[REDACTED");
    expect(r.patch).toBeNull();
  });

  it("falls through when the adapter refuses to build the invocation", async () => {
    const probes = new ProbeCache();
    probes.set("codex", "codex", { ...probeResult, binaryPath: null });
    const { run } = setup({ overrides: { probes } });
    const r = await run();
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/codex: failed \(.*binary/);
  });

  it("[win32] routes around an adapter that cannot run on the OS, with the reason logged", async () => {
    const { run, fakes } = setup({
      action: FALLBACK,
      overrides: { platform: "win32", hostSelf: null },
      scenarios: { codex: [{ scenario: "success_edit", file: "a.txt", content: "a\n" }] },
    });
    const r = await run();
    valid(r);
    expect(r.externalAgent?.instance).toBe("codex");
    expect(r.decisions[0]?.chain.find((c) => c.ruleId === "claude")?.effect).toBe(
      "filtered: disabled",
    );
    expect(fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
    const log = readFileSync(r.log.path, "utf8");
    expect(log).toContain('"type":"platform.unsupported"');
    expect(log).toContain("WSL2");
  });

  it("[win32] returns to the host with the reason when only blocked adapters are left", async () => {
    const { run, fakes } = setup({
      action: { type: "provider", instance: "claude" },
      overrides: { platform: "win32", hostSelf: null },
    });
    const r = await run();
    valid(r);
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/not available on this OS: claude: .*WSL2/);
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("returns the task to the host when routing itself fails", async () => {
    const { run, deps } = setup({});
    deps.quota.snapshot = async () => {
      throw new Error("quota provider broke");
    };
    const r = await run();
    valid(r);
    expect(r).toMatchObject({ status: "returned_to_host", outcome: null });
    expect(r.summary).toContain("quota provider broke");
    expect((await deps.store.getRun(r.runId))?.status).toBe("returned_to_host");
  });

  it("skips unknown instances and missing adapters", async () => {
    const { run } = setup({
      action: FALLBACK,
      exec: { instances: [instance("codex", "nope")] },
    });
    const r = await run();
    expect(r.summary).toContain("claude: unknown instance");
    expect(r.summary).toContain('codex: no adapter "nope"');
  });

  it("skips a busy instance when its concurrency slot is taken", async () => {
    const { run, deps } = setup({});
    (deps.store as SqliteStateStore).acquireLease("codex", "other-run", {
      pid: process.pid,
      pidStart: SELF_PID_START,
      limit: 1,
      now: new Date(),
      isAlive: () => true,
    });
    const r = await run();
    expect(r.summary).toContain("codex: concurrency limit reached");
  });

  it("aborting stops the run and returns it to the host", async () => {
    const { deps, repo } = setup({ scenarios: { codex: [{ scenario: "slow", delayMs: 5_000 }] } });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    const r = await executeTask(deps, task(), {
      repoPath: repo.dir,
      signals: null,
      signal: ac.signal,
    });
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/^interrupted/);
  });

  it("truncates an over-long summary", async () => {
    const big = "x".repeat(MAX_SUMMARY_CHARS + 100);
    const { run } = setup({ scenarios: { codex: [{ scenario: "leak_secret", secret: big }] } });
    const r = await run({ autonomy: "read-only" });
    expect(r.summary.length).toBeLessThan(MAX_SUMMARY_CHARS + 50);
    expect(r.summary).toMatch(/truncated \d+ chars/);
  });
});

describe("runner helpers", () => {
  const denied = {
    outcome: "failed" as const,
    summary: "the answer",
    nativeError: "denied: write_file",
    deniedActions: ["write_file"],
    durationMs: 1,
  };

  it("read-only tasks with an answer override agy's denied-actions failure", () => {
    expect(readOnlyOverride(denied, "read-only")).toEqual({
      outcome: "success",
      summary: "the answer",
      deniedActions: ["write_file"],
      durationMs: 1,
    });
    expect(readOnlyOverride(denied, "worktree").outcome).toBe("failed");
    expect(readOnlyOverride({ ...denied, summary: " " }, "read-only").outcome).toBe("failed");
    expect(readOnlyOverride({ ...denied, nativeError: "boom" }, "read-only").outcome).toBe(
      "failed",
    );
  });

  it("trapTermination aborts on a signal and re-raises it after cleanup", () => {
    const proc = Object.assign(new EventEmitter(), { pid: 42, kill: (..._a: unknown[]) => {} });
    const kills: unknown[][] = [];
    proc.kill = (...a: unknown[]) => kills.push(a);
    const seen: string[] = [];
    const untrap = trapTermination(proc, (s) => seen.push(s));
    proc.emit("SIGTERM");
    proc.emit("SIGINT");
    untrap();
    expect(seen).toEqual(["SIGTERM", "SIGINT"]);
    expect(kills).toEqual([[42, "SIGTERM"]]);
    expect(proc.listenerCount("SIGTERM")).toBe(0);
    const quiet = trapTermination(proc, () => {});
    quiet();
    expect(kills).toHaveLength(1);
  });

  it("ProbeCache probes once per adapter and instance and forgets failures", async () => {
    let calls = 0;
    const adapter = {
      caps: { id: "x" },
      probe: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return probeResult;
      },
    } as unknown as Parameters<ProbeCache["get"]>[0];
    const cache = new ProbeCache();
    const inst = { id: "i", adapter: "x", pool: "subscription" as const };
    const deps = {} as Parameters<ProbeCache["get"]>[2];
    await expect(cache.get(adapter, inst, deps)).rejects.toThrow("boom");
    await new Promise((r) => setImmediate(r));
    expect(await cache.get(adapter, inst, deps)).toEqual(probeResult);
    expect(await cache.get(adapter, inst, deps)).toEqual(probeResult);
    expect(calls).toBe(2);
  });
});

describe("runner leases", () => {
  it("judges liveness by pid and, for this process, by start time", () => {
    expect(isProcessAlive(process.pid, SELF_PID_START)).toBe(true);
    expect(isProcessAlive(process.pid, "0")).toBe(false);
    expect(isProcessAlive(process.ppid, "whatever")).toBe(true);
    expect(isProcessAlive(2 ** 22 + 12345, "x")).toBe(false);
  });

  it("waits for a slot up to the bound, then gives up", async () => {
    let tries = 0;
    const store = {
      acquireLease: () => ++tries >= 2,
      releaseLease: () => true,
      heartbeat: () => true,
    };
    const clock = { now: () => new Date(), monotonicMs: () => performance.now() };
    expect(await acquireLease(store, "i", "r", { limit: 1, clock, waitMs: 2_000 })).toBe(true);
    expect(tries).toBe(2);
    tries = -100;
    expect(await acquireLease(store, "i", "r", { limit: 1, clock, waitMs: 300 })).toBe(false);
  });

  it("only treats non-path, non-numeric withheld values as secrets", () => {
    expect(isSecretLike("sk-abc")).toBe(true);
    expect(isSecretLike("/Users/x/.dispatch")).toBe(false);
    expect(isSecretLike("12345")).toBe(false);
  });
});

describe("reportedPatch [SEC-patch]", () => {
  const info = { path: "/r/patch.diff", diffstat: "", applies: true, needsReview: false };
  const result = (empty: boolean, rejectedPaths: string[]) => ({
    patch: { ...info, rejectedPaths, ...(empty ? {} : { diffstat: " a | 1 +\n" }) },
    empty,
    files: [],
    rejected: [],
    findings: [],
  });

  it("reports an all-rejected change set as an empty, non-applicable patch with the rejected paths", () => {
    expect(reportedPatch(result(true, [".git/hooks/x", "link"]))).toEqual({
      ...info,
      diffstat: "",
      applies: false,
      rejectedPaths: [".git/hooks/x", "link"],
    });
  });

  it("is null without a patch or without any change, and the real patch otherwise", () => {
    expect(reportedPatch(null)).toBeNull();
    expect(reportedPatch(result(true, []))).toBeNull();
    expect(reportedPatch(result(false, ["link"]))?.diffstat).toBe(" a | 1 +\n");
  });
});

describe("MCP forwarding [SEC-mcp] [SEC-env]", () => {
  const CANARY = "ghp_CANARYmcpforward0123456789abcdefgh";
  const ref = (name: string) => `\${${name}}`;
  const claudeJson = (servers: Record<string, unknown>) =>
    writeFileSync(join(home?.home ?? "", ".claude.json"), JSON.stringify({ mcpServers: servers }));
  const forward = (deps: RunnerDeps, names: string[]) =>
    executeTask(deps, task(), {
      repoPath: repo?.dir ?? "",
      signals: null,
      leaseWaitMs: 0,
      mcpServers: names,
    });
  /** Every byte Dispatch persisted: the SQLite files and the run log. */
  const persisted = (r: RunResult): string => {
    const db = join(home?.dispatchHome ?? "", "state", "dispatch.db");
    const parts = [db, `${db}-wal`].filter(existsSync).map((p) => readFileSync(p, "latin1"));
    return parts.join("") + readFileSync(r.log.path, "utf8");
  };

  it("forwards a pure-reference server to codex by name only; the value never reaches argv, logs or state", async () => {
    const { deps, fakes } = setup({
      action: FALLBACK,
      exec: { forwardMcp: true },
      env: { GH_TOKEN: CANARY },
      scenarios: { codex: [{ scenario: "leak_secret", secret: CANARY }] },
    });
    claudeJson({ gh: { command: "gh-mcp", env: { GH_TOKEN: ref("GH_TOKEN") } } });
    const r = await forward(deps, ["gh"]);
    valid(r);
    expect(r.externalAgent?.instance).toBe("codex");
    // claude cannot host MCP servers: the router never picked it.
    expect(fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
    expect(r.decisions[0]?.chain.find((c) => c.ruleId === "claude")?.effect).toMatch(/disabled/);
    const [call] = fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain('mcp_servers.gh.env_vars=["GH_TOKEN"]');
    expect(call?.args).toContain("--ignore-user-config");
    expect(call?.args.join(" ")).not.toContain(CANARY);
    expect(call?.stdin ?? "").not.toContain(CANARY);
    // Passed by name to the codex process, which hands it to the server only.
    expect(call?.env.GH_TOKEN).toBe(CANARY);
    expect(r.summary).not.toContain(CANARY);
    expect(persisted(r)).not.toContain(CANARY);
    expect(readFileSync(r.log.path, "utf8")).toContain('"type":"mcp.forward"');
  });

  it("returns the task to the host when consent is off; nothing is spawned", async () => {
    const { deps, fakes } = setup({ env: { GH_TOKEN: CANARY } });
    claudeJson({ gh: { command: "gh-mcp", env: { GH_TOKEN: ref("GH_TOKEN") } } });
    const r = await forward(deps, ["gh"]);
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/MCP forwarding is off/);
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("re-resolves at run time: a server that became a literal secret goes back to the host", async () => {
    const { deps, fakes } = setup({ exec: { forwardMcp: true } });
    // The hook saw a forwardable `gh`; by run time the user pasted a token into the config.
    claudeJson({ gh: { command: "gh-mcp", env: { GH_TOKEN: CANARY } } });
    const r = await forward(deps, ["gh"]);
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toBe("MCP server(s) cannot be forwarded (gh: literal secret in env/headers)");
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
    expect(persisted(r)).not.toContain(CANARY);
  });

  it("returns to host when no enabled provider can host the servers", async () => {
    const { deps, fakes } = setup({
      exec: { forwardMcp: true },
      routing: { instances: makeConfig().instances.filter((i) => i.id === "claude") },
      action: { type: "provider", instance: "claude" },
    });
    claudeJson({ echo: { command: "node" } });
    const r = await forward(deps, ["echo"]);
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/no enabled provider can host MCP server\(s\) echo/);
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });
});

describe("web access [UC2]", () => {
  const browse = (deps: RunnerDeps, web: "search" | "fetch") =>
    executeTask(deps, task(), { repoPath: repo?.dir ?? "", signals: null, leaseWaitMs: 0, web });

  it("codex gets live web search for a fetching agent; the shell sandbox is unchanged", async () => {
    const { deps, fakes } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
    });
    const r = await browse(deps, "fetch");
    valid(r);
    expect(r).toMatchObject({ status: "completed", outcome: "success" });
    const [call] = fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain('web_search="live"');
    expect(call?.args[(call?.args.indexOf("-s") ?? 0) + 1]).toBe("workspace-write");
    expect(readFileSync(r.log.path, "utf8")).toContain('"type":"web.forward"');
  });

  it("claude gets the web tools, pre-approved", async () => {
    const { deps, fakes } = setup({
      action: { type: "provider", instance: "claude" },
      scenarios: { claude: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
    });
    const r = await browse(deps, "search");
    expect(r.externalAgent?.instance).toBe("claude");
    const [call] = fakes.readLog({ cli: "claude", kind: "run" });
    expect(call?.args[(call?.args.indexOf("--allowedTools") ?? 0) + 1]).toBe("WebSearch");
  });

  it("[win32] a failed web plan still names the instances left out on this OS", async () => {
    const off = setup({ exec: { forwardWeb: false }, overrides: { platform: "win32" } });
    const r = await browse(off.deps, "search");
    expect(r.summary).toMatch(/web forwarding is off .*\(not available on this OS: claude: /);
  });

  it("returns to host when web forwarding is off or no enabled provider can give web", async () => {
    const off = setup({ exec: { forwardWeb: false } });
    const r = await browse(off.deps, "search");
    expect(r.status).toBe("returned_to_host");
    expect(r.summary).toMatch(/web forwarding is off \(hosts.claude-code.forward_web\)/);
    expect(off.fakes.readLog({ kind: "run" })).toEqual([]);
    const agy = setup({
      routing: { instances: makeConfig().instances.filter((i) => i.id === "agy") },
      action: { type: "provider", instance: "agy" },
    });
    const r2 = await browse(agy.deps, "fetch");
    expect(r2.status).toBe("returned_to_host");
    expect(r2.summary).toMatch(/no enabled provider can give the agent web access/);
    expect(agy.fakes.readLog({ kind: "run" })).toEqual([]);
  });
});

describe("sandbox network [SEC-network]", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const t of tmps.splice(0)) rmSync(t, { recursive: true, force: true });
  });
  const netSetup = (o: SetupOptions) => {
    const tmp = mkdtempSync(join(tmpdir(), "dispatch-net-test-"));
    tmps.push(tmp);
    return { ...setup({ ...o, env: { TMPDIR: tmp, ...o.env } }), tmp };
  };
  const go = (deps: RunnerDeps, t: Partial<Task> = {}, agent?: string) =>
    executeTask(deps, task(t), {
      repoPath: repo?.dir ?? "",
      signals: null,
      leaseWaitMs: 0,
      ...(agent === undefined ? {} : { agent }),
    }) as Promise<RunResultWithNetwork>;
  const edit: FakeScenarioMap = {
    codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }],
  };

  it("a delegated agent's worktree run gets codex network and caches; recorded in the result", async () => {
    const { deps, fakes, tmp } = netSetup({
      scenarios: edit,
      exec: { network: "delegated-agents", networkAgents: ["builder"] },
    });
    const r = await go(deps, {}, "builder");
    valid(r);
    expect(r.sandboxNetwork).toEqual({
      enabled: true,
      scope: "delegated-agents",
      agent: "builder",
      reason: "delegated agent builder (network: delegated-agents)",
    });
    const [call] = fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args).toContain("sandbox_workspace_write.network_access=true");
    const cache = call?.env.npm_config_cache ?? "";
    expect(cache.startsWith(join(realpathSync(tmp), "dispatch-net", r.runId))).toBe(true);
    expect(call?.env.npm_config_store_dir).toMatch(/pnpm-store$/);
    // The per-attempt cache is removed with the attempt.
    expect(existsSync(dirname(cache))).toBe(false);
    const stored = (await (deps.store as SqliteStateStore).getRun(r.runId))?.result as
      | RunResultWithNetwork
      | undefined;
    expect(stored?.sandboxNetwork?.enabled).toBe(true);
    expect(readFileSync(r.log.path, "utf8")).toContain('"type":"network"');
  });

  it("a run by hand, an agent outside network_agents and a read-only run stay closed", async () => {
    const a = netSetup({ scenarios: edit, exec: { network: "delegated-agents" } });
    const byHand = await go(a.deps);
    expect(byHand.sandboxNetwork).toMatchObject({ enabled: false, agent: null });
    expect(a.fakes.readLog({ cli: "codex", kind: "run" })[0]?.args.join(" ")).not.toContain(
      "network_access",
    );
    const b = netSetup({
      scenarios: edit,
      exec: { network: "delegated-agents", networkAgents: ["builder"] },
      env: { CLAUDECODE: "1" },
    });
    const gp = await go(b.deps);
    expect(gp.sandboxNetwork).toMatchObject({ enabled: false, agent: "general-purpose" });
    const c = netSetup({
      scenarios: { codex: [{ scenario: "fail" }] },
      exec: { network: "all" },
    });
    const ro = await go(c.deps, { autonomy: "read-only" });
    expect(ro.sandboxNetwork?.enabled).toBe(true);
    const [call] = c.fakes.readLog({ cli: "codex", kind: "run" });
    expect(call?.args.join(" ")).not.toContain("network_access");
    expect(call?.env.npm_config_cache).toBeUndefined();
  });

  it("default off: no field, no flag; claude gets sandbox.network in --settings", async () => {
    const off = netSetup({ scenarios: edit });
    const r = await go(off.deps, {}, "builder");
    expect(r.sandboxNetwork).toBeUndefined();
    const cl = netSetup({
      action: { type: "provider", instance: "claude" },
      scenarios: { claude: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
      exec: { network: "all" },
    });
    const r2 = await go(cl.deps);
    expect(r2.externalAgent?.instance).toBe("claude");
    const [call] = cl.fakes.readLog({ cli: "claude", kind: "run" });
    const settings = JSON.parse(call?.args[(call?.args.indexOf("--settings") ?? 0) + 1] ?? "{}");
    expect(settings.sandbox.network).toMatchObject({ allowLocalBinding: true });
    expect(renderRunResult(r2)).toContain("Sandbox network: on (network: all)");
  });
});
