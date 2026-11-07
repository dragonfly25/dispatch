import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type InstanceQuota,
  type ProviderInstance,
  type QuotaSnapshot,
  QuotaSnapshotSchema,
  type QuotaWindow,
  type RunRecord,
  type RunResult,
} from "../../src/core/contracts.js";
import {
  ANY_WINDOW,
  DefaultQuotaProvider,
  type DefaultQuotaProviderOptions,
  MANUAL_SOURCE,
  UNKNOWN_KIND,
} from "../../src/quota/provider.js";
import { type QuotaReader, QuotaReaderRegistry } from "../../src/quota/reader.js";
import { SqliteStateStore } from "../../src/state/store.js";
import * as fx from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";

const MIN = 60_000;
const H = 3_600_000;
const at = (clock: FakeClock, ms: number) => new Date(clock.now().getTime() + ms).toISOString();

let dir: string;
let clock: FakeClock;
let store: SqliteStateStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-quota-"));
  clock = new FakeClock(fx.T0);
  store = SqliteStateStore.open(join(dir, "state", "dispatch.db"), { clock });
});
afterEach(async () => {
  store.close();
  await rm(dir, { recursive: true, force: true });
});

const claude: ProviderInstance = { id: "claude", adapter: "claude", pool: "subscription" };
const codex: ProviderInstance = { id: "codex", adapter: "codex", pool: "subscription" };
const agy: ProviderInstance = { id: "agy", adapter: "antigravity", pool: "unknown" };
const bare: ProviderInstance = { id: "bare", adapter: "fake", pool: "api_credit" };

/** A scripted reader; `script` is consumed one call at a time (last entry repeats). */
function fakeReader(
  id: string,
  script: Array<(clock: FakeClock) => QuotaWindow[] | Error | "hang">,
): QuotaReader & { calls: number } {
  const reader = {
    id,
    version: "1.0",
    channel: "test",
    calls: 0,
    async read() {
      const step = script[Math.min(reader.calls, script.length - 1)];
      reader.calls++;
      const out = step?.(clock) ?? [];
      if (out === "hang") return new Promise<QuotaWindow[]>(() => {});
      if (out instanceof Error) throw out;
      return out;
    },
  };
  return reader;
}

const reading = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  kind: "5h",
  usedPct: 30,
  resetAt: at(clock, 2 * H),
  source: "test-reader",
  readAt: clock.now().toISOString(),
  reliability: "real",
  ...over,
});

function make(
  over: Partial<DefaultQuotaProviderOptions> = {},
  readers: Array<[string, QuotaReader]> = [],
) {
  const registry = new QuotaReaderRegistry();
  for (const [adapter, r] of readers) registry.register(adapter, r);
  return new DefaultQuotaProvider({
    store,
    clock,
    readers: registry,
    readerTimeoutMs: 50,
    instancePlans: { claude: "pro", codex: "codex:plus", agy: "agy:pro" },
    ...over,
  });
}

async function snap(
  p: DefaultQuotaProvider,
  instances: ProviderInstance[],
  hostInstanceId?: string | null,
): Promise<QuotaSnapshot> {
  const s = await p.snapshot(instances, hostInstanceId === undefined ? {} : { hostInstanceId });
  return QuotaSnapshotSchema.parse(s);
}

const win = (q: QuotaSnapshot, id: string, kind: string): QuotaWindow => {
  const w = q.instances[id]?.windows.find((x) => x.kind === kind);
  if (!w) throw new Error(`no window ${id}/${kind}`);
  return w;
};

/** Stores a finished delegated run (as `dispatch run` would). */
async function delegated(
  id: string,
  over: {
    instance?: string;
    model?: string;
    createdAt?: string;
    inputTokens?: number;
    durationMs?: number;
    status?: RunRecord["status"];
    result?: RunResult | null;
  } = {},
): Promise<void> {
  const instance = over.instance ?? "claude";
  const result: RunResult | null =
    over.result === undefined
      ? {
          ...fx.runResult,
          runId: id,
          externalAgent: {
            provider: instance,
            instance,
            model: over.model ?? "claude-sonnet",
            marker: "EXTERNAL_AGENT_OUTPUT",
          },
          decisions: [
            {
              ...fx.decision,
              targets: [
                { instance, tier: "max", model: over.model ?? "claude-sonnet", effort: "high" },
              ],
            },
          ],
          usage: over.inputTokens === undefined ? undefined : { inputTokens: over.inputTokens },
          durationMs: over.durationMs ?? 60_000,
        }
      : over.result;
  await store.recordRun({
    runId: id,
    status: over.status ?? "completed",
    createdAt: over.createdAt ?? at(clock, -H),
    updatedAt: over.createdAt ?? at(clock, -H),
    instance,
    pid: null,
    result,
  });
}

describe("ladder: override > real > stale > estimate > unknown [UC4]", () => {
  it("shows unknown with a placeholder window when nothing is known", async () => {
    const q = await snap(make(), [bare]);
    expect(q.instances.bare).toEqual({
      windows: [
        {
          kind: UNKNOWN_KIND,
          usedPct: null,
          resetAt: null,
          source: "none",
          readAt: fx.T0,
          reliability: "unknown",
        },
      ],
      pool: "api_credit",
    });
  });

  it("estimates plan windows from recorded runs when there is no real reading", async () => {
    await delegated("r1", { inputTokens: 40_000 });
    const q = await snap(make(), [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({
      usedPct: 10,
      resetAt: at(clock, 4 * H),
      source: "estimator",
      reliability: "estimated",
    });
    expect(win(q, "claude", "7d")).toMatchObject({ usedPct: 1, reliability: "estimated" });
  });

  it("prefers a fresh real reading to the estimate, keeps other kinds estimated", async () => {
    await delegated("r1", { inputTokens: 40_000 });
    const reader = fakeReader("claude-passive", [() => [reading({ usedPct: 55 })]]);
    const q = await snap(make({}, [["claude", reader]]), [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 55, reliability: "real" });
    expect(win(q, "claude", "7d").reliability).toBe("estimated");
  });

  it("lets a manual override win over everything, until it expires", async () => {
    const reader = fakeReader("claude-passive", [() => [reading({ usedPct: 55 })]]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    const o = p.setOverride("claude", 40, { ttlMs: 30 * MIN });
    expect(o).toMatchObject({ window: ANY_WINDOW, usedPct: 40 });

    let q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({
      usedPct: 40,
      source: MANUAL_SOURCE,
      reliability: "real",
      resetAt: at(clock, 2 * H), // keeps the underlying reset
    });
    expect(win(q, "claude", "7d")).toMatchObject({ usedPct: 40, source: MANUAL_SOURCE });

    clock.advance(31 * MIN);
    q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ source: "test-reader" });
    expect(win(q, "claude", "7d").source).toBe("estimator");
  });

  it("applies a window-specific override over the wildcard and can clear it", async () => {
    const p = make();
    p.setOverride("claude", 10);
    p.setOverride("claude", 90, { window: "5h" });
    let q = await snap(p, [claude]);
    expect(win(q, "claude", "5h").usedPct).toBe(90);
    expect(win(q, "claude", "7d").usedPct).toBe(10);
    p.clearOverride("claude", "5h");
    p.clearOverride("claude");
    q = await snap(p, [claude]);
    expect(win(q, "claude", "5h").source).toBe("estimator");
    expect(() => p.setOverride("claude", 101)).toThrow(RangeError);
    expect(() => p.setOverride("claude", Number.NaN)).toThrow(RangeError);
  });

  it("adds override-only kinds and uses the placeholder for a wildcard on unknown instances", async () => {
    const p = make();
    p.setOverride("bare", 25, { expiresAt: new Date(clock.now().getTime() + H) });
    p.setOverride("claude", 33, { window: "monthly" });
    const q = await snap(p, [bare, claude]);
    expect(q.instances.bare?.windows).toMatchObject([{ kind: UNKNOWN_KIND, usedPct: 25 }]);
    expect(q.instances.claude?.windows.map((w) => w.kind)).toEqual(["5h", "7d", "monthly"]);
    expect(win(q, "claude", "monthly")).toMatchObject({ usedPct: 33, resetAt: null });
  });

  it("returns reading kinds beyond the plan, sorted after plan kinds", async () => {
    const reader = fakeReader("r", [() => [reading({ kind: "zz" }), reading({ kind: "aa" })]]);
    const q = await snap(make({}, [["claude", reader]]), [claude]);
    expect(q.instances.claude?.windows.map((w) => w.kind)).toEqual(["5h", "7d", "aa", "zz"]);
  });

  it("resolves bare plan names and aliases per adapter, and ignores unknown plans", async () => {
    const q = await snap(make({ instancePlans: { codex: "plus", agy: "pro", bare: "nope" } }), [
      codex,
      agy,
      bare,
    ]);
    expect(q.instances.codex?.windows.map((w) => w.kind)).toEqual(["5h", "weekly"]);
    expect(q.instances.agy?.windows.map((w) => w.kind)).toContain("weekly:claude-gpt");
    expect(q.instances.bare?.windows[0]?.kind).toBe(UNKNOWN_KIND);
  });

  it("accepts config plan overrides", async () => {
    const plans = {
      "claude:pro": {
        adapter: "claude",
        plan: "pro",
        label: "Tiny",
        windows: [{ kind: "5h", durationMs: 5 * H, capacity: 4 }],
      },
    };
    await delegated("r1", { inputTokens: 40_000 });
    const q = await snap(make({ plans }), [claude]);
    expect(q.instances.claude?.windows).toHaveLength(1);
    expect(win(q, "claude", "5h").usedPct).toBe(100);
  });
});

describe("estimator inputs from recorded runs", () => {
  it("counts fanout children, running runs and tier cost; skips rejected and host-returned runs", async () => {
    const child = (instance: string): RunResult => ({
      ...fx.runResult,
      externalAgent: { provider: instance, instance, model: "m", marker: "EXTERNAL_AGENT_OUTPUT" },
      decisions: [],
      usage: { inputTokens: 20_000 },
    });
    await delegated("fan", {
      result: { ...fx.fanoutResult, results: [child("claude"), child("claude"), child("codex")] },
    });
    await delegated("run", { status: "running", result: null, createdAt: at(clock, -30 * MIN) });
    await delegated("rej", { status: "rejected", result: null });
    await delegated("host", { result: { ...fx.runResult, externalAgent: null } });
    await delegated("noout", { result: { ...fx.runResult, externalAgent: null, outcome: null } });
    const costs: unknown[] = [];
    const p = make({
      relativeCost: (c) => {
        costs.push(c);
        return 1;
      },
    });
    const q = await snap(p, [claude, codex]);
    // claude: 2 children x 2 units + running 30 min x 1 = 34 units of 40 -> 85%
    expect(win(q, "claude", "5h").usedPct).toBe(85);
    // codex: 2 units of 60
    expect(win(q, "codex", "5h").usedPct).toBe(3.3);
    expect(costs).toContainEqual({ instanceId: "claude" });
  });

  it("passes model and tier to the relative-cost callback", async () => {
    await delegated("r1", { inputTokens: 10_000, model: "claude-opus" });
    const p = make({
      relativeCost: (c) => (c.tier === "max" && c.model === "claude-opus" ? 4 : 1),
    });
    const q = await snap(p, [claude]);
    expect(win(q, "claude", "5h").usedPct).toBe(10);
  });

  it("ignores runs older than twice the longest window", async () => {
    await delegated("old", { createdAt: at(clock, -30 * 24 * H), inputTokens: 1_000_000 });
    const q = await snap(make(), [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 0, reliability: "estimated" });
  });
});

describe("cache and staleness", () => {
  it("re-reads only when the newest reading is older than cacheMinutes", async () => {
    const reader = fakeReader("r", [() => [reading({ readAt: clock.now().toISOString() })]]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    expect(reader.calls).toBe(1);
    clock.advance(4 * MIN);
    await snap(p, [claude]);
    expect(reader.calls).toBe(1);
    clock.advance(2 * MIN);
    await snap(p, [claude]);
    expect(reader.calls).toBe(2);
  });

  it("honours a configured cacheMinutes", async () => {
    const reader = fakeReader("r", [() => [reading()]]);
    const p = make({ reliability: { cacheMinutes: 30 } }, [["claude", reader]]);
    await snap(p, [claude]);
    clock.advance(20 * MIN);
    await snap(p, [claude]);
    expect(reader.calls).toBe(1);
  });

  it("re-reads when the cached window has rolled over, and drops the old value", async () => {
    const reader = fakeReader("r", [
      () => [reading({ resetAt: at(clock, 10 * MIN), usedPct: 80 })],
      () => new Error("down"),
    ]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    clock.advance(11 * MIN);
    const q = await snap(p, [claude]);
    expect(reader.calls).toBe(2);
    // The 80% belongs to a finished window: fall back to the estimate, not a stale 80%.
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 0, reliability: "estimated" });
  });

  it("keeps the last good value as stale, with its timestamp, when the reader fails", async () => {
    const t0 = clock.now().toISOString();
    const reader = fakeReader("r", [() => [reading({ usedPct: 42 })], () => new Error("down")]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    clock.advance(6 * MIN);
    const q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({
      usedPct: 42,
      readAt: t0,
      reliability: "stale",
      source: "test-reader",
    });
    expect(p.readerHealth("claude")).toMatchObject([{ readerId: "r", ok: false, error: "down" }]);
  });

  it("marks a reading older than cacheMinutes x factor stale even without a failed read", async () => {
    const reader = fakeReader("r", [() => [reading({ usedPct: 20 })]]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    // Cached reading is old; the reader still answers, but with an old readAt (passive channel).
    clock.advance(30 * MIN);
    const old = reading({ usedPct: 25, readAt: at(clock, -20 * MIN), resetAt: at(clock, H) });
    const r2 = fakeReader("r2", [() => [old]]);
    const p2 = make({}, [["claude", r2]]);
    const q = await snap(p2, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 25, reliability: "stale" });
  });

  it("reports a recent stored reading as real when readers are disabled", async () => {
    const reader = fakeReader("r", [() => [reading({ usedPct: 20 })]]);
    await snap(make({}, [["claude", reader]]), [claude]);
    clock.advance(6 * MIN);
    const q = await snap(make({ disabledReaders: "all" }, [["claude", reader]]), [claude]);
    expect(win(q, "claude", "5h").reliability).toBe("real");
    clock.advance(10 * MIN);
    expect(
      win(await snap(make({ disabledReaders: "all" }), [claude]), "claude", "5h"),
    ).toMatchObject({
      reliability: "stale",
      usedPct: 20,
    });
  });
});

describe("incoherent readings", () => {
  it("0% while the estimator shows use -> stale, last good value kept, bad one not stored", async () => {
    const good = clock.now().toISOString();
    const reader = fakeReader("r", [
      () => [reading({ usedPct: 10 })],
      () => [reading({ usedPct: 0 })],
    ]);
    await delegated("r1", { inputTokens: 200_000 }); // 20 units of 40 = 50%
    const p = make({}, [["claude", reader]]);
    let q = await snap(p, [claude]);
    expect(win(q, "claude", "5h").reliability).toBe("real");
    clock.advance(6 * MIN);
    q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({
      usedPct: 10,
      readAt: good,
      reliability: "stale",
    });
    expect(store.latestQuotaReadings().map((r) => r.window.usedPct)).toEqual([10]);
    expect(
      p.readerHealth("claude").some((h) => /0% used while the estimator/.test(h.error ?? "")),
    ).toBe(true);
  });

  it.each([
    ["out of range", { usedPct: 140 }],
    ["missing reset", { resetAt: null }],
    ["no value", { usedPct: null }],
    ["not real", { reliability: "estimated" as const }],
  ])("%s -> stale, previous good reading kept", async (_name, bad) => {
    const reader = fakeReader("r", [() => [reading({ usedPct: 12 })], () => [reading(bad)]]);
    const p = make({}, [["claude", reader]]);
    await snap(p, [claude]);
    clock.advance(6 * MIN);
    const q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 12, reliability: "stale" });
  });

  it("an incoherent first reading falls back to the estimate", async () => {
    const reader = fakeReader("r", [() => [reading({ usedPct: 300 })]]);
    const q = await snap(make({}, [["claude", reader]]), [claude]);
    expect(win(q, "claude", "5h").reliability).toBe("estimated");
    expect(store.latestQuotaReadings()).toEqual([]);
  });
});

describe("host is never estimated [spec 8]", () => {
  it("is unknown without a real reading, even with recorded runs", async () => {
    await delegated("r1", { inputTokens: 200_000 });
    const q = await snap(make(), [claude], "claude");
    expect(q.instances.claude?.windows).toMatchObject([
      { kind: "5h", usedPct: null, reliability: "unknown" },
      { kind: "7d", usedPct: null, reliability: "unknown" },
    ]);
  });

  it("uses real readings for the host, and the constructor default host", async () => {
    const reader = fakeReader("r", [() => [reading({ usedPct: 61 })]]);
    const p = make({ hostInstanceId: "claude" }, [["claude", reader]]);
    await delegated("r1", { inputTokens: 200_000 });
    const q = await snap(p, [claude]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 61, reliability: "real" });
    expect(win(q, "claude", "7d").reliability).toBe("unknown");
    // an explicit null host re-enables estimates for the same instance
    const q2 = await snap(make(), [claude], null);
    expect(win(q2, "claude", "7d").reliability).toBe("estimated");
  });

  it("does not use the estimator to judge the host's readings coherent or not", async () => {
    await delegated("r1", { inputTokens: 200_000 });
    const reader = fakeReader("r", [() => [reading({ usedPct: 0 })]]);
    const q = await snap(make({}, [["claude", reader]]), [claude], "claude");
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 0, reliability: "real" });
  });
});

describe("quota_exhausted signals [UC4]", () => {
  const exhausted = (over: Partial<{ resetAt: string | null; error: string }> = {}) => ({
    instanceId: "codex",
    at: clock.now().toISOString(),
    exhausted: { resetAt: at(clock, 3 * H), error: "usage limit", ...over },
  });

  it("marks the instance unavailable until the announced reset, then expires", async () => {
    const p = make();
    await p.recordObservation(exhausted());
    let q = await snap(p, [codex, claude]);
    expect(q.instances.codex).toMatchObject({
      unavailableUntil: at(clock, 3 * H),
      lastQuotaError: "usage limit",
    });
    expect(q.instances.claude?.unavailableUntil).toBeUndefined();
    clock.advance(3 * H + 1);
    q = await snap(p, [codex]);
    expect(q.instances.codex?.unavailableUntil).toBeUndefined();
    expect(q.instances.codex?.lastQuotaError).toBeUndefined();
  });

  it("[UC4] shows two exhausted providers unavailable at once", async () => {
    const p = make();
    await p.recordObservation(exhausted());
    await p.recordObservation({ ...exhausted({ resetAt: null }), instanceId: "agy" });
    const q = await snap(p, [codex, agy, claude]);
    expect(q.instances.codex?.unavailableUntil).toBeDefined();
    expect(q.instances.agy?.unavailableUntil).toBeDefined();
    expect(q.instances.claude?.unavailableUntil).toBeUndefined();
  });

  it("falls back to now + 1h when no reset is known or estimable", async () => {
    const p = make();
    await p.recordObservation({ ...exhausted({ resetAt: null }), instanceId: "bare" });
    const q = await snap(p, [bare]);
    expect(q.instances.bare?.unavailableUntil).toBe(at(clock, H));
  });

  it("uses a configured fallback duration", async () => {
    const p = make({ fallbackUnavailableMs: 10 * MIN });
    await p.recordObservation({ ...exhausted({ resetAt: null }), instanceId: "bare" });
    expect((await snap(p, [bare])).instances.bare?.unavailableUntil).toBe(at(clock, 10 * MIN));
  });

  it("estimates the reset from the windows that look exhausted, else the nearest reset", async () => {
    const p = make();
    await p.recordObservation({
      instanceId: "codex",
      at: clock.now().toISOString(),
      window: reading({ kind: "5h", usedPct: 30, resetAt: at(clock, 2 * H) }),
    });
    await p.recordObservation({
      instanceId: "codex",
      at: clock.now().toISOString(),
      window: reading({ kind: "weekly", usedPct: 97, resetAt: at(clock, 50 * H) }),
    });
    await p.recordObservation(exhausted({ resetAt: null }));
    expect((await snap(p, [codex])).instances.codex?.unavailableUntil).toBe(at(clock, 50 * H));
  });

  it("estimates the reset from the estimator's open window when nothing was read", async () => {
    await delegated("c1", { instance: "codex", createdAt: at(clock, -H), inputTokens: 10_000 });
    const p = make();
    await p.recordObservation(exhausted({ resetAt: null }));
    expect((await snap(p, [codex])).instances.codex?.unavailableUntil).toBe(at(clock, 4 * H));
  });

  it("estimates with a bare plan name by unique suffix, not when ambiguous or unknown", async () => {
    const ids = ["c1", "c2", "c3"];
    for (const instance of ids) {
      await delegated(`run-${instance}`, {
        instance,
        createdAt: at(clock, -H),
        inputTokens: 10_000,
      });
    }
    // "pro" matches claude:pro, codex:pro and antigravity:pro; "gold" matches nothing
    const p = make({ instancePlans: { c1: "business", c2: "pro", c3: "gold" } });
    for (const instanceId of ids) {
      await p.recordObservation({ ...exhausted({ resetAt: null }), instanceId });
    }
    const q = await snap(
      p,
      ids.map((id) => ({ id, adapter: "codex", pool: "subscription" as const })),
    );
    expect(q.instances.c1?.unavailableUntil).toBe(at(clock, 4 * H));
    expect(q.instances.c2?.unavailableUntil).toBe(at(clock, H));
    expect(q.instances.c3?.unavailableUntil).toBe(at(clock, H));
  });

  it("never estimates the host's reset from its own runs", async () => {
    await delegated("c1", { instance: "codex", createdAt: at(clock, -H), inputTokens: 10_000 });
    const p = make({ hostInstanceId: "codex" });
    await p.recordObservation(exhausted({ resetAt: null }));
    expect((await snap(p, [codex])).instances.codex?.unavailableUntil).toBe(at(clock, H));
  });

  it("ignores a reset in the past and clamps absurdly distant ones", async () => {
    const p = make();
    await p.recordObservation(exhausted({ resetAt: at(clock, -H) }));
    expect((await snap(p, [codex])).instances.codex?.unavailableUntil).toBe(at(clock, H));
    await p.recordObservation({
      ...exhausted({ resetAt: "2099-01-01T00:00:00.000Z" }),
      instanceId: "claude",
    });
    expect((await snap(p, [claude])).instances.claude?.unavailableUntil).toBe(
      at(clock, 8 * 24 * H),
    );
  });

  it("the latest announced availability wins when signals pile up", async () => {
    const p = make();
    await p.recordObservation(exhausted({ resetAt: at(clock, 5 * H) }));
    await p.recordObservation(exhausted({ resetAt: at(clock, 2 * H) }));
    expect((await snap(p, [codex])).instances.codex?.unavailableUntil).toBe(at(clock, 5 * H));
  });
});

describe("recordObservation readings", () => {
  it("persists coherent real readings, which then surface as real", async () => {
    const p = make();
    await p.recordObservation({
      instanceId: "claude",
      at: clock.now().toISOString(),
      window: reading({ usedPct: 71 }),
    });
    expect(win(await snap(p, [claude]), "claude", "5h")).toMatchObject({
      usedPct: 71,
      reliability: "real",
    });
  });

  it("drops incoherent or non-real windows", async () => {
    const p = make();
    for (const w of [
      reading({ usedPct: 101 }),
      reading({ resetAt: null }),
      reading({ reliability: "estimated" }),
    ]) {
      await p.recordObservation({ instanceId: "claude", at: clock.now().toISOString(), window: w });
    }
    expect(store.latestQuotaReadings()).toEqual([]);
  });
});

describe("reader failures never break the snapshot [UC11]", () => {
  it("survives a throwing reader, a hanging reader and a good one side by side", async () => {
    await delegated("c1", { instance: "codex", inputTokens: 10_000 });
    const boom = fakeReader("boom", [() => new Error("exploded")]);
    const hang = fakeReader("hang", [() => "hang"]);
    const ok = fakeReader("ok", [() => [reading({ usedPct: 7 })]]);
    const p = make({}, [
      ["claude", boom],
      ["codex", hang],
      ["antigravity", ok],
    ]);
    const started = Date.now();
    const q = await snap(p, [claude, codex, agy]);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(win(q, "claude", "5h").reliability).toBe("estimated");
    expect(win(q, "codex", "5h")).toMatchObject({ reliability: "estimated", usedPct: 1.7 });
    expect(win(q, "agy", "5h")).toMatchObject({ usedPct: 7, reliability: "real" });
    const health = p.readerHealth().map((h) => [h.readerId, h.ok, h.error]);
    expect(health.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
      ["boom", false, "exploded"],
      ["hang", false, "timed out after 50 ms"],
      ["ok", true, undefined],
    ]);
  });

  it("with several readers on one adapter, merges windows (newest wins) and tolerates one failing", async () => {
    const a = fakeReader("a", [() => [reading({ usedPct: 10, readAt: at(clock, -2 * MIN) })]]);
    const b = fakeReader("b", [() => [reading({ usedPct: 20, readAt: at(clock, -1 * MIN) })]]);
    const c = fakeReader("c", [() => new Error("x")]);
    const q = await snap(
      make({}, [
        ["claude", a],
        ["claude", b],
        ["claude", c],
      ]),
      [claude],
    );
    expect(win(q, "claude", "5h").usedPct).toBe(20);
  });

  it("lists no health before any read", () => {
    expect(make().readerHealth()).toEqual([]);
    expect(make().readerHealth("nobody")).toEqual([]);
  });
});

describe("all readers disabled [AC4]", () => {
  const registered = () => fakeReader("r", [() => [reading({ usedPct: 99 })]]);

  it.each([
    ["all", "all" as const],
    ["by id", ["r"]],
  ])("still returns a valid snapshot (%s)", async (_n, disabled) => {
    const r = registered();
    await delegated("r1", { inputTokens: 40_000 });
    const p = make({ disabledReaders: disabled }, [["claude", r]]);
    const q = await snap(p, [claude, codex, agy, bare]);
    expect(r.calls).toBe(0);
    expect(Object.keys(q.instances)).toEqual(["claude", "codex", "agy", "bare"]);
    expect(win(q, "claude", "5h")).toMatchObject({ usedPct: 10, reliability: "estimated" });
    expect(win(q, "codex", "5h").reliability).toBe("estimated");
    expect(win(q, "bare", UNKNOWN_KIND).reliability).toBe("unknown");
    // every window is either estimated or unknown
    const all = Object.values(q.instances as Record<string, InstanceQuota>).flatMap(
      (i) => i.windows,
    );
    expect(all.every((w) => w.reliability === "estimated" || w.reliability === "unknown")).toBe(
      true,
    );
  });

  it("works with no registry at all and an explicit now", async () => {
    const p = new DefaultQuotaProvider({ store, clock });
    const now = new Date("2026-03-03T03:03:03.000Z");
    const q = await p.snapshot([bare], { now });
    expect(q.takenAt).toBe(now.toISOString());
  });
});

describe("determinism", () => {
  it("gives identical snapshots for identical inputs and clock", async () => {
    await delegated("r1", { inputTokens: 40_000 });
    const p = make();
    expect(await snap(p, [claude, codex])).toEqual(await snap(p, [claude, codex]));
  });
});
