/**
 * WP23 detach / wait / cancel with real processes: the real CLI (bundled) as supervisor, fake
 * agent CLIs, a temp HOME and a real git repo. Process checks poll with generous bounds so they
 * hold on a slow macOS CI runner; a zombie counts as dead.
 */
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadAppContext } from "../../src/app/context.js";
import { runnerDeps } from "../../src/app/runner.js";
import { renderRunResult } from "../../src/cli/commands/run.js";
import { detachRun } from "../../src/cli/commands/runs.js";
import { buildProgram, runCli } from "../../src/cli/program.js";
import { systemClock } from "../../src/core/clock.js";
import { ExitCode, type RunResult } from "../../src/core/contracts.js";
import { newRunId } from "../../src/core/ids.js";
import { detectHost } from "../../src/platform/host.js";
import {
  CANCELLED,
  type DetachDeps,
  startDetached,
  superviseRun,
  TASK_FILE,
} from "../../src/runner/detach.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { cancelRun, SUPERVISOR_LOST, waitForRun } from "../../src/runner/wait.js";
import { SqliteStateStore } from "../../src/state/store.js";
import { bundleHelper } from "../helpers/bundle.js";
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
import { sleep, waitFor } from "./fakes-helpers.js";

const TEST_MS = 90_000;
let bundle: { dir: string; file: string };

beforeAll(async () => {
  // Inside the package: node resolves the external deps and the bundle finds `assets/`.
  bundle = await bundleHelper("dispatch-cli", {
    parent: resolve("node_modules", ".cache"),
    external: true,
  });
}, 120_000);
afterAll(() => rmSync(bundle.dir, { recursive: true, force: true }));

/** Alive and not a zombie. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout;
  return stat.trim() !== "" && !stat.trim().startsWith("Z");
}

async function expectGone(pid: number): Promise<void> {
  await waitFor(() => !running(pid), 30_000);
}

const GLOBAL = `version: 1
profile: t
quota:
  readers:
    claude: { enabled: false }
    codex: { enabled: false }
`;
const PROFILE = `version: 1
rules:
  - id: all
    action: { type: provider, instance: codex }
`;

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
let store: SqliteStateStore | undefined;
const pgids: number[] = [];
afterEach(() => {
  for (const g of pgids.splice(0)) {
    try {
      process.kill(-g, "SIGKILL");
    } catch {
      // gone
    }
  }
  store?.close();
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = store = undefined;
});

function setup(scenarios: FakeScenarioMap) {
  fakes = createFakes(scenarios);
  home = tempHome();
  repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
  const env = { ...fakes.env, ...home.env };
  const db = join(home.dispatchHome, "state", "dispatch.db");
  mkdirSync(join(home.dispatchHome, "profiles"), { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), GLOBAL);
  writeFileSync(join(home.dispatchHome, "profiles", "t.yaml"), PROFILE);
  store = SqliteStateStore.open(db);
  const deps: DetachDeps = {
    store,
    clock: systemClock,
    env,
    dispatchHome: home.dispatchHome,
    host: detectHost(env),
    cli: [process.execPath, "--disable-warning=ExperimentalWarning", bundle.file],
  };
  const task = {
    id: "t1",
    prompt: "add sub to math.js",
    paths: ["math.js"],
    autonomy: "worktree" as const,
    timeoutMs: 60_000,
  };
  const cli = async (args: string[], extra: Record<string, string> = {}) => {
    let out = "";
    const io = {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        out += t;
      },
    };
    const e = { ...env, ...extra };
    const program = buildProgram(io, {}, {}, { cwd: repo?.dir ?? "", env: e });
    const code = await runCli(args, io, program, { platform: process.platform, env: e });
    return { code, out };
  };
  const waitDeps = { store, clock: systemClock };
  return { deps, task, cli, env, repo, home, fakes, store, waitDeps };
}

/** The fake agent's invocation once it is running (its pid and process group). */
async function agentStarted(f: FakesContext) {
  const e = await waitFor(() => f.readLog({ kind: "run" })[0], 30_000);
  if (e.pgid) pgids.push(e.pgid);
  return e;
}

const slow = (n: number, delayMs: number) => ({
  codex: [
    {
      scenario: "slow" as const,
      delayMs,
      events: Array.from({ length: n }, (_, i) => ({ type: "noop", i })),
    },
  ],
});

describe("detach / wait / cancel (real processes)", () => {
  it(
    "[UC3] detach returns at once; wait exits 75 while running, then prints the result",
    async () => {
      const s = setup({ codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] });
      // Hold the agent back until the first wait has answered 75.
      s.fakes.setScenarios(slow(400, 25));
      const before = snapshotTree(s.repo.dir);
      const { runId, created } = await startDetached(s.deps, s.task, { repoPath: s.repo.dir });
      expect(created).toBe(true);
      const rec = await s.store.getRun(runId);
      expect(rec?.status).toBe("running");
      expect(rec?.pid).not.toBe(process.pid);
      const first = await s.cli(["wait", runId, "--timeout", "0", "--json"]);
      expect(first.code).toBe(ExitCode.STILL_RUNNING);
      expect(JSON.parse(first.out)).toMatchObject({ runId, status: "running", outcome: null });
      expect((await s.cli(["wait", runId, "--timeout", "0"])).out).toContain(
        `Run ${runId}: running`,
      );
      await agentStarted(s.fakes);
      expect(existsSync(join(s.home.dispatchHome, "runs", runId, TASK_FILE))).toBe(false);
      // Several concurrent waits (Codex may start duplicates) all get the same final result.
      const waits = await Promise.all(
        [1, 2, 3].map(() => s.cli(["wait", runId, "--timeout", "60", "--json"])),
      );
      for (const w of waits) {
        expect(w.code).toBe(ExitCode.OK);
        const r = JSON.parse(w.out) as RunResult;
        expect(r).toMatchObject({ runId, status: "completed", outcome: "success" });
        expect(r.externalAgent?.instance).toBe("codex");
      }
      // Text output is `run`'s printer, byte for byte.
      const final = JSON.parse(waits[0]?.out ?? "{}") as RunResult;
      expect((await s.cli(["wait", runId])).out).toBe(renderRunResult(final));
      expect(snapshotTree(s.repo.dir)).toEqual(before);
      expect(existsSync(join(s.home.dispatchHome, "runs", runId, "supervisor.log"))).toBe(true);
      expect(s.store.listLeases()).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "[UC3][SEC-R4] a repeated detach with the same idempotency key returns the same run",
    async () => {
      const s = setup(slow(4, 50));
      const a = await startDetached(s.deps, s.task, { repoPath: s.repo.dir, idempotencyKey: "k" });
      const b = await startDetached(
        s.deps,
        { ...s.task, id: "t2" },
        {
          repoPath: s.repo.dir,
          idempotencyKey: "k",
        },
      );
      expect(b).toEqual({ runId: a.runId, created: false });
      // `run --detach` prints `{ runId }` (here: the same run again).
      const ctx = loadAppContext({ cwd: s.repo.dir, env: s.env });
      let printed = "";
      const io = {
        out: (t: string) => {
          printed += t;
        },
        err: () => {},
      };
      const viaCli = await detachRun({ io, cwd: s.repo.dir, env: s.env }, ctx, s.task, {
        idempotencyKey: "k",
        ...(s.deps.cli ? { cli: s.deps.cli } : {}),
      });
      ctx.close();
      expect(viaCli).toBe(a.runId);
      expect(JSON.parse(printed)).toEqual({ runId: a.runId });
      // Automatic key inside a host session: hash of session and task.
      const host = {
        ...s.deps,
        host: { host: "codex" as const, sessionId: "S", depth: 0, evidence: [] },
      };
      const c = await startDetached(host, s.task, { repoPath: s.repo.dir });
      const d = await startDetached(host, { ...s.task, id: "t3" }, { repoPath: s.repo.dir });
      expect(d).toEqual({ runId: c.runId, created: false });
      expect(c.runId).not.toBe(a.runId);
      for (const id of [a.runId, c.runId]) {
        expect((await waitForRun(s.waitDeps, id, 60_000)).exitCode).toBe(ExitCode.OK);
      }
      // One agent run per distinct run (the probe's `exec --help` is not a run of the task).
      const runs = s.fakes.readLog({ kind: "run" }).filter((e) => !e.args.includes("--help"));
      expect(runs).toHaveLength(2);
    },
    TEST_MS,
  );

  it(
    "cancel kills the agent's process group, releases the lease and records the cancel",
    async () => {
      const s = setup(slow(200, 250));
      const { runId } = await startDetached(s.deps, s.task, { repoPath: s.repo.dir });
      const agent = await agentStarted(s.fakes);
      await waitFor(() => s.store.listLeases().length === 1, 30_000);
      const supervisor = (await s.store.getRun(runId))?.pid ?? 0;
      const out = await s.cli(["cancel", runId, "--json"]);
      expect(out.code).toBe(ExitCode.OK);
      const r = JSON.parse(out.out) as RunResult;
      expect(r).toMatchObject({
        runId,
        status: "completed",
        outcome: "failed",
        summary: CANCELLED,
      });
      await expectGone(agent.pid);
      await expectGone(supervisor);
      expect(s.store.listLeases()).toEqual([]);
      expect(s.repo.git("worktree", "list").split("\n")).toHaveLength(1);
      // Cancelling a finished run is a no-op.
      expect((await cancelRun(s.waitDeps, runId)).summary).toBe(CANCELLED);
    },
    TEST_MS,
  );

  it(
    "a supervisor killed with SIGKILL is detected as supervisor_lost",
    async () => {
      const s = setup(slow(200, 250));
      const { runId } = await startDetached(s.deps, s.task, { repoPath: s.repo.dir });
      await agentStarted(s.fakes);
      const supervisor = (await s.store.getRun(runId))?.pid ?? 0;
      process.kill(supervisor, "SIGKILL");
      await expectGone(supervisor);
      await sleep(10);
      const w = await waitForRun({ ...s.waitDeps, staleMs: 0 }, runId, 0);
      expect(w.exitCode).toBe(ExitCode.FAILED);
      expect((w.result as RunResult).summary).toContain(SUPERVISOR_LOST);
    },
    TEST_MS,
  );

  it(
    "a supervisor that cannot load its config records the failure and returns the task to the host",
    async () => {
      const s = setup(slow(1, 10));
      writeFileSync(join(s.home.dispatchHome, "config.yaml"), "version: [\n");
      const { runId } = await startDetached({ ...s.deps, startWaitMs: 0 }, s.task, {
        repoPath: s.repo.dir,
        provider: "codex",
      });
      const w = await waitForRun(s.waitDeps, runId, 60_000);
      expect(w.result).toMatchObject({ status: "returned_to_host" });
      expect((w.result as RunResult).summary).toContain("dispatch could not run the task");
      expect(s.fakes.readLog({ kind: "run" })).toEqual([]);
    },
    TEST_MS,
  );

  it(
    "a supervisor binary that cannot be spawned ends the run at once",
    async () => {
      const s = setup(slow(1, 10));
      const { runId } = await startDetached(
        { ...s.deps, cli: [join(s.home.home, "missing-node")] },
        s.task,
        { repoPath: s.repo.dir },
      );
      const rec = await s.store.getRun(runId);
      expect(rec?.status).toBe("returned_to_host");
      expect(rec?.result?.summary).toContain("the supervisor could not start");
    },
    TEST_MS,
  );
});

describe("e2e: the built CLI", () => {
  it(
    "[UC3] `run --detach --json` prints { runId }; `wait` exits 75, then prints the final result",
    async () => {
      const s = setup(slow(60, 50));
      const cli = (...args: string[]) =>
        spawnSync(
          process.execPath,
          ["--disable-warning=ExperimentalWarning", bundle.file, ...args],
          {
            cwd: s.repo.dir,
            env: s.env,
            encoding: "utf8",
            timeout: 120_000,
          },
        );
      const started = cli("run", "--detach", "--json", "--task", "add sub to math.js");
      expect(started.status).toBe(ExitCode.OK);
      const { runId } = JSON.parse(started.stdout) as { runId: string };
      expect(Object.keys(JSON.parse(started.stdout))).toEqual(["runId"]);
      const early = cli("wait", runId, "--timeout", "0", "--json");
      expect(early.status).toBe(ExitCode.STILL_RUNNING);
      expect(JSON.parse(early.stdout)).toMatchObject({ runId, status: "running" });
      const done = cli("wait", runId, "--timeout", "90", "--json");
      expect(done.status).toBe(ExitCode.OK);
      const r = JSON.parse(done.stdout) as RunResult;
      expect(r).toMatchObject({ runId, status: "completed", outcome: "success" });
      expect(r.externalAgent).toMatchObject({ instance: "codex", marker: "EXTERNAL_AGENT_OUTPUT" });
    },
    TEST_MS,
  );
});

/** A run recorded the way `startDetached` records it, without starting a supervisor. */
async function recorded(s: ReturnType<typeof setup>) {
  const runId = newRunId();
  const runDir = join(s.home.dispatchHome, "runs", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, TASK_FILE), JSON.stringify({ task: s.task, repoPath: s.repo.dir }));
  const at = new Date().toISOString();
  await s.store.recordRun({
    runId,
    status: "running",
    createdAt: at,
    updatedAt: at,
    instance: null,
    pid: null,
    result: null,
  });
  return { runId, runDir };
}

describe("supervisor (in process)", () => {
  it(
    "[UC3] `__supervise` runs the task, deletes the task file and records the result",
    async () => {
      const s = setup({ codex: [{ scenario: "success_edit", file: "n.txt", content: "n\n" }] });
      const { runId, runDir } = await recorded(s);
      const r = await s.cli(["__supervise", runId, "--run-dir", runDir]);
      expect(r.code).toBe(ExitCode.OK);
      expect(existsSync(join(runDir, TASK_FILE))).toBe(false);
      const rec = await s.store.getRun(runId);
      expect(rec).toMatchObject({ status: "completed", pid: process.pid });
      expect(rec?.result?.outcome).toBe("success");
      // `wait` in a host with the default timeout returns at once for a finished run.
      const w = await s.cli(["wait", runId], { CLAUDECODE: "1" });
      expect(w.code).toBe(ExitCode.OK);
      expect((await s.cli(["cancel", runId])).out).toContain("completed (success)");
      expect((await s.cli(["wait", runId, "--timeout", "-1"])).code).toBe(ExitCode.USAGE);
    },
    TEST_MS,
  );

  it(
    "SIGHUP is ignored; SIGTERM cancels the run (agent group killed, lease released)",
    async () => {
      const s = setup(slow(200, 250));
      const { runId, runDir } = await recorded(s);
      const signals = new EventEmitter();
      const done = superviseRun(
        {
          signals: signals as unknown as Pick<NodeJS.Process, "on" | "off">,
          heartbeatMs: 20,
          build: async (p) => {
            const ctx = loadAppContext({ cwd: p.repoPath, env: s.env });
            // The process-wide probe cache still points at an earlier test's fakes.
            return { ...runnerDeps(ctx, { probes: new ProbeCache() }), close: () => ctx.close() };
          },
        },
        runId,
        runDir,
      );
      const agent = await agentStarted(s.fakes);
      const beat = (await s.store.getRun(runId))?.updatedAt ?? "";
      const until = Date.now() + 10_000;
      while (((await s.store.getRun(runId))?.updatedAt ?? "") <= beat && Date.now() < until) {
        await sleep(20);
      }
      expect((await s.store.getRun(runId))?.updatedAt).not.toBe(beat);
      signals.emit("SIGHUP");
      expect(running(agent.pid)).toBe(true);
      signals.emit("SIGTERM");
      const r = await done;
      expect(r).toMatchObject({ status: "completed", outcome: "failed", summary: CANCELLED });
      expect((await s.store.getRun(runId))?.result?.summary).toBe(CANCELLED);
      await expectGone(agent.pid);
      expect(s.store.listLeases()).toEqual([]);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    },
    TEST_MS,
  );

  it(
    "`__supervise` with a broken config records the failure (task back to the host)",
    async () => {
      const s = setup(slow(1, 10));
      const { runId, runDir } = await recorded(s);
      writeFileSync(join(s.home.dispatchHome, "config.yaml"), "version: [\n");
      const r = await s.cli(["__supervise", runId, "--run-dir", runDir]);
      expect(r.out).toContain("dispatch: supervisor:");
      const rec = await s.store.getRun(runId);
      expect(rec?.status).toBe("returned_to_host");
      expect(rec?.result?.summary).toContain("dispatch could not run the task");
      // A second failure report does not overwrite a finished run.
      await s.cli(["__supervise", runId, "--run-dir", runDir]);
      expect((await s.store.getRun(runId))?.result?.summary).toBe(rec?.result?.summary);
    },
    TEST_MS,
  );
});

describe("supervisor of a handoff run [UC2][SEC-handoff]", () => {
  it(
    "a handed-back handoff run records the passthrough; a successful one does not",
    async () => {
      // The process-wide probe cache may point at an earlier test's fakes, so the expectation
      // follows the recorded result rather than the scenario.
      for (const scenario of ["success_edit", "fail"] as const) {
        const s = setup({ codex: [{ scenario, file: "n.txt", content: "n\n" }] });
        const runId = newRunId();
        const runDir = join(s.home.dispatchHome, "runs", runId);
        mkdirSync(runDir, { recursive: true });
        const handoff = {
          agent: "a",
          passthroughKey: `k-${scenario}`,
          autoApply: true,
          mcpServers: [],
        };
        writeFileSync(
          join(runDir, TASK_FILE),
          JSON.stringify({ task: s.task, repoPath: s.repo.dir, handoff }),
        );
        const at = new Date().toISOString();
        await s.store.recordRun({
          runId,
          status: "running",
          createdAt: at,
          updatedAt: at,
          instance: null,
          pid: null,
          result: null,
        });
        await s.cli(["__supervise", runId, "--run-dir", runDir]);
        const file = join(s.home.dispatchHome, "hook-passthrough.json");
        const keys = existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf8"))) : [];
        const r = (await s.store.getRun(runId))?.result;
        const ok = r?.status === "completed" && r.outcome === "success";
        if (scenario === "fail") expect(ok).toBe(false);
        expect(keys, scenario).toEqual(ok ? [] : [`k-${scenario}`]);
        s.store.close();
        s.fakes.dispose();
        s.home.cleanup();
        s.repo.cleanup();
        store = fakes = home = repo = undefined;
      }
    },
    TEST_MS,
  );
});
