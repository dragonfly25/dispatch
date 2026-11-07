import { describe, expect, it } from "vitest";
import type { Decision } from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import type { AdapterModelTable, RoutingConfig } from "../../../src/core/routing.js";
import { isoAfter } from "../../../src/router/filters.js";
import {
  canonicalJson,
  decide,
  decideForProfiles,
  inputHash,
  quotaView,
} from "../../../src/router/index.js";
import { defaultTier } from "../../../src/router/tiers.js";
import { makeConfig, makeInput, NOW, win } from "./fixtures.js";

const instances = (d: Decision) => d.targets.map((t) => t.instance);
const filterOf = (d: Decision, id: string) =>
  d.chain.find((t) => t.layer === "filter" && t.ruleId === id);
const notes = (d: Decision) => d.chain.map((t) => t.note ?? "").join("\n");
const profile = (rules: RoutingConfig["profiles"][string]["rules"]) => ({
  activeProfile: "p",
  profiles: { p: { rules } },
});

describe("canonical JSON and hashing", () => {
  it("ignores key order and undefined members", () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: [1, undefined] } })).toBe(
      '{"a":{"c":[1,null]},"b":1}',
    );
    expect(inputHash({ a: 1, b: 2 })).toBe(inputHash({ b: 2, a: 1 }));
    expect(inputHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson(undefined)).toBe("null");
  });

  it("compares ISO timestamps of any precision without a clock", () => {
    expect(isoAfter("2026-11-07T10:00:00.5Z", "2026-11-07T10:00:00Z")).toBe(true);
    expect(isoAfter("2026-11-07T10:00Z", "2026-11-07T10:00:00.000Z")).toBe(false);
    expect(isoAfter("b", "a")).toBe(true);
  });
});

describe("config parsing", () => {
  it("fails with router.config_invalid on a bad config", () => {
    const input = { ...makeInput(), routing: { version: 2 } };
    expect(() => decide(input)).toThrow(DispatchError);
    expect(() => decide(input)).toThrow(/invalid routing config/);
  });

  it("fails when the active profile or preset is undefined", () => {
    expect(() => decide(makeInput({ config: { activeProfile: "nope" } }))).toThrow(
      /profile "nope"/,
    );
    expect(() => decide(makeInput({ config: { activePreset: "nope" } }))).toThrow(/preset "nope"/);
  });
});

describe("tier resolution", () => {
  const tierOf = (d: Decision) => d.targets[0]?.tier;

  it("classifies the requested model via reverse tables, host adapter first", () => {
    const models = makeConfig().models;
    const config = {
      models: {
        ...models,
        antigravity: {
          ...(models.antigravity as AdapterModelTable),
          reverse: [{ pattern: "claude-opus-*", tier: "fast" }],
        },
      },
    } as Partial<RoutingConfig>;
    const task = { requestedModel: "claude-opus-4-1" };
    expect(tierOf(decide(makeInput({ task, config })))).toBe("max");
    expect(tierOf(decide(makeInput({ task, config, host: { self: "agy" } })))).toBe("fast");
    // no host adapter: alphabetical, antigravity before claude
    expect(tierOf(decide(makeInput({ task, config, host: { self: null } })))).toBe("fast");
  });

  it("falls back to task.tier, then to unspecifiedModel", () => {
    const d1 = decide(makeInput({ task: { requestedModel: "mystery", tier: "fast" } }));
    expect(tierOf(d1)).toBe("fast");
    expect(d1.chain[0]).toMatchObject({ ruleId: "tier:reverse", matched: false });
    expect(tierOf(decide(makeInput({ task: { requestedModel: "mystery" } })))).toBe("balanced");
    expect(tierOf(decide(makeInput({ config: { unspecifiedModel: "fast" } })))).toBe("fast");
  });

  it("[UC6] inherit uses the observed session model, else balanced with decided_without", () => {
    const config = { unspecifiedModel: "inherit" } as const;
    const opus = { sessionModel: { value: "claude-opus-4-1", observed: true } };
    expect(tierOf(decide(makeInput({ config, host: opus })))).toBe("max");
    for (const host of [
      {},
      { sessionModel: { value: "claude-opus-4-1", observed: false } },
      { sessionModel: { value: "who-knows", observed: true } },
    ]) {
      const d = decide(makeInput({ config, host }));
      expect(tierOf(d)).toBe("balanced");
      expect(notes(d)).toContain("decided_without: session_model");
    }
  });

  it("[UC6] balanced ignores an Opus session", () => {
    const host = { sessionModel: { value: "claude-opus-4-1", observed: true } };
    expect(tierOf(decide(makeInput({ host })))).toBe("balanced");
  });

  it("treats classify as balanced with a note (out of scope in v0.1)", () => {
    const d = decide(makeInput({ config: { unspecifiedModel: "classify" } }));
    expect(tierOf(d)).toBe("balanced");
    expect(notes(d)).toContain("classify is not implemented");
  });

  it("uses the middle tier when 'balanced' is not defined", () => {
    expect(defaultTier(makeConfig({ tiers: ["s", "m", "l", "xl"] }))).toBe("m");
  });

  it("applies the preset's tierByTaskType and effortShift (clamped)", () => {
    const config = { activePreset: "economy" };
    const d = decide(makeInput({ config, task: { taskType: "docs" } }));
    expect(d.targets[0]).toMatchObject({ tier: "fast", effort: "low", model: "gpt-5-mini" });
    expect(d.chain.some((t) => t.layer === "preset" && t.ruleId === "tier:preset:economy")).toBe(
      true,
    );
    const low = decide(makeInput({ config, task: { effort: "low" } }));
    expect(low.targets[0]?.effort).toBe("low");
  });

  it("adds the instance effortShift and maps to the native effort", () => {
    const base = makeConfig();
    const config = {
      instances: base.instances.map((i) => (i.id === "codex" ? { ...i, effortShift: 1 } : i)),
    };
    expect(decide(makeInput({ config })).targets[0]).toMatchObject({ effort: "xhigh" });
  });

  it("falls back to the default effort for an unknown task effort", () => {
    const d = decide(makeInput({ task: { effort: "ludicrous" } }));
    expect(d.targets[0]?.effort).toBe("medium");
    expect(notes(d)).toContain("unknown effort ludicrous");
  });

  it("uses the middle effort when the scale has no 'medium'", () => {
    const base = makeConfig();
    const codex = base.models.codex as AdapterModelTable;
    const config = {
      efforts: ["a", "b", "c"],
      models: {
        ...base.models,
        codex: {
          ...codex,
          tiers: { balanced: { model: "gpt-5", effort: { b: "B" }, relativeCost: 1 } },
        },
      },
    };
    expect(decide(makeInput({ config })).targets[0]?.effort).toBe("B");
  });

  it("filters a candidate without a model or native effort for the tier", () => {
    const base = makeConfig();
    const codex = base.models.codex as AdapterModelTable;
    const noTier = { models: { ...base.models, codex: { ...codex, tiers: {} } } };
    const d = decide(makeInput({ config: noTier }));
    expect(filterOf(d, "codex")?.effect).toContain("no model for tier balanced");
    expect(instances(d)).toEqual(["agy", "claude-alt"]);
    const noEffort = {
      models: {
        ...base.models,
        codex: { ...codex, tiers: { balanced: { model: "gpt-5", effort: {}, relativeCost: 1 } } },
      },
    };
    expect(filterOf(decide(makeInput({ config: noEffort })), "codex")?.effect).toContain(
      "no native effort",
    );
  });
});

describe("filters", () => {
  const only = (ids: string[]) =>
    profile([
      { id: "r", match: {}, action: { type: "fallback", instances: ids, strategy: "ordered" } },
    ]);

  it("[UC12] never chooses self; claude-alt is fine when self is claude, and vice versa", () => {
    const config = only(["claude", "claude-alt"]);
    const d1 = decide(makeInput({ config }));
    expect(instances(d1)).toEqual(["claude-alt"]);
    expect(filterOf(d1, "claude")?.effect).toContain("self");
    const d2 = decide(makeInput({ config, host: { self: "claude-alt" } }));
    expect(instances(d2)).toEqual(["claude"]);
  });

  it("[UC10] with no host every enabled instance is available", () => {
    const d = decide(makeInput({ config: only(["claude", "codex"]), host: { self: null } }));
    expect(instances(d)).toEqual(["claude", "codex"]);
  });

  it("drops unknown, disabled and over-autonomy instances", () => {
    const base = makeConfig();
    const config = {
      ...only(["ghost", "codex", "agy", "claude-alt"]),
      instances: base.instances.map((i) => (i.id === "codex" ? { ...i, enabled: false } : i)),
    };
    const d = decide(makeInput({ config, task: { autonomy: "worktree" } }));
    expect(filterOf(d, "ghost")?.effect).toContain("unknown instance");
    expect(filterOf(d, "codex")?.effect).toContain("disabled");
    expect(filterOf(d, "agy")?.effect).toContain("above instance max read-only");
    expect(instances(d)).toEqual(["claude-alt"]);
  });

  it("applies the config autonomy ceiling", () => {
    const d = decide(
      makeInput({ config: { maxAutonomy: "read-only" }, task: { autonomy: "worktree" } }),
    );
    expect(d.action).toBe("host");
    expect(filterOf(d, "codex")?.effect).toContain("above config max read-only");
  });

  it("skips instances unavailable until a future time only", () => {
    const quota = {
      codex: {
        windows: [],
        pool: "subscription" as const,
        unavailableUntil: "2026-11-07T11:00:00Z",
      },
      agy: { windows: [], pool: "subscription" as const, unavailableUntil: "2026-11-07T09:00:00Z" },
    };
    const d = decide(makeInput({ quota }));
    expect(filterOf(d, "codex")?.effect).toContain("unavailable until");
    expect(instances(d)).toEqual(["agy", "claude-alt"]);
  });

  it("hard limit always filters; unknown quota never blocks", () => {
    const d = decide(makeInput({ used: { codex: 95, agy: null } }));
    expect(filterOf(d, "codex")).toMatchObject({
      matched: false,
      effect: expect.stringContaining("below hard limit (remaining 5% < 10%)"),
    });
    expect(filterOf(d, "agy")?.effect).toBe("kept: quota unknown");
    expect(instances(d)).toEqual(["agy", "claude-alt"]);
  });

  it("soft limit filters only when an alternative is above soft", () => {
    const d1 = decide(makeInput({ used: { codex: 80, agy: 20, "claude-alt": 85 } }));
    expect(instances(d1)).toEqual(["agy"]);
    expect(filterOf(d1, "codex")?.effect).toContain("below soft limit");
    const d2 = decide(makeInput({ used: { codex: 80, agy: 75, "claude-alt": 85 } }));
    expect(instances(d2)).toEqual(["codex", "agy", "claude-alt"]);
    expect(filterOf(d2, "codex")?.note).toBe("below soft limit, no alternative");
  });

  it("uses the tightest window for remaining quota and reliability", () => {
    const q = quotaView(
      {
        takenAt: NOW,
        instances: {
          x: {
            pool: "subscription",
            windows: [win(20), win(null), win(70, { kind: "7d", reliability: "estimated" })],
          },
        },
      },
      "x",
    );
    expect(q).toMatchObject({ remainingPct: 30, reliability: "estimated" });
    expect(q.window?.kind).toBe("7d");
  });
});

describe("rule matching", () => {
  const rule = (match: object) =>
    profile([{ id: "r", match, action: { type: "provider", instance: "codex" } } as never]);
  const matches = (match: object, o: Parameters<typeof makeInput>[0] = {}) =>
    decide(makeInput({ ...o, config: { ...rule(match), ...o.config } })).action === "delegate";

  it("taskType", () => {
    expect(matches({ taskType: ["test"] }, { task: { taskType: "test" } })).toBe(true);
    expect(matches({ taskType: ["test"] }, { task: { taskType: "docs" } })).toBe(false);
    expect(matches({ taskType: ["test"] })).toBe(false);
  });

  it("paths: any path against any glob, dotfiles included", () => {
    expect(
      matches({ paths: ["docs/**", "**/.github/**"] }, { task: { paths: ["x/.github/ci.yml"] } }),
    ).toBe(true);
    expect(matches({ paths: ["docs/**"] }, { task: { paths: ["src/a.ts"] } })).toBe(false);
    expect(matches({ paths: ["docs/**"] }, { task: { paths: [] } })).toBe(false);
  });

  it("tier and autonomy", () => {
    expect(matches({ tier: ["max"] }, { task: { tier: "max" } })).toBe(true);
    expect(matches({ tier: ["max"] })).toBe(false);
    expect(matches({ autonomy: ["read-only"] })).toBe(true);
    expect(matches({ autonomy: ["worktree"] })).toBe(false);
  });

  it("minRemainingPct: unknown never satisfies", () => {
    expect(matches({ minRemainingPct: { codex: 50 } }, { used: { codex: 40 } })).toBe(true);
    expect(matches({ minRemainingPct: { codex: 50, agy: 10 } }, { used: { codex: 60 } })).toBe(
      false,
    );
    expect(matches({ minRemainingPct: { codex: 50 } }, { used: { codex: 60 } })).toBe(false);
  });

  it("reliability of every instance named in the action", () => {
    expect(matches({ reliability: ["real"] }, { used: { codex: 10 } })).toBe(true);
    expect(matches({ reliability: ["real"] })).toBe(false);
    const hostRule = profile([
      { id: "r", match: { reliability: ["real"] }, action: { type: "host" } },
    ]);
    const d = decide(makeInput({ config: hostRule }));
    expect(d.chain.find((t) => t.ruleId === "r")?.matched).toBe(true);
  });

  it("priorOutcome against the session history", () => {
    const sessionHistory = [{ taskId: "t0", instance: "codex", outcome: "timeout" as const }];
    expect(matches({ priorOutcome: ["timeout"] }, { sessionHistory })).toBe(true);
    expect(matches({ priorOutcome: ["failed"] }, { sessionHistory })).toBe(false);
  });

  it("records the first failed condition in the trace", () => {
    const d = decide(makeInput({ config: rule({ taskType: ["x"] }) }));
    expect(d.chain.find((t) => t.ruleId === "r")).toMatchObject({
      matched: false,
      note: "taskType did not match",
    });
    expect(d.chain.at(-1)).toMatchObject({ layer: "default", effect: "host" });
    expect(d.reason).toBe("host: no rule matched (default)");
  });
});

describe("actions", () => {
  const act = (action: object, o: Parameters<typeof makeInput>[0] = {}) =>
    decide(makeInput({ ...o, config: profile([{ id: "r", match: {}, action } as never]) }));

  it("provider: single, or host with reason when filtered", () => {
    const d = act({ type: "provider", instance: "codex" });
    expect(d).toMatchObject({ action: "delegate", mode: "single" });
    expect(d.targets).toEqual([
      { instance: "codex", tier: "balanced", model: "gpt-5", effort: "medium" },
    ]);
    expect(d.reason).toBe("delegate to codex (profile p rule r)");
    const h = act({ type: "provider", instance: "claude" });
    expect(h).toMatchObject({
      action: "host",
      targets: [],
      reason: "host: claude was filtered out (profile p rule r)",
    });
  });

  it("host and reject", () => {
    expect(act({ type: "host" })).toMatchObject({
      action: "host",
      mode: "single",
      reason: "host: profile p rule r",
    });
    expect(act({ type: "reject", reason: "no secrets" })).toMatchObject({
      action: "reject",
      targets: [],
      reason: "reject: no secrets (profile p rule r)",
    });
  });

  it("fallback most_remaining sorts by remaining, unknown last, stable", () => {
    const action = {
      type: "fallback",
      instances: ["agy", "claude-alt", "codex"],
      strategy: "most_remaining",
    };
    const d = act(action, { used: { codex: 20, "claude-alt": 20 } });
    expect(d.mode).toBe("fallback");
    expect(instances(d)).toEqual(["claude-alt", "codex", "agy"]);
    expect(d.chain.find((t) => t.ruleId === "most_remaining")?.effect).toBe(
      "order: claude-alt, codex, agy",
    );
  });

  it("fallback with every candidate filtered goes to host", () => {
    const d = act({ type: "fallback", instances: ["claude"], strategy: "ordered" });
    expect(d).toMatchObject({
      action: "host",
      reason: expect.stringContaining("every fallback candidate"),
    });
  });

  it("[UC7] fanout runs on every surviving instance", () => {
    const d = decide(
      makeInput({ config: { activeProfile: "preserve" }, task: { taskType: "review" } }),
    );
    expect(d).toMatchObject({ action: "delegate", mode: "fanout" });
    expect(instances(d)).toEqual(["codex", "claude-alt"]);
  });

  it("[UC7] fanout degrades to single with one survivor and to host with none", () => {
    const one = act({ type: "fanout", instances: ["codex", "claude"] });
    expect(one).toMatchObject({ action: "delegate", mode: "single" });
    expect(one.chain.find((t) => t.ruleId === "fanout")?.effect).toBe("degraded to single");
    const none = act({ type: "fanout", instances: ["claude", "ghost"] });
    expect(none).toMatchObject({
      action: "host",
      reason: expect.stringContaining("every fanout candidate"),
    });
    expect(none.chain.find((t) => t.ruleId === "fanout")?.effect).toBe("degraded to host");
  });

  it("deduplicates repeated instances", () => {
    expect(
      instances(act({ type: "fallback", instances: ["codex", "codex"], strategy: "ordered" })),
    ).toEqual(["codex"]);
  });
});

describe("layers", () => {
  it("[UC5] a matching pin wins under every profile", () => {
    for (const name of ["balance", "preserve", "specialize", "off"]) {
      const d = decide(
        makeInput({
          config: { activeProfile: name },
          task: { paths: ["db/migrations/001.sql"], taskType: "review" },
        }),
      );
      expect(d).toMatchObject({ action: "host", reason: "host: pin migrations" });
      expect(d.chain.find((t) => t.layer === "pin")).toMatchObject({
        ruleId: "migrations",
        matched: true,
      });
      expect(d.chain.some((t) => t.layer === "profile")).toBe(false);
    }
  });

  it("direct mapping bypasses tiers and comes before profile rules", () => {
    const config = {
      directMappings: [
        { fromModel: "claude-opus-*", fromEffort: "low", instance: "agy", model: "x", effort: "y" },
        { fromModel: "claude-opus-*", instance: "codex", model: "gpt-5-pro", effort: "xhigh" },
      ],
    };
    const d = decide(
      makeInput({ config, task: { requestedModel: "claude-opus-4-1", effort: "high" } }),
    );
    expect(d.targets).toEqual([
      { instance: "codex", tier: "max", model: "gpt-5-pro", effort: "xhigh" },
    ]);
    expect(d.reason).toBe("delegate to codex (direct mapping map:claude-opus-*)");
    expect(d.chain.find((t) => t.ruleId === "map:claude-opus-*:low")?.matched).toBe(false);
    expect(d.chain.some((t) => t.layer === "profile")).toBe(false);
  });

  it("direct mapping keeps the task tier when the model is unclassified, host when filtered", () => {
    const mapTo = (instance: string) => ({
      directMappings: [{ fromModel: "claude-*", instance, model: "custom", effort: "e" }],
    });
    const d = decide(
      makeInput({ config: mapTo("codex"), task: { requestedModel: "claude-sonnet-4-5" } }),
    );
    expect(d.targets[0]).toMatchObject({ tier: "balanced", model: "custom" });
    const h = decide(
      makeInput({ config: mapTo("claude"), task: { requestedModel: "claude-sonnet-4-5" } }),
    );
    expect(h).toMatchObject({
      action: "host",
      reason: "host: claude was filtered out (direct mapping map:claude-*)",
    });
  });

  it("a mapping that does not match falls through to the profile", () => {
    const config = {
      directMappings: [{ fromModel: "gpt-*", instance: "codex", model: "m", effort: "e" }],
    };
    const d = decide(makeInput({ config, task: { requestedModel: "claude-opus-4-1" } }));
    expect(d.chain.find((t) => t.layer === "mapping" && t.ruleId === "map:gpt-*")?.matched).toBe(
      false,
    );
    expect(d.mode).toBe("fallback");
  });

  it("the off profile keeps everything on the host", () => {
    expect(decide(makeInput({ config: { activeProfile: "off" } })).action).toBe("host");
  });
});

describe("use cases", () => {
  it("[UC4] codex below hard → next candidate; all exhausted → host", () => {
    const d1 = decide(makeInput({ used: { codex: 95 } }));
    expect(instances(d1)).toEqual(["agy", "claude-alt"]);
    expect(d1.targets[0]).toMatchObject({ instance: "agy", model: "gemini-pro" });
    const quota = {
      agy: {
        windows: [],
        pool: "subscription" as const,
        unavailableUntil: "2026-11-08T00:00:00.000Z",
      },
      "claude-alt": { windows: [win(99)], pool: "subscription" as const },
    };
    const d2 = decide(makeInput({ used: { codex: 95 }, quota }));
    expect(d2).toMatchObject({ action: "host", targets: [] });
    expect(d2.reason).toContain("every fallback candidate was filtered out");
  });
});

describe("shadow mode", () => {
  it("decides the same snapshot for each profile", () => {
    const input = makeInput({ task: { taskType: "test" } });
    const all = decideForProfiles(input, ["balance", "specialize", "off"]);
    expect(Object.keys(all)).toEqual(["balance", "specialize", "off"]);
    expect(all.balance?.mode).toBe("fallback");
    expect(all.specialize?.targets.map((t) => t.instance)).toEqual(["codex"]);
    expect(all.off?.action).toBe("host");
    expect(all.balance).toEqual(decide(input));
    expect(() => decideForProfiles(input, ["ghost"])).toThrow(/profile "ghost"/);
  });
});
