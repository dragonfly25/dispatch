import { describe, expect, it } from "vitest";
import { RoutingConfigSchema, RuleSchema } from "../../src/core/routing.js";

const minimal = {
  version: 1,
  tiers: ["fast", "balanced", "max"],
  efforts: ["low", "medium", "high"],
  instances: [
    {
      id: "codex",
      adapter: "codex",
      pool: "subscription",
      enabled: true,
      maxAutonomy: "worktree",
      concurrency: 2,
      thresholds: { soft: 30, hard: 10 },
    },
  ],
  models: {
    codex: {
      tiers: { fast: { model: "m-fast", effort: { low: "low" }, relativeCost: 1 } },
      reverse: [{ pattern: "m-*", tier: "fast" }],
    },
  },
  pins: [{ id: "migrations", match: { paths: ["db/migrations/**"] }, action: { type: "host" } }],
  directMappings: [],
  activeProfile: "preserve",
  profiles: {
    preserve: { rules: [{ id: "all", action: { type: "provider", instance: "codex" } }] },
  },
  activePreset: "mirror",
  presets: { mirror: {} },
  unspecifiedModel: "balanced",
  maxAutonomy: "worktree",
  shadowProfiles: [],
};

describe("[AC3] RoutingConfig contract", () => {
  it("parses a minimal config and applies defaults", () => {
    const cfg = RoutingConfigSchema.parse(minimal);
    expect(cfg.presets.mirror).toEqual({ effortShift: 0, tierByTaskType: {} });
    expect(cfg.profiles.preserve?.rules[0]?.match).toEqual({});
    expect(cfg.instances[0]?.effortShift).toBe(0);
  });

  it("defaults fallback strategy to ordered", () => {
    const rule = RuleSchema.parse({
      id: "f",
      action: { type: "fallback", instances: ["codex"] },
    });
    expect(rule.action).toEqual({ type: "fallback", instances: ["codex"], strategy: "ordered" });
  });

  it("rejects unknown keys and fanout with fewer than two instances", () => {
    expect(() => RuleSchema.parse({ id: "x", action: { type: "host" }, extra: 1 })).toThrow();
    expect(() =>
      RuleSchema.parse({ id: "x", action: { type: "fanout", instances: ["codex"] } }),
    ).toThrow();
    expect(() =>
      RuleSchema.parse({ id: "x", match: { colour: ["red"] }, action: { type: "host" } }),
    ).toThrow();
  });
});
