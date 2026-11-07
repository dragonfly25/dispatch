import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Decision, DecisionRecord } from "../../../src/core/contracts.js";
import {
  type CompareResult,
  compareFromStore,
  compareProfiles,
  plannedTargets,
  relativeCostModel,
  renderCompare,
} from "../../../src/shadow/index.js";
import { makeConfig } from "../router/fixtures.js";
import { at, runFor, seedDecision, seedInput, type TempStore, tempStore } from "./helpers.js";

let t: TempStore;
beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.close();
});

const N = 20;

/** 20 decisions (real: balance, shadow: preserve); some have run history. */
async function seed(): Promise<void> {
  for (let i = 0; i < N; i++) {
    const runId = i < 6 ? `run${i}` : null;
    await seedDecision(t.store, i, {}, ["preserve"], runId);
  }
  // run0 belongs to a host-kept decision (not observable); run4: first target served it; run1: second target; run2: all fell through; others unknown.
  await t.store.recordRun(runFor("run0", "codex"));
  await t.store.recordRun(runFor("run1", "agy"));
  await t.store.recordRun(runFor("run2", null));
  await t.store.recordRun(runFor("run3", "codex", "running"));
  await t.store.recordRun(runFor("run4", "codex")); // served by the first target: no fall-through
}

const compare = (w: { since?: string; until?: string } = {}) => compareFromStore(t.store, w);
const stats = (r: CompareResult, profile: string) => {
  const p = r.profiles.find((x) => x.profile === profile);
  if (!p) throw new Error(`no profile ${profile}`);
  return p;
};

describe("[UC8] status --compare on a seeded set of recorded decisions", () => {
  it("renders the per-profile table (snapshot)", async () => {
    await seed();
    const r = await compare();
    expect(renderCompare(r)).toMatchSnapshot();
    expect(r.profiles.map((p) => p.profile)).toEqual(["balance", "preserve"]);
  });

  it("counts follow the data and every figure is labelled estimated", async () => {
    await seed();
    const r = await compare();
    const bal = stats(r, "balance");
    const pre = stats(r, "preserve");
    expect(r.decisions).toBe(N);
    expect(bal.tasks.value).toBe(N);
    expect(pre.tasks.value).toBe(N);
    expect(bal.realTasks.value).toBe(N);
    expect(pre.realTasks.value).toBe(0);
    for (const p of [bal, pre]) {
      expect(p.delegated.value + p.hostKept.value + p.rejected.value).toBe(N);
      expect(p.instances.reduce((n, i) => n + i.delegated.value, 0)).toBeGreaterThan(0);
    }
    // t0, t7, t14 touch db/migrations (host); t11 touches secrets (reject) -- in both profiles.
    expect(bal.hostKept.value).toBe(3);
    expect(bal.rejected.value).toBe(1);
    // Fallback mode only in the balance profile (preserve is provider/fanout).
    expect(bal.fallbackMode.value).toBeGreaterThan(0);
    expect(pre.fallbackMode.value).toBe(0);
    // Fell-through is observable only for the profile that ran for real.
    expect(pre.fellThrough).toBeNull();
    expect(bal.fellThrough?.estimated).toBe(true);

    const all = JSON.stringify(r);
    const figures = all.match(/"value":/g)?.length ?? 0;
    const labels = all.match(/"value":-?[\d.]+,"estimated":true/g)?.length ?? 0;
    expect(figures).toBeGreaterThan(0);
    expect(labels).toBe(figures);
    expect(r.estimated).toBe(true);
    expect(r.hostConsumption).toBe("not observable");
  });

  it("reports real fall-throughs from the run history", async () => {
    await seed();
    const bal = stats(await compare(), "balance");
    // run0 -> index 0 (0), run1 served by agy: codex fell through (>=1), run2 returned to host (all).
    const d1 = (await t.store.listDecisions(at(0))).find((d) => d.id === "d1");
    const d2 = (await t.store.listDecisions(at(0))).find((d) => d.id === "d2");
    const idx = d1?.decision.targets.findIndex((x) => x.instance === "agy") ?? -1;
    const expected = Math.max(idx, 0) + (d2?.decision.targets.length ?? 0);
    expect(bal.fellThrough?.observedRuns).toBe(3);
    expect(bal.fellThrough?.value).toBe(expected);
  });

  it("is data-driven: changing one stored row changes the output", async () => {
    await seed();
    const before = renderCompare(await compare());

    // Replace one shadow row with a different decision.
    const [row] = t.store.listShadow(at(-1)).filter((s) => s.decisionId === "d3");
    const swapped: Decision = {
      ...(row as { decision: Decision }).decision,
      action: "reject",
      targets: [],
      mode: "single",
    };
    t.store.recordShadow("d3", "preserve", swapped);
    const after = renderCompare(await compare());
    expect(after).not.toBe(before);
    expect(stats(await compare(), "preserve").rejected.value).toBe(2);

    // And a stored cost changes the cost column.
    const costly = renderCompare(
      await compareFromStore(t.store, {
        costModel: (input, target) => relativeCostModel(input, target) && 100,
      }),
    );
    expect(costly).not.toBe(after);
  });

  it("honours the since/until window (since inclusive, until exclusive)", async () => {
    await seed();
    const r = await compare({ since: at(5), until: at(10) });
    expect(r.decisions).toBe(5);
    expect(stats(r, "balance").tasks.value).toBe(5);
    expect(stats(r, "preserve").tasks.value).toBe(5);
    expect(renderCompare(r)).toContain(`${at(5)} to ${at(10)}`);
    expect((await compare({ until: at(1) })).decisions).toBe(1);
    expect((await compare({ since: at(100) })).empty).toBe(true);
  });

  it("an empty store says 'no recorded decisions' and invents no numbers", async () => {
    const r = await compare();
    expect(r).toMatchObject({
      empty: true,
      message: "no recorded decisions",
      decisions: 0,
      profiles: [],
      hostConsumption: "not observable",
    });
    const text = renderCompare(r);
    expect(text).toContain("no recorded decisions");
    expect(text).not.toMatch(/delegated|rel\.cost/);
  });

  it("nothing executes: no runs are created and shadow code never reaches the runner", async () => {
    await seed();
    const runsBefore = t.store.listRuns().length;
    await compare();
    expect(t.store.listRuns().length).toBe(runsBefore);

    const dir = join(process.cwd(), "src", "shadow");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      expect(src, f).not.toMatch(/child_process|\.\.\/runner|Spawner/);
    }
  });
});

describe("compareProfiles edge cases", () => {
  const rec = (i: number, over: Partial<DecisionRecord> = {}): DecisionRecord => {
    const input = seedInput(i);
    return {
      id: `x${i}`,
      createdAt: at(i),
      runId: null,
      input,
      decision: {
        action: "delegate",
        mode: "single",
        targets: [{ instance: "codex", tier: "balanced", model: "gpt-5", effort: "medium" }],
        chain: [],
        inputHash: "h",
        reason: "r",
      },
      ...over,
    };
  };

  it("prices fanout targets all and fallback only the first", () => {
    const fan: Decision = {
      ...rec(1).decision,
      mode: "fanout",
      targets: [
        { instance: "codex", tier: "max", model: "gpt-5-pro", effort: "high" },
        { instance: "claude-alt", tier: "max", model: "claude-opus-4-1", effort: "high" },
      ],
    };
    expect(plannedTargets(fan)).toHaveLength(2);
    expect(plannedTargets({ ...fan, mode: "fallback" })).toHaveLength(1);
    expect(plannedTargets({ ...fan, action: "host", targets: [] })).toEqual([]);
    const r = compareProfiles({ decisions: [rec(1, { decision: fan })], shadow: [], runs: [] });
    const p = stats(r, "balance");
    expect(p.relativeCost.value).toBe(8 + 10);
    expect(p.instances.map((i) => [i.instance, i.relativeCost.value])).toEqual([
      ["claude-alt", 10],
      ["codex", 8],
    ]);
  });

  it("does not invent a cost when the stored input cannot price a target", () => {
    const bad = rec(2);
    bad.input = { ...bad.input, routing: { activeProfile: "balance" } };
    const r = compareProfiles({ decisions: [bad], shadow: [], runs: [] });
    const p = stats(r, "balance");
    expect(p.relativeCost.value).toBe(0);
    expect(p.unpricedTargets.value).toBe(1);
    expect(renderCompare(r)).toContain("could not be priced");

    const input = seedInput(3);
    const noModel = {
      ...input,
      routing: { ...makeConfig(), models: {} } as unknown as Record<string, unknown>,
    };
    expect(
      relativeCostModel(noModel, { instance: "codex", tier: "balanced", model: "m", effort: "e" }),
    ).toBeNull();
    expect(
      relativeCostModel(input, { instance: "nope", tier: "balanced", model: "m", effort: "e" }),
    ).toBeNull();
  });

  it("uses the unknown profile when the input names none, and ignores orphan shadow rows", () => {
    const anon = rec(4);
    anon.input = { ...anon.input, routing: {} };
    const r = compareProfiles({
      decisions: [anon],
      shadow: [
        { decisionId: "missing", profile: "preserve", decision: anon.decision, createdAt: at(0) },
        { decisionId: anon.id, profile: "(unknown)", decision: anon.decision, createdAt: at(0) },
      ],
      runs: [],
    });
    expect(r.profiles.map((p) => p.profile)).toEqual(["(unknown)"]);
    expect(stats(r, "(unknown)").tasks.value).toBe(1);
  });

  it("fall-through is not observed for non-delegations, fanouts, unknown runs or foreign instances", () => {
    const d = rec(5);
    const mk = (decision: Decision, runId: string | null) => ({
      ...d,
      id: `r${runId}`,
      runId,
      decision,
    });
    const fan = { ...d.decision, mode: "fanout" as const };
    const host = { ...d.decision, action: "host" as const, targets: [] };
    const r = compareProfiles({
      decisions: [
        mk(fan, "a"),
        mk(host, "b"),
        mk(d.decision, "missing"),
        mk(d.decision, "c"),
        mk(d.decision, "d"),
        mk(d.decision, null),
      ],
      shadow: [],
      runs: [
        runFor("a", "codex"),
        runFor("b", null),
        runFor("c", "elsewhere"),
        runFor("d", "codex", "rejected"),
      ],
    });
    expect(stats(r, "balance").fellThrough).toMatchObject({ value: 0, observedRuns: 0 });
  });
});

describe("renderCompare", () => {
  it("is deterministic and shows n/a for never-run profiles", async () => {
    await seed();
    const r = await compare();
    expect(renderCompare(r)).toBe(renderCompare(structuredClone(r)));
    expect(renderCompare(r)).toMatch(/preserve\s.*n\/a/);
    expect(renderCompare(r)).toContain("Host consumption: not observable");
  });

  it("falls back to the default message and open window labels", () => {
    const text = renderCompare({
      empty: true,
      message: null,
      since: null,
      until: at(3),
      decisions: 0,
      profiles: [],
      hostConsumption: "not observable",
      estimated: true,
    });
    expect(text).toContain("start to " + at(3));
    expect(text).toContain("no recorded decisions");
  });

  it("shows a dash for profiles without delegations", () => {
    const d = seedInput(7); // db/migrations pin: host
    const rec: DecisionRecord = {
      id: "h",
      createdAt: at(0),
      runId: null,
      input: d,
      decision: {
        action: "host",
        mode: "single",
        targets: [],
        chain: [],
        inputHash: "h",
        reason: "r",
      },
    };
    expect(
      renderCompare(compareProfiles({ decisions: [rec], shadow: [], runs: [], since: at(0) })),
    ).toContain("balance: -");
  });
});
