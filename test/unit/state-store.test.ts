import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaWindow } from "../../src/core/contracts.js";
import { DispatchError } from "../../src/core/errors.js";
import { newRunId } from "../../src/core/ids.js";
import { openDb } from "../../src/state/db.js";
import { LATEST_VERSION } from "../../src/state/migrations.js";
import { type IsAlive, LEASE_STALE_MS, SqliteStateStore } from "../../src/state/store.js";
import * as fx from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";

let dir: string;
let dbPath: string;
let clock: FakeClock;
const open: SqliteStateStore[] = [];

const openStore = (options: ConstructorParameters<typeof SqliteStateStore>[1] = {}) => {
  const s = SqliteStateStore.open(dbPath, { clock, ...options });
  open.push(s);
  return s;
};
const at = (ms: number) => new Date(Date.parse(fx.T0) + ms);

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-store-"));
  dbPath = join(dir, "state", "dispatch.db");
  clock = new FakeClock(fx.T0);
});
afterEach(async () => {
  for (const s of open.splice(0)) s.close();
  await rm(dir, { recursive: true, force: true });
});

const window5h = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  kind: "5h",
  usedPct: 10,
  resetAt: "2026-01-01T05:00:00.000Z",
  source: "claude-passive",
  readAt: fx.T0,
  reliability: "real",
  ...over,
});

describe("StateStore port", () => {
  it("round-trips runs, decisions and events", async () => {
    const store = openStore();
    await store.recordRun(fx.runRecord);
    await expect(store.recordRun(fx.runRecord)).rejects.toThrow(/already exists/);
    expect(await store.getRun(fx.runRecord.runId)).toEqual(fx.runRecord);
    expect(await store.getRun("missing")).toBeNull();

    clock.advance(1000);
    const updated = await store.updateRun(fx.runRecord.runId, {
      status: "completed",
      result: fx.runResult,
      pid: null,
    });
    expect(updated.status).toBe("completed");
    expect(updated.updatedAt).toBe("2026-01-01T00:00:01.000Z");
    expect(updated.createdAt).toBe(fx.T0);
    expect(await store.getRun(fx.runRecord.runId)).toEqual(updated);
    expect((await store.getRun(fx.runRecord.runId))?.result).toEqual(fx.runResult);

    const explicit = await store.updateRun(fx.runRecord.runId, {
      updatedAt: "2026-02-02T00:00:00.000Z",
    });
    expect(explicit.updatedAt).toBe("2026-02-02T00:00:00.000Z");
    await expect(store.updateRun("missing", {})).rejects.toThrow(/unknown run/);

    await store.recordDecision(fx.decisionRecord);
    await store.recordDecision({
      ...fx.decisionRecord,
      id: "d-2",
      createdAt: "2026-01-02T00:00:00Z",
    });
    expect(await store.listDecisions(fx.T0)).toEqual([
      fx.decisionRecord,
      { ...fx.decisionRecord, id: "d-2", createdAt: "2026-01-02T00:00:00.000Z" },
    ]);
    expect((await store.listDecisions("2026-01-01T12:00:00.000Z")).map((d) => d.id)).toEqual([
      "d-2",
    ]);

    await store.appendEvent(fx.runRecord.runId, { kind: "reading", ts: fx.T0, detail: "a.ts" });
    await store.appendEvent(fx.runRecord.runId, { kind: "done", ts: fx.T0 });
    expect(store.listEvents(fx.runRecord.runId)).toEqual([
      { kind: "reading", ts: fx.T0, detail: "a.ts" },
      { kind: "done", ts: fx.T0 },
    ]);
    expect(store.listEvents("other")).toEqual([]);
    await expect(store.appendEvent("no-such-run", { kind: "done", ts: fx.T0 })).rejects.toThrow();
  });

  it("listRuns filters by status, orders newest first and honours limit", async () => {
    const store = openStore();
    for (let i = 0; i < 4; i++) {
      await store.recordRun({
        ...fx.runRecord,
        runId: `run-${i}`,
        status: i % 2 === 0 ? "running" : "completed",
        createdAt: at(i * 1000).toISOString(),
        updatedAt: at(i * 1000).toISOString(),
      });
    }
    expect(store.listRuns().map((r) => r.runId)).toEqual(["run-3", "run-2", "run-1", "run-0"]);
    expect(store.listRuns({ status: "running" }).map((r) => r.runId)).toEqual(["run-2", "run-0"]);
    expect(store.listRuns({ limit: 1 }).map((r) => r.runId)).toEqual(["run-3"]);
  });

  it("rejects invalid timestamps", async () => {
    const store = openStore();
    await expect(store.recordDecision({ ...fx.decisionRecord, createdAt: "nope" })).rejects.toThrow(
      RangeError,
    );
  });

  it("persists across re-open and uses the system clock by default", async () => {
    const a = openStore();
    await a.recordRun(fx.runRecord);
    a.close();
    open.length = 0;
    const b = SqliteStateStore.open(dbPath);
    open.push(b);
    expect(await b.getRun(fx.runRecord.runId)).toEqual(fx.runRecord);
    const before = Date.now();
    const updated = await b.updateRun(fx.runRecord.runId, { status: "rejected" });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(before - 1);
  });

  it("refuses to open a database written by a newer Dispatch", () => {
    const raw = openDb(dbPath);
    raw.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    raw.close();
    expect(() => SqliteStateStore.open(dbPath, { clock })).toThrow(DispatchError);
  });
});

describe("shadow decisions", () => {
  it("records per decision and profile, replaces duplicates, filters by time", () => {
    const store = openStore();
    store.recordShadow("d-1", "balance", fx.decision);
    store.recordShadow("d-1", "preserve", { ...fx.decision, reason: "preserve" });
    clock.advance(60_000);
    store.recordShadow("d-1", "balance", { ...fx.decision, reason: "again" });
    store.recordShadow("d-2", "balance", fx.decision);

    const all = store.listShadow(fx.T0);
    expect(all.map((s) => `${s.decisionId}/${s.profile}`)).toEqual([
      "d-1/preserve",
      "d-1/balance",
      "d-2/balance",
    ]);
    expect(all[1]?.decision.reason).toBe("again");
    expect(store.listShadow(at(30_000)).map((s) => s.decisionId)).toEqual(["d-1", "d-2"]);
  });
});

describe("quota", () => {
  it("keeps history and returns the latest reading per instance and window", () => {
    const store = openStore();
    store.recordQuotaReading(
      "claude",
      window5h({ usedPct: 10, readAt: "2026-01-01T00:00:00.000Z" }),
    );
    store.recordQuotaReading(
      "claude",
      window5h({ usedPct: 30, readAt: "2026-01-01T01:00:00.000Z" }),
    );
    // Out-of-order insert of an older reading must not win.
    store.recordQuotaReading(
      "claude",
      window5h({ usedPct: 5, readAt: "2025-12-31T00:00:00.000Z" }),
    );
    store.recordQuotaReading(
      "claude",
      window5h({ kind: "7d", usedPct: null, resetAt: null, reliability: "unknown" }),
    );
    store.recordQuotaReading("codex", window5h({ source: "codex-app-server" }));

    const latest = store.latestQuotaReadings();
    expect(latest.map((r) => `${r.instanceId}/${r.window.kind}`)).toEqual([
      "claude/5h",
      "claude/7d",
      "codex/5h",
    ]);
    expect(latest[0]?.window).toEqual(
      window5h({ usedPct: 30, readAt: "2026-01-01T01:00:00.000Z" }),
    );
    expect(latest[1]?.window.usedPct).toBeNull();
    expect(latest[1]?.window.resetAt).toBeNull();
  });

  it("exposes only unexpired signals, latest until per instance", () => {
    const store = openStore();
    store.recordQuotaSignal("codex", at(60_000), "limit reached");
    store.recordQuotaSignal("codex", at(120_000), "limit reached again");
    store.recordQuotaSignal("claude", at(10_000));

    expect(store.activeQuotaSignals(at(0))).toEqual([
      { instanceId: "claude", until: at(10_000).toISOString(), error: null },
      { instanceId: "codex", until: at(120_000).toISOString(), error: "limit reached again" },
    ]);
    expect(store.activeQuotaSignals(at(10_000)).map((s) => s.instanceId)).toEqual(["codex"]);
    expect(store.activeQuotaSignals(at(120_000))).toEqual([]);
  });

  it("sets, replaces and expires overrides", () => {
    const store = openStore();
    store.setOverride({
      instanceId: "claude",
      window: "5h",
      usedPct: 90,
      expiresAt: at(1000).toISOString(),
    });
    store.setOverride({
      instanceId: "claude",
      window: "5h",
      usedPct: 95,
      expiresAt: at(2000).toISOString(),
    });
    store.setOverride({
      instanceId: "codex",
      window: "7d",
      usedPct: 10,
      expiresAt: at(500).toISOString(),
    });
    expect(store.listOverrides(at(0)).map((o) => [o.instanceId, o.window, o.usedPct])).toEqual([
      ["claude", "5h", 95],
      ["codex", "7d", 10],
    ]);
    expect(store.listOverrides(at(600)).map((o) => o.instanceId)).toEqual(["claude"]);
    expect(store.listOverrides(at(2000))).toEqual([]);
  });
});

describe("[AC3] leases", () => {
  const alive: IsAlive = () => true;
  const req = (limit: number, now: Date, isAlive = alive) => ({
    pid: 100,
    pidStart: "start-1",
    limit,
    now,
    isAlive,
  });

  it("enforces the per-instance limit and frees slots on release", () => {
    const store = openStore();
    expect(store.acquireLease("codex", "r1", req(2, at(0)))).toBe(true);
    expect(store.acquireLease("codex", "r2", req(2, at(0)))).toBe(true);
    expect(store.acquireLease("codex", "r3", req(2, at(0)))).toBe(false);
    // Other instances have their own budget.
    expect(store.acquireLease("claude", "r4", req(1, at(0)))).toBe(true);
    // Re-acquiring your own lease does not count against the limit.
    expect(store.acquireLease("codex", "r1", req(2, at(1000)))).toBe(true);

    expect(store.releaseLease("r1")).toBe(true);
    expect(store.releaseLease("r1")).toBe(false);
    expect(store.acquireLease("codex", "r3", req(2, at(0)))).toBe(true);
    expect(store.listLeases().map((l) => l.runId)).toEqual(["r2", "r4", "r3"].sort());
  });

  it("respects the limit across two connections", () => {
    const a = openStore();
    const b = openStore();
    expect(a.acquireLease("codex", "r1", req(2, at(0)))).toBe(true);
    expect(b.acquireLease("codex", "r2", req(2, at(0)))).toBe(true);
    expect(a.acquireLease("codex", "r3", req(2, at(0)))).toBe(false);
    expect(b.acquireLease("codex", "r4", req(2, at(0)))).toBe(false);
    b.releaseLease("r1");
    expect(a.acquireLease("codex", "r3", req(2, at(0)))).toBe(true);
    expect(b.listLeases().map((l) => l.runId)).toEqual(["r2", "r3"]);
  });

  it("treats a missed heartbeat window as dead and heartbeat keeps a lease live", () => {
    const store = openStore();
    expect(store.acquireLease("codex", "r1", req(1, at(0)))).toBe(true);
    expect(store.acquireLease("codex", "r2", req(1, at(LEASE_STALE_MS)))).toBe(false);
    expect(store.heartbeat("r1", at(LEASE_STALE_MS))).toBe(true);
    expect(store.acquireLease("codex", "r2", req(1, at(LEASE_STALE_MS + 1000)))).toBe(false);
    // 30 s+ after the last heartbeat the lease is stale and the slot is reclaimed.
    expect(store.acquireLease("codex", "r2", req(1, at(2 * LEASE_STALE_MS + 1)))).toBe(true);
    expect(store.listLeases().map((l) => l.runId)).toEqual(["r2"]);
    expect(store.heartbeat("r1", at(0))).toBe(false);
  });

  it("treats a lease whose process is gone as dead even with a fresh heartbeat", () => {
    const store = openStore();
    expect(store.acquireLease("codex", "r1", req(1, at(0)))).toBe(true);
    const gone = (pid: number, start: string) => !(pid === 100 && start === "start-1");
    expect(store.acquireLease("codex", "r2", req(1, at(1000), gone))).toBe(true);
    // pid reuse: same pid, different start time.
    const reused = (_pid: number, start: string) => start !== "start-1";
    expect(
      store.acquireLease("codex", "r3", { ...req(1, at(2000), reused), pidStart: "start-2" }),
    ).toBe(true);
  });

  it("reaps stale and orphaned leases and reports them", () => {
    const store = openStore();
    store.acquireLease("codex", "fresh", { ...req(5, at(0)), pid: 1 });
    store.acquireLease("codex", "orphan", { ...req(5, at(0)), pid: 2 });
    store.acquireLease("claude", "old", { ...req(5, at(0)), pid: 3 });
    store.heartbeat("fresh", at(LEASE_STALE_MS + 5000));
    store.heartbeat("orphan", at(LEASE_STALE_MS + 5000));

    const reaped = store.reapStaleLeases(at(LEASE_STALE_MS + 6000), (pid) => pid !== 2);
    expect(reaped.map((l) => l.runId).sort()).toEqual(["old", "orphan"]);
    expect(store.listLeases().map((l) => l.runId)).toEqual(["fresh"]);
    expect(store.reapStaleLeases(at(LEASE_STALE_MS + 6000), alive)).toEqual([]);
  });

  it("serializes writers: a held write lock blocks the other connection until commit", () => {
    const dbA = openDb(dbPath);
    const dbB = openDb(dbPath);
    dbB.exec("PRAGMA busy_timeout = 50");
    const a = new SqliteStateStore(dbA, { clock });
    const b = new SqliteStateStore(dbB, { clock });
    let blocked: unknown;
    dbA.transaction(() => {
      a.acquireLease("codex", "ra", req(1, at(0)));
      try {
        b.acquireLease("codex", "rb", req(1, at(0)));
      } catch (err) {
        blocked = err;
      }
    });
    expect(String(blocked)).toMatch(/locked|busy/i);
    // After the commit B sees A's lease and is refused by the limit, not by the lock.
    expect(b.acquireLease("codex", "rb", req(1, at(0)))).toBe(false);
    a.releaseLease("ra");
    expect(b.acquireLease("codex", "rb", req(1, at(0)))).toBe(true);
    a.close();
    b.close();
  });
});

describe("[AC3] idempotency", () => {
  it("returns the first run id for the same key and calls the factory once", () => {
    const store = openStore();
    let calls = 0;
    const factory = () => `run-${++calls}`;
    expect(store.getOrCreateIdempotent("k1", factory)).toEqual({ runId: "run-1", created: true });
    expect(store.getOrCreateIdempotent("k1", factory)).toEqual({ runId: "run-1", created: false });
    expect(store.getOrCreateIdempotent("k2", factory)).toEqual({ runId: "run-2", created: true });
    expect(calls).toBe(2);
  });

  it("is atomic across connections: interleaved callers agree on one run id", () => {
    const a = openStore();
    const b = openStore();
    const ids = new Set<string>();
    let created = 0;
    for (let i = 0; i < 20; i++) {
      for (const s of i % 2 ? [a, b] : [b, a]) {
        const r = s.getOrCreateIdempotent(`key-${Math.floor(i / 2)}`, () => newRunId(clock));
        if (r.created) created++;
        ids.add(`${Math.floor(i / 2)}:${r.runId}`);
      }
    }
    expect(created).toBe(10);
    expect(ids.size).toBe(10);
  });

  it("does not bind a key when the factory throws", () => {
    const store = openStore();
    expect(() =>
      store.getOrCreateIdempotent("k", () => {
        throw new Error("nope");
      }),
    ).toThrow("nope");
    expect(store.getOrCreateIdempotent("k", () => "ok")).toEqual({ runId: "ok", created: true });
  });
});

describe("prune", () => {
  it("deletes only data older than the cutoff and never running runs or leases", async () => {
    const store = openStore();
    const day = 86_400_000;
    const old = new Date(Date.parse(fx.T0) - 40 * day).toISOString();
    const recent = new Date(Date.parse(fx.T0) - 5 * day).toISOString();

    await store.recordRun({
      ...fx.runRecord,
      runId: "old-done",
      status: "completed",
      createdAt: old,
      updatedAt: old,
    });
    await store.recordRun({
      ...fx.runRecord,
      runId: "old-running",
      createdAt: old,
      updatedAt: old,
    });
    await store.recordRun({
      ...fx.runRecord,
      runId: "new-done",
      status: "completed",
      createdAt: recent,
      updatedAt: recent,
    });
    await store.appendEvent("old-done", { kind: "done", ts: old });
    await store.appendEvent("new-done", { kind: "done", ts: recent });
    await store.recordDecision({ ...fx.decisionRecord, id: "d-old", createdAt: old });
    await store.recordDecision({ ...fx.decisionRecord, id: "d-new", createdAt: recent });
    store.recordQuotaReading("claude", window5h({ readAt: old }));
    store.recordQuotaReading("claude", window5h({ kind: "7d", readAt: recent }));
    store.recordQuotaSignal("codex", old);
    store.recordQuotaSignal("claude", at(1000));
    store.setOverride({ instanceId: "claude", window: "5h", usedPct: 1, expiresAt: old });
    store.setOverride({
      instanceId: "claude",
      window: "7d",
      usedPct: 1,
      expiresAt: at(1000).toISOString(),
    });
    store.getOrCreateIdempotent("k-new", () => "r-new");
    store.acquireLease("codex", "old-running", {
      pid: 1,
      pidStart: "s",
      limit: 1,
      now: old,
      isAlive: () => true,
    });
    // Shadow rows are stamped by the clock: record one "old", then one "new".
    clock.set(old);
    store.recordShadow("d-old", "balance", fx.decision);
    clock.set(fx.T0);
    store.recordShadow("d-new", "balance", fx.decision);
    clock.set(old);
    store.getOrCreateIdempotent("k-old", () => "r-old");
    clock.set(fx.T0);

    const counts = store.prune({ olderThanDays: 30, now: fx.T0 });
    expect(counts).toEqual({
      runs: 1,
      decisions: 1,
      shadowDecisions: 1,
      quotaReadings: 1,
      quotaSignals: 1,
      overrides: 1,
      idempotency: 1,
    });
    expect(
      store
        .listRuns()
        .map((r) => r.runId)
        .sort(),
    ).toEqual(["new-done", "old-running"]);
    expect(store.listEvents("old-done")).toEqual([]);
    expect(store.listEvents("new-done")).toHaveLength(1);
    expect((await store.listDecisions(old)).map((d) => d.id)).toEqual(["d-new"]);
    expect(store.listLeases().map((l) => l.runId)).toEqual(["old-running"]);

    // A year later everything finished is gone, running runs still survive.
    const later = store.prune({ olderThanDays: 30, now: new Date(Date.parse(fx.T0) + 365 * day) });
    expect(later.runs).toBe(1);
    expect(later.idempotency).toBe(1);
    expect(store.listRuns().map((r) => r.runId)).toEqual(["old-running"]);
  });
});
