/**
 * [UC8] Experimenting across profiles (spec §11 UC8, deviation 14). Verifica: the comparison uses
 * only data of real recorded decisions, never simulations; the user then switches with `use`.
 *
 * "A week with shadow mode on": the week's older decisions are recorded with the production
 * recorder (the real router plus `recordDecisionWithShadow`) at past timestamps, directly in the
 * state database; the most recent ones come from real `dispatch run` calls through the built CLI
 * (so they carry the CLI's own shadow rows). `status --compare` then runs as a separate process.
 *
 * Lower-level proofs: test/unit/shadow/compare.test.ts, record-replay.test.ts, cli-status.test.ts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import type { DecisionInput } from "../../src/core/contracts.js";
import { decide } from "../../src/router/index.js";
import { recordDecisionWithShadow } from "../../src/shadow/index.js";
import { SqliteStateStore } from "../../src/state/store.js";
import { makeInput } from "../unit/router/fixtures.js";
import { createWorld, parseJson, THREE_PROVIDERS, useBundles, type World } from "./harness.js";

useBundles();

const DAY = 86_400_000;
const TYPES = ["test", "docs", "review", "refactor"];

interface Figure {
  value: number;
  estimated: boolean;
}
interface CompareJson {
  empty: boolean;
  message: string | null;
  decisions: number;
  estimated: boolean;
  hostConsumption: string;
  profiles: {
    profile: string;
    tasks: Figure;
    realTasks: Figure;
    delegated: Figure;
    hostKept: Figure;
    rejected: Figure;
  }[];
}

/** One recorded decision per entry: day `d` of the past week, codex exhausted on every third one. */
async function seedWeek(w: World, count: number): Promise<number> {
  const store = SqliteStateStore.open(join(w.home.dispatchHome, "state", "dispatch.db"), {
    clock: systemClock,
  });
  try {
    for (let i = 0; i < count; i++) {
      const base = makeInput({
        task: { id: `week-${i}`, taskType: TYPES[i % TYPES.length] as string },
        // Codex is nearly out of quota on some days: balance can fall back, preserve cannot.
        used: { codex: i % 3 === 0 ? 96 : 30, "claude-alt": 40, agy: 50 },
      });
      const input: DecisionInput = {
        ...base,
        now: new Date(Date.now() - (1 + (i % 6)) * DAY - i * 60_000).toISOString(),
      };
      await recordDecisionWithShadow(store, input, decide(input), {
        id: `week-${i}`,
        profiles: ["preserve"],
      });
    }
  } finally {
    store.close();
  }
  return count;
}

describe("[UC8] experimenting across profiles", () => {
  it("[UC8] status --compare aggregates only recorded decisions, then `use preserve` switches", async () => {
    const w = createWorld({
      global: `${THREE_PROVIDERS}shadow_profiles: [preserve]\n`,
      env: { CLAUDECODE: "1" },
      scenarios: { codex: [{ scenario: "success_edit", file: "a.md", content: "A\n" }] },
    });
    const seeded = await seedWeek(w, 12);
    for (const t of ["test", "docs", "review"]) expect(w.run(["--task-type", t]).code).toBe(0);
    const spawned = w.fakes.readLog({ kind: "run" }).length;
    expect(spawned).toBe(3);
    const recorded = seeded + 3;

    const compare = parseJson<CompareJson>(w.dispatch(["status", "--compare", "--json"]));
    expect(compare).toMatchObject({ empty: false, estimated: true, decisions: recorded });
    expect(compare.hostConsumption).toBe("not observable");
    expect(compare.profiles.map((p) => p.profile)).toEqual(["balance", "preserve"]);
    for (const p of compare.profiles) {
      // Every figure is labelled estimated; the numbers add up to the recorded decisions.
      expect(p.tasks).toEqual({ value: recorded, estimated: true });
      expect(p.delegated.value + p.hostKept.value + p.rejected.value).toBe(recorded);
      expect(p.delegated.estimated && p.hostKept.estimated && p.rejected.estimated).toBe(true);
    }
    const balance = compare.profiles[0];
    const preserve = compare.profiles[1];
    expect(balance?.realTasks.value).toBe(recorded); // the active profile ran for real
    expect(preserve?.realTasks.value).toBe(0); // preserve only ever ran in shadow
    // With codex nearly out of quota, preserve (codex only) keeps work on the host that balance
    // would have delegated to the other providers: the difference the user reads.
    expect(preserve?.hostKept.value ?? 0).toBeGreaterThan(balance?.hostKept.value ?? 0);

    // The text names the data it used, and a window narrows it to the recorded decisions in it.
    const text = w.dispatch(["status", "--compare"]).stdout;
    expect(text).toContain(`Real decisions: ${recorded}.`);
    expect(text).toContain("ESTIMATED from recorded decision snapshots");
    const recent = parseJson<CompareJson>(
      w.dispatch(["status", "--compare", "--since", "1h", "--json"]),
    );
    expect(recent.decisions).toBe(3);

    // Comparing executes nothing: no external CLI was started by any of the calls above.
    expect(w.fakes.readLog({ kind: "run" })).toHaveLength(spawned);

    // The user switches; the choice is stored and takes effect.
    expect(w.dispatch(["profiles"]).stdout).toMatch(/\* balance/);
    const use = w.dispatch(["use", "preserve"]);
    expect(use.code, use.stderr).toBe(0);
    expect(use.stdout).toContain("balance -> preserve");
    expect(w.dispatch(["status"]).stdout).toContain("Profile: preserve");
    expect(readFileSync(join(w.home.dispatchHome, "config.yaml"), "utf8")).toContain(
      "profile: preserve",
    );
    const cache = JSON.parse(readFileSync(join(w.home.dispatchHome, "hook-cache.json"), "utf8"));
    expect(cache.policy.profile).toBe("preserve");
  });

  it("[UC8] an empty log prints 'no recorded decisions' and nothing is simulated", () => {
    const w = createWorld({ global: THREE_PROVIDERS });
    const text = w.dispatch(["status", "--compare"]);
    expect(text.code).toBe(0);
    expect(text.stdout).toContain("no recorded decisions");
    expect(text.stdout).toContain("Nothing was executed");
    const json = parseJson<CompareJson>(w.dispatch(["status", "--compare", "--json"]));
    expect(json).toMatchObject({ empty: true, message: "no recorded decisions", decisions: 0 });
    expect(json.profiles).toEqual([]);
    expect(w.fakes.readLog({ kind: "run" })).toEqual([]);
  });
});
