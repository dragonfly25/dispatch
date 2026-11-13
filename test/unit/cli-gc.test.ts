import { existsSync } from "node:fs";
import { utimes } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WorktreeSandbox } from "../../src/sandbox/worktree.js";
import { DAY, HOUR, iso, MIN, type Ops, opsHarness, runRecord } from "./cli-ops.helpers.js";
import { cleanup, makeRepo } from "./sandbox-helpers.js";

// Five real git worktrees take longer than the 5 s default on Windows runners.
if (process.platform === "win32") vi.setConfig({ testTimeout: 60_000 });

const dirs: string[] = [];
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  // Hermetic git: ignore the developer's global/system config.
  for (const k of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"]) saved[k] = process.env[k];
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
afterEach(() => cleanup(dirs));

/** Creates a worktree for `runId` and dates its directory `ageMs` before the fake clock. */
async function worktree(h: Ops, repo: string, runId: string, ageMs: number): Promise<string> {
  const handle = await new WorktreeSandbox().create({
    repoPath: repo,
    runId,
    autonomy: "worktree",
    dispatchHome: h.sb.dispatchHome,
  });
  const t = new Date(h.clock.now().getTime() - ageMs);
  await utimes(handle.path, t, t);
  return handle.path;
}

describe("gc", () => {
  it("[UC13] removes only terminal and old worktrees", async () => {
    const h = opsHarness();
    const repo = await makeRepo(dirs);
    const oldDone = await worktree(h, repo, "done-old", 3 * DAY);
    const oldFailed = await worktree(h, repo, "rejected-old", 2 * DAY);
    const oldUnknown = await worktree(h, repo, "no-record", 2 * DAY);
    const youngDone = await worktree(h, repo, "done-young", HOUR);
    const oldRunning = await worktree(h, repo, "running-old", 5 * DAY);
    await h.store.recordRun(runRecord("done-old"));
    await h.store.recordRun(runRecord("rejected-old", { status: "rejected" }));
    await h.store.recordRun(runRecord("done-young"));
    await h.store.recordRun(runRecord("running-old", { status: "running" }));

    const r = await h.run(["gc"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Removed 3 worktree(s):");
    for (const p of [oldDone, oldFailed, oldUnknown]) {
      expect(r.out).toContain(`  ${p}`);
      expect(existsSync(p)).toBe(false);
    }
    expect(existsSync(youngDone)).toBe(true);
    expect(existsSync(oldRunning)).toBe(true);
    expect(r.out).not.toContain(oldRunning);
  });

  it("--older-than moves the threshold", async () => {
    const h = opsHarness();
    const repo = await makeRepo(dirs);
    const young = await worktree(h, repo, "r1", 2 * HOUR);
    await h.store.recordRun(runRecord("r1"));
    expect((await h.run(["gc"])).out).toContain("Removed 0 worktree(s)\n");
    expect(existsSync(young)).toBe(true);
    const r = await h.run(["gc", "--older-than", "1h", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({
      dryRun: false,
      olderThanMs: HOUR,
      worktrees: [young],
    });
    expect(existsSync(young)).toBe(false);
  });

  it("--dry-run lists what would go and removes nothing", async () => {
    const h = opsHarness({ isAlive: () => false });
    const repo = await makeRepo(dirs);
    const old = await worktree(h, repo, "r1", 3 * DAY);
    await h.store.recordRun(runRecord("r1"));
    await h.store.recordRun(
      runRecord("ancient", { createdAt: iso(-60 * DAY), updatedAt: iso(-60 * DAY) }),
    );
    h.store.acquireLease("codex", "r-dead", {
      pid: 4242,
      pidStart: "x",
      limit: 3,
      now: iso(0),
      isAlive: () => true,
    });

    const r = await h.run(["gc", "--dry-run"]);
    expect(r.out).toContain("Would remove 1 worktree(s):");
    expect(r.out).toContain(`  ${old}`);
    expect(r.out).toContain("Would reap 1 stale lease(s):");
    expect(r.out).toContain("run r-dead on codex (pid 4242");
    expect(r.out).toContain("Would prune history older than 30 day(s)");
    expect(existsSync(old)).toBe(true);
    expect(await h.store.getRun("ancient")).not.toBeNull();
    expect(h.store.listLeases()).toHaveLength(1);
  });

  it("prunes history older than the configured retention (default 30 days)", async () => {
    const h = opsHarness();
    const stamp = (days: number) => ({ createdAt: iso(-days * DAY), updatedAt: iso(-days * DAY) });
    await h.store.recordRun(runRecord("old", stamp(40)));
    await h.store.recordRun(runRecord("recent", stamp(10)));
    await h.store.recordRun(runRecord("stuck", { status: "running", ...stamp(40) }));
    const first = await h.run(["gc"]);
    expect(first.out).toContain("Pruned history older than 30 day(s): runs 1");
    expect(await h.store.getRun("old")).toBeNull();
    expect(await h.store.getRun("recent")).not.toBeNull();
    expect(await h.store.getRun("stuck")).not.toBeNull();

    h.sb.global("version: 1\nretention_days: 7\n");
    const second = await h.run(["gc", "--json"]);
    expect(JSON.parse(second.out)).toMatchObject({ retentionDays: 7, pruned: { runs: 1 } });
    expect(await h.store.getRun("recent")).toBeNull();
    expect((await h.run(["gc"])).out).toContain("Pruned nothing older than 7 day(s)");
  });

  it("reaps leases whose heartbeat is stale or whose process is gone, keeps live ones", async () => {
    const dead = new Set([222]);
    const h = opsHarness({ isAlive: (pid) => !dead.has(pid) });
    const lease = (runId: string, pid: number, at: string) =>
      h.store.acquireLease("codex", runId, {
        pid,
        pidStart: "s",
        limit: 9,
        now: at,
        isAlive: () => true,
      });
    lease("live", 111, iso(-10_000));
    lease("gone", 222, iso(-10_000));
    lease("silent", 333, iso(-10 * MIN));

    const r = await h.run(["gc"]);
    expect(r.out).toContain("Reaped 2 stale lease(s):");
    expect(r.out).toContain("run gone on codex (pid 222");
    expect(r.out).toContain("run silent on codex (pid 333");
    expect(h.store.listLeases().map((l) => l.runId)).toEqual(["live"]);
  });

  it("with nothing to do it says so", async () => {
    const r = await opsHarness().run(["gc"]);
    expect(r.code).toBe(0);
    expect(r.out).toBe(
      "Removed 0 worktree(s)\nReaped 0 stale lease(s)\nPruned nothing older than 30 day(s)\n",
    );
  });

  it("rejects a bad --older-than with exit 2", async () => {
    const r = await opsHarness().run(["gc", "--older-than", "a day"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--older-than must be a duration");
  });

  it("the default liveness check treats the current process as alive and a bogus pid as gone", async () => {
    const { pidAlive } = await import("../../src/cli/commands/shared.js");
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });
});
