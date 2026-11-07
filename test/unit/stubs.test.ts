import { stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import * as fx from "../fixtures/contracts.js";
import { FakeClock, FakeSandbox, MemoryStateStore, StubQuotaProvider } from "../stubs/index.js";

describe("test stubs", () => {
  it("FakeClock advances wall and monotonic time; set() moves wall time only", () => {
    const clock = new FakeClock(fx.T0);
    clock.advance(1500);
    expect(clock.now().toISOString()).toBe("2026-01-01T00:00:01.500Z");
    expect(clock.monotonicMs()).toBe(1500);
    clock.set("2025-01-01T00:00:00.000Z");
    expect(clock.now().getUTCFullYear()).toBe(2025);
    expect(clock.monotonicMs()).toBe(1500);
    expect(new FakeClock().now().toISOString()).toBe(fx.T0);
  });

  it("MemoryStateStore stores runs, decisions and events without aliasing", async () => {
    const store = new MemoryStateStore();
    await store.recordRun(fx.runRecord);
    await expect(store.recordRun(fx.runRecord)).rejects.toThrow(/already exists/);
    const updated = await store.updateRun(fx.runRecord.runId, {
      status: "completed",
      result: fx.runResult,
    });
    expect(updated.status).toBe("completed");
    updated.status = "rejected";
    expect((await store.getRun(fx.runRecord.runId))?.status).toBe("completed");
    expect(await store.getRun("missing")).toBeNull();
    await expect(store.updateRun("missing", {})).rejects.toThrow(/unknown run/);

    await store.appendEvent("r", { kind: "reading", ts: fx.T0 });
    await store.appendEvent("r", { kind: "done", ts: fx.T0 });
    expect(store.events.get("r")?.map((e) => e.kind)).toEqual(["reading", "done"]);

    const later = { ...fx.decisionRecord, id: "d-2", createdAt: "2026-01-02T00:00:00.000Z" };
    await store.recordDecision(later);
    await store.recordDecision(fx.decisionRecord);
    expect((await store.listDecisions(fx.T0)).map((d) => d.id)).toEqual(["d-1", "d-2"]);
    expect((await store.listDecisions("2026-01-01T12:00:00.000Z")).map((d) => d.id)).toEqual([
      "d-2",
    ]);
  });

  it("StubQuotaProvider returns the snapshot for the requested instances", async () => {
    const provider = new StubQuotaProvider(fx.quota);
    const snap = await provider.snapshot([{ id: "codex", adapter: "codex", pool: "subscription" }]);
    expect(Object.keys(snap.instances)).toEqual(["codex"]);
    expect(snap.takenAt).toBe(fx.T0);
    await provider.recordObservation({
      instanceId: "codex",
      at: fx.T0,
      exhausted: { resetAt: null },
    });
    expect(provider.observations).toHaveLength(1);
  });

  it("FakeSandbox creates temp dirs and disposes or keeps them", async () => {
    const sandbox = new FakeSandbox();
    const a = await sandbox.create({ repoPath: "/repo", runId: "r1", autonomy: "worktree" });
    const b = await sandbox.create({ repoPath: "/repo", runId: "r2", autonomy: "read-only" });
    expect(a.dirtySnapshot).toBe(false);
    expect((await stat(a.path)).isDirectory()).toBe(true);
    await sandbox.dispose(a.path, false);
    await expect(stat(a.path)).rejects.toThrow();
    await sandbox.dispose(b.path, true);
    expect(sandbox.kept).toEqual([b.path]);
    expect((await stat(b.path)).isDirectory()).toBe(true);
    await sandbox.dispose(b.path, false);
  });
});
