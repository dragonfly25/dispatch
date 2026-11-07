import { describe, expect, it } from "vitest";
import type { ProviderInstance, QuotaWindow } from "../../src/core/contracts.js";
import {
  ESTIMATOR_SOURCE,
  type EstimatorRun,
  estimateWindows,
  runUnits,
} from "../../src/quota/estimator.js";
import {
  DEFAULT_PLANS,
  longestWindowMs,
  mergePlans,
  modelMatches,
  planKey,
  resolvePlan,
} from "../../src/quota/plans.js";
import {
  DEFAULT_READER_TIMEOUT_MS,
  type QuotaReader,
  QuotaReaderRegistry,
  runReader,
} from "../../src/quota/reader.js";
import {
  DEFAULT_RELIABILITY,
  hasRolledOver,
  incoherence,
  isFresh,
  isOld,
} from "../../src/quota/reliability.js";
import * as fx from "../fixtures/contracts.js";

const T0 = new Date(fx.T0);
const iso = (ms: number) => new Date(T0.getTime() + ms).toISOString();
const H = 3_600_000;

const win = (over: Partial<QuotaWindow> = {}): QuotaWindow => ({
  kind: "5h",
  usedPct: 30,
  resetAt: iso(2 * H),
  source: "r",
  readAt: fx.T0,
  reliability: "real",
  ...over,
});

const inst: ProviderInstance = { id: "claude", adapter: "claude", pool: "subscription" };

describe("plans", () => {
  const pro = DEFAULT_PLANS["claude:pro"];
  it("ships the documented plans, with Codex Pro lacking a 5h window", () => {
    expect(Object.keys(DEFAULT_PLANS)).toEqual(
      expect.arrayContaining([
        "claude:pro",
        "claude:max5x",
        "claude:max20x",
        "codex:plus",
        "codex:pro",
        "codex:business",
        "antigravity:pro",
        "antigravity:ultra",
      ]),
    );
    expect(pro?.windows.map((w) => w.kind)).toEqual(["5h", "7d"]);
    expect(DEFAULT_PLANS["codex:pro"]?.windows.map((w) => w.kind)).toEqual(["weekly"]);
    expect(DEFAULT_PLANS["antigravity:pro"]?.windows.map((w) => w.kind)).toContain("weekly:gemini");
  });

  it("resolves declared plans with adapter, alias and case", () => {
    expect(planKey("claude", "max5x")).toBe("claude:max5x");
    expect(planKey("x", "AGY:Pro")).toBe("antigravity:pro");
    expect(resolvePlan(DEFAULT_PLANS, "agy", "pro")?.adapter).toBe("antigravity");
    expect(resolvePlan(DEFAULT_PLANS, "claude", "nope")).toBeUndefined();
    expect(resolvePlan(DEFAULT_PLANS, "claude", undefined)).toBeUndefined();
  });

  it("merges validated config overrides and rejects bad ones", () => {
    const custom = {
      adapter: "claude",
      plan: "pro",
      label: "Mine",
      windows: [{ kind: "5h", durationMs: 1000, capacity: 5 }],
    };
    const merged = mergePlans(DEFAULT_PLANS, { "claude:pro": custom });
    expect(merged["claude:pro"]?.label).toBe("Mine");
    expect(merged["claude:max5x"]).toBe(DEFAULT_PLANS["claude:max5x"]);
    expect(() => mergePlans(DEFAULT_PLANS, { "claude:pro": { adapter: "claude" } })).toThrow();
    expect(longestWindowMs(DEFAULT_PLANS)).toBe(7 * 24 * H);
  });

  it("matches model globs", () => {
    expect(modelMatches(undefined, undefined)).toBe(true);
    expect(modelMatches(["gemini-*"], undefined)).toBe(false);
    expect(modelMatches(["gemini-*"], "Gemini-3-pro")).toBe(true);
    expect(modelMatches(["claude-*", "gpt-*"], "gpt-5.5")).toBe(true);
    expect(modelMatches(["gpt-5.5"], "gpt-5x5")).toBe(false);
  });
});

describe("estimator", () => {
  const run = (over: Partial<EstimatorRun> = {}): EstimatorRun => ({
    at: iso(-H),
    durationMs: 60_000,
    relativeCost: 1,
    ...over,
  });
  const plan = DEFAULT_PLANS["claude:pro"] as NonNullable<(typeof DEFAULT_PLANS)[string]>;
  const opts = { now: T0, isHost: false };

  it("weighs runs by tokens, else by duration, scaled by relative cost, with a floor", () => {
    expect(runUnits(run({ inputTokens: 30_000, outputTokens: 10_000 }))).toBe(4);
    expect(runUnits(run({ inputTokens: 10_000, relativeCost: 3 }))).toBe(3);
    expect(runUnits(run({ durationMs: 120_000 }))).toBe(2);
    expect(runUnits(run({ durationMs: 0 }))).toBe(0.1);
    expect(runUnits(run({ inputTokens: 100, relativeCost: 1 }), { tokensPerUnit: 100 })).toBe(1);
  });

  it("projects runs onto plan windows as estimated usage with a reset", () => {
    const w = estimateWindows(plan, [run({ inputTokens: 40_000 })], opts);
    expect(w).toEqual([
      {
        kind: "5h",
        usedPct: 10,
        resetAt: iso(4 * H),
        source: ESTIMATOR_SOURCE,
        readAt: fx.T0,
        reliability: "estimated",
      },
      expect.objectContaining({ kind: "7d", usedPct: 1, reliability: "estimated" }),
    ]);
  });

  it("returns 0% without reset when no run is in an open window", () => {
    const [w5] = estimateWindows(plan, [run({ at: iso(-6 * H) })], opts);
    expect(w5).toMatchObject({ usedPct: 0, resetAt: null });
    const [e5] = estimateWindows(plan, [], opts);
    expect(e5).toMatchObject({ usedPct: 0, resetAt: null });
  });

  it("opens a new window after the previous one ended and ignores future runs", () => {
    const runs = [
      run({ at: iso(-9 * H), inputTokens: 400_000 }), // old window, closed
      run({ at: iso(-2 * H), inputTokens: 40_000 }),
      run({ at: iso(-1 * H), inputTokens: 40_000 }),
      run({ at: iso(H), inputTokens: 400_000 }), // future
    ];
    const [w5] = estimateWindows(plan, runs, opts);
    expect(w5).toMatchObject({ usedPct: 20, resetAt: iso(3 * H) });
  });

  it("caps at 100%", () => {
    const [w5] = estimateWindows(plan, [run({ inputTokens: 10_000_000 })], opts);
    expect(w5?.usedPct).toBe(100);
  });

  it("splits per model group", () => {
    const agy = DEFAULT_PLANS["antigravity:pro"] as NonNullable<(typeof DEFAULT_PLANS)[string]>;
    const w = estimateWindows(
      agy,
      [run({ model: "gemini-3-pro", inputTokens: 50_000 }), run({ model: "other" })],
      opts,
    );
    const byKind = Object.fromEntries(w.map((x) => [x.kind, x.usedPct]));
    expect(byKind["5h:gemini"]).toBe(10);
    expect(byKind["5h:claude-gpt"]).toBe(0);
  });

  it("never estimates the host", () => {
    expect(estimateWindows(plan, [run()], { now: T0, isHost: true })).toEqual([]);
  });
});

describe("reader helpers", () => {
  const reader = (id: string, read: QuotaReader["read"]): QuotaReader => ({
    id,
    version: "1",
    channel: "test",
    read,
  });

  it("registers readers per adapter and rejects duplicate ids", () => {
    const a = reader("a", async () => []);
    const b = reader("b", async () => []);
    const reg = new QuotaReaderRegistry().register("claude", a).register("codex", b);
    expect(reg.forAdapter("claude")).toEqual([a]);
    expect(reg.forAdapter("none")).toEqual([]);
    expect(reg.all()).toEqual([a, b]);
    expect(() => reg.register("codex", a)).toThrow(/already registered/);
  });

  it("returns windows, passing a signal and the timeout", async () => {
    let seen: unknown;
    const r = reader("ok", async (_i, ctx) => {
      seen = ctx;
      return [win()];
    });
    const out = await runReader(r, inst);
    expect(out).toEqual({ ok: true, windows: [win()] });
    expect(seen).toMatchObject({ timeoutMs: DEFAULT_READER_TIMEOUT_MS });
  });

  it("catches throws, non-Error throws and bad return values", async () => {
    const t = await runReader(
      reader("t", async () => {
        throw new Error("boom");
      }),
      inst,
    );
    expect(t).toEqual({ ok: false, error: "boom", timedOut: false });
    const s = await runReader(
      reader("s", () => {
        throw "plain";
      }),
      inst,
    );
    expect(s).toMatchObject({ ok: false, error: "plain" });
    const n = await runReader(
      reader("n", async () => "x" as unknown as QuotaWindow[]),
      inst,
    );
    expect(n).toMatchObject({ ok: false, error: "reader returned a non-array" });
  });

  it("times out a hanging reader and aborts its signal", async () => {
    let aborted = false;
    const r = reader("hang", (_i, ctx) => {
      ctx?.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return new Promise<QuotaWindow[]>(() => {});
    });
    const out = await runReader(r, inst, 20);
    expect(out).toMatchObject({ ok: false, timedOut: true });
    expect(aborted).toBe(true);
  });
});

describe("reliability", () => {
  const cfg = DEFAULT_RELIABILITY;
  it("tells fresh from old by cache minutes and factor", () => {
    const at = (min: number) => new Date(T0.getTime() + min * 60_000);
    expect(isFresh(win(), at(5), cfg)).toBe(true);
    expect(isFresh(win(), at(6), cfg)).toBe(false);
    expect(isOld(win(), at(15), cfg)).toBe(false);
    expect(isOld(win(), at(16), cfg)).toBe(true);
    expect(isOld(win(), at(16), { ...cfg, cacheMinutes: 10 })).toBe(false);
  });

  it("treats a passed reset as rolled over, and so as not fresh", () => {
    expect(hasRolledOver(win({ resetAt: null }), T0)).toBe(false);
    expect(hasRolledOver(win({ resetAt: iso(-1) }), T0)).toBe(true);
    expect(isFresh(win({ resetAt: iso(-1) }), T0, cfg)).toBe(false);
  });

  it("flags incoherent readings", () => {
    expect(incoherence(win(), null, cfg)).toBeNull();
    expect(incoherence(win({ usedPct: 120 }), null, cfg)).toMatch(/out of range/);
    expect(incoherence(win({ usedPct: -1 }), null, cfg)).toMatch(/out of range/);
    expect(incoherence(win({ usedPct: null }), null, cfg)).toMatch(/no used percentage/);
    expect(incoherence(win({ resetAt: null }), null, cfg)).toMatch(/missing reset/);
    expect(incoherence(win({ usedPct: 0, resetAt: null }), null, cfg)).toBeNull();
    expect(incoherence(win({ usedPct: 0 }), 19.9, cfg)).toBeNull();
    expect(incoherence(win({ usedPct: 0 }), 20, cfg)).toMatch(/0% used while the estimator/);
    expect(incoherence(win({ usedPct: 5 }), 90, cfg)).toBeNull();
  });
});
