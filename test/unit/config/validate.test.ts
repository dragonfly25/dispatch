import { describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "../../../src/config/load.js";
import { type ValidationIssue, validate } from "../../../src/config/validate.js";
import type { RoutingConfig, Rule } from "../../../src/core/routing.js";
import { sandbox } from "./helpers.js";

/** The configuration a fresh install gets: built-in defaults and every shipped asset. */
function shipped() {
  const sb = sandbox();
  return { sb, cfg: loadEffectiveConfig({ cwd: sb.home, env: sb.env }) };
}

/** A mutable copy of the shipped routing config. */
function base(): RoutingConfig {
  return structuredClone(shipped().cfg.routing);
}

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  match: {},
  action: { type: "host" },
  ...over,
});

/** Issues as `level path` lines, for compact assertions. */
const brief = (issues: ValidationIssue[]) => issues.map((i) => `${i.level} ${i.path}`);
const messages = (issues: ValidationIssue[]) => issues.map((i) => i.message);

describe("validate: shipped assets", () => {
  it("every shipped profile, preset and model table loads and validates clean", () => {
    const { cfg } = shipped();
    expect(cfg.issues).toEqual([]);
    expect(validate(cfg)).toEqual([]);
    expect(validate(cfg.routing)).toEqual([]);
    expect(Object.keys(cfg.routing.profiles).sort()).toEqual([
      "balance",
      "off",
      "preserve",
      "specialize",
    ]);
    expect(Object.keys(cfg.routing.presets).sort()).toEqual(["custom", "economy", "mirror"]);
    expect(Object.keys(cfg.routing.models).sort()).toEqual(["antigravity", "claude", "codex"]);
  });

  it("each shipped profile and preset is clean when it is the active one", () => {
    const { cfg } = shipped();
    for (const profile of Object.keys(cfg.routing.profiles)) {
      for (const preset of Object.keys(cfg.routing.presets)) {
        const r = { ...cfg.routing, activeProfile: profile, activePreset: preset };
        expect(validate(r), `${profile} + ${preset}`).toEqual([]);
      }
    }
  });

  it("model tables define every tier and effort, and classify their own models", () => {
    const { models, tiers, efforts } = shipped().cfg.routing;
    for (const [adapter, table] of Object.entries(models)) {
      expect(Object.keys(table.tiers), adapter).toEqual(tiers);
      for (const row of Object.values(table.tiers)) {
        expect(Object.keys(row.effort)).toEqual(efforts);
      }
    }
    expect(models.claude?.tiers.fast?.model).toBe("claude-haiku-5-5");
    expect(models.codex?.tiers.fast?.model).toBe("gpt-6-luna");
    expect(models.antigravity?.tiers.fast?.model).toBe("gemini-3.8-flash-low");
  });

  it("the shipped economy preset shifts effort by -1 and custom behaves like mirror", () => {
    const { presets } = shipped().cfg.routing;
    expect(presets.economy?.effortShift).toBe(-1);
    expect(presets.mirror).toMatchObject({ effortShift: 0, tierByTaskType: {} });
    expect(presets.custom).toMatchObject({ effortShift: 0, tierByTaskType: {} });
    expect(presets["best-of-breed.example"]).toBeUndefined();
  });
});

describe("validate: use cases", () => {
  it("accepts a best-of-breed style preset that overrides the tier per task type", () => {
    const r = base();
    r.presets["best-of-breed"] = {
      effortShift: 0,
      tierByTaskType: { review: "max", test: "fast" },
    };
    r.activePreset = "best-of-breed";
    expect(validate(r)).toEqual([]);
  });

  it("[UC5] a pin on db/migrations/** validates clean, whatever the active profile", () => {
    const sb = sandbox();
    sb.global(
      [
        "version: 1",
        "pins:",
        "  - id: migrations-stay-on-host",
        "    match: { paths: ['db/migrations/**'] }",
        "    action: { type: host }",
        "",
      ].join("\n"),
    );
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(cfg.routing.pins).toHaveLength(1);
    expect(validate(cfg)).toEqual([]);
    for (const profile of Object.keys(cfg.routing.profiles)) {
      expect(validate({ ...cfg.routing, activeProfile: profile })).toEqual([]);
    }
  });

  it("[UC6] unspecified_model accepts inherit, classify and every tier; rejects other names", () => {
    const r = base();
    for (const value of ["inherit", "classify", "fast", "balanced", "max"]) {
      expect(validate({ ...r, unspecifiedModel: value }), value).toEqual([]);
    }
    const bad = validate({ ...r, unspecifiedModel: "huge" });
    expect(brief(bad)).toEqual(["error unspecifiedModel"]);
    expect(bad[0]?.message).toContain('"huge"');
  });

  it("[UC6] issues collected by the loader are surfaced by validate", () => {
    const sb = sandbox();
    sb.global("version: 1\nunspecified_model: huge\n");
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(brief(validate(cfg))).toEqual(["error unspecified_model"]);
  });
});

describe("validate: unknown names", () => {
  it("flags a rule, pin, mapping or fallback that names an unknown instance", () => {
    const r = base();
    r.pins = [rule("p", { action: { type: "provider", instance: "ghost" } })];
    r.directMappings = [
      { fromModel: "claude-opus-*", instance: "phantom", model: "m", effort: "high" },
    ];
    r.profiles.balance = {
      rules: [
        rule("f", {
          action: { type: "fallback", instances: ["codex", "nobody"], strategy: "ordered" },
        }),
        rule("q", { match: { minRemainingPct: { absent: 10 } }, action: { type: "host" } }),
      ],
    };
    const issues = validate(r);
    expect(brief(issues)).toEqual(
      expect.arrayContaining([
        "error pins[0].action.instance",
        "error directMappings[0].instance",
        "error profiles.balance.rules[0].action.instances[1]",
        "error profiles.balance.rules[1].match.minRemainingPct.absent",
      ]),
    );
  });

  it("flags undefined tiers in tables, reverse maps, presets and rule matches", () => {
    const r = base();
    r.models.claude = {
      tiers: {
        ...(r.models.claude?.tiers ?? {}),
        huge: {
          model: "m",
          effort: { low: "low", medium: "medium", high: "high" },
          relativeCost: 1,
        },
      },
      reverse: [{ pattern: "*x*", tier: "ultra" }],
    };
    r.presets.bad = { effortShift: 0, tierByTaskType: { test: "tiny" } };
    r.pins = [rule("p", { match: { tier: ["fast", "mega"] } })];
    expect(brief(validate(r))).toEqual(
      expect.arrayContaining([
        "error models.claude.tiers.huge",
        "error models.claude.reverse[0]",
        "error presets.bad.tierByTaskType.test",
        "error pins[0].match.tier[1]",
      ]),
    );
  });

  it("flags undefined efforts and warns about uncovered ones", () => {
    const r = base();
    const codex = r.models.codex;
    if (!codex?.tiers.fast) throw new Error("fixture");
    codex.tiers.fast.effort = { low: "low", extreme: "max" };
    r.directMappings = [
      {
        fromModel: "claude-opus-*",
        fromEffort: "turbo",
        instance: "codex",
        model: "gpt-6-sol",
        effort: "high",
      },
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual(
      expect.arrayContaining([
        "error models.codex.tiers.fast.effort.extreme",
        "warning models.codex.tiers.fast.effort",
        "error directMappings[0].fromEffort",
      ]),
    );
    expect(messages(issues).filter((m) => m.includes("no native value"))).toHaveLength(2);
  });

  it("reports a missing adapter table and a tier missing from a table", () => {
    const r = base();
    delete r.models.codex;
    const claude = r.models.claude;
    if (!claude) throw new Error("fixture");
    delete claude.tiers.max;
    expect(brief(validate(r))).toEqual(
      expect.arrayContaining(["error instances.codex", "warning models.claude.tiers"]),
    );
  });

  it("skips disabled instances when checking tables", () => {
    const r = base();
    delete r.models.antigravity; // antigravity is disabled by default
    expect(validate(r)).toEqual([]);
  });

  it("warns about a mapped model that the adapter table does not know", () => {
    const r = base();
    r.directMappings = [
      { fromModel: "claude-opus-*", instance: "codex", model: "gpt-9-imaginary", effort: "high" },
      { fromModel: "claude-haiku-*", instance: "codex", model: "gpt-6-luna", effort: "low" },
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual(["warning directMappings[0].model"]);
    expect(issues[0]?.message).toContain("gpt-6-luna");
  });

  it("flags a missing active profile, active preset and shadow profile", () => {
    const r = base();
    r.activeProfile = "nope";
    r.activePreset = "nada";
    r.shadowProfiles = ["balance", "ghost"];
    expect(brief(validate(r))).toEqual([
      "error activeProfile",
      "error activePreset",
      "error shadowProfiles[1]",
    ]);
  });
});

describe("validate: contradictions", () => {
  const to = (instance: string, model: string, effort: string) => ({
    fromModel: "claude-opus-*",
    instance,
    model,
    effort,
  });

  it("errors when the same fromModel/fromEffort maps to two targets", () => {
    const r = base();
    r.directMappings = [to("codex", "gpt-6-sol", "high"), to("claude", "claude-opus-5-5", "high")];
    const issues = validate(r);
    expect(brief(issues)).toEqual(["error directMappings[1]"]);
    expect(issues[0]?.message).toContain("contradicts directMappings[0]");
  });

  it("treats the same fromModel at the same fromEffort as a conflict too", () => {
    const r = base();
    r.directMappings = [
      { ...to("codex", "gpt-6-sol", "high"), fromEffort: "high" },
      { ...to("codex", "gpt-6-sol", "low"), fromEffort: "high" },
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual(["error directMappings[1]"]);
    expect(issues[0]?.message).toContain("at effort high");
  });

  it("warns about an exact duplicate and about a mapping shadowed by a catch-all-effort one", () => {
    const r = base();
    r.directMappings = [
      to("codex", "gpt-6-sol", "high"),
      to("codex", "gpt-6-sol", "high"),
      { ...to("codex", "gpt-6-luna", "low"), fromEffort: "low" },
    ];
    expect(brief(validate(r))).toEqual(["warning directMappings[1]", "warning directMappings[2]"]);
  });

  it("does not flag an efforts-specific mapping that comes first", () => {
    const r = base();
    r.directMappings = [
      { ...to("codex", "gpt-6-luna", "low"), fromEffort: "low" },
      to("codex", "gpt-6-sol", "high"),
    ];
    expect(validate(r)).toEqual([]);
  });

  it("errors when a reverse pattern maps to two tiers, warns when it repeats", () => {
    const r = base();
    const claude = r.models.claude;
    if (!claude) throw new Error("fixture");
    claude.reverse = [
      { pattern: "*opus*", tier: "max" },
      { pattern: "*opus*", tier: "fast" },
      { pattern: "*sonnet*", tier: "balanced" },
      { pattern: "*sonnet*", tier: "balanced" },
    ];
    expect(brief(validate(r))).toEqual([
      "error models.claude.reverse[1]",
      "warning models.claude.reverse[3]",
    ]);
  });
});

describe("validate: unreachable rules", () => {
  it("warns when rules follow a catch-all rule of a profile", () => {
    const r = base();
    r.profiles.balance = {
      rules: [
        rule("all", { action: { type: "fallback", instances: ["codex"], strategy: "ordered" } }),
        rule("late", { match: { taskType: ["test"] } }),
      ],
    };
    const issues = validate(r);
    expect(brief(issues)).toEqual(["warning profiles.balance.rules[1]"]);
    expect(issues[0]?.message).toContain('rule "all" before it matches every task');
  });

  it("warns about a pin shadowed by an earlier, broader pin", () => {
    const r = base();
    r.pins = [
      rule("wide", { match: { paths: ["db/**", "infra/**"], taskType: ["feature", "bugfix"] } }),
      rule("narrow", { match: { paths: ["db/**"], taskType: ["bugfix"], autonomy: ["worktree"] } }),
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual(["warning pins[1]"]);
    expect(issues[0]?.message).toContain('pin "narrow" is unreachable');
    expect(issues[0]?.message).toContain('"wide"');
  });

  it("[UC5] a narrower earlier pin does not shadow a broader later one", () => {
    const r = base();
    r.pins = [
      rule("narrow", { match: { paths: ["db/migrations/**"] } }),
      rule("wide", { match: { paths: ["db/**"] } }),
    ];
    expect(validate(r)).toEqual([]);
  });

  it("compares remaining-quota floors, tiers, prior outcomes and unknown conditions", () => {
    const r = base();
    r.pins = [
      rule("loose", { match: { minRemainingPct: { codex: 20 }, tier: ["max", "fast"] } }),
      rule("strict", { match: { minRemainingPct: { codex: 50 }, tier: ["max"] } }),
      rule("other-instance", { match: { minRemainingPct: { claude: 50 }, tier: ["max"] } }),
      rule("unbounded", { match: { minRemainingPct: { codex: 50 } } }),
      rule("outcome", { match: { priorOutcome: ["failed"] } }),
      rule("outcome-wide", { match: { priorOutcome: ["failed", "timeout"] } }),
    ];
    expect(brief(validate(r))).toEqual(["warning pins[1]"]);
  });

  it("never claims shadowing when reliability is involved", () => {
    const r = base();
    r.pins = [
      rule("rel", { match: { reliability: ["real"] } }),
      rule("later", { match: { reliability: ["real"], taskType: ["test"] } }),
    ];
    expect(validate(r)).toEqual([]);
  });

  it("warns about duplicate rule ids in a list", () => {
    const r = base();
    r.pins = [
      rule("same", { match: { taskType: ["a"] } }),
      rule("same", { match: { taskType: ["b"] } }),
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual(["warning pins[1].id"]);
    expect(issues[0]?.message).toContain("duplicate pin id");
  });
});

describe("validate: actions and thresholds", () => {
  it("warns when a fanout has fewer than two enabled instances", () => {
    const r = base();
    r.pins = [
      rule("ok", {
        match: { taskType: ["a"] },
        action: { type: "fanout", instances: ["codex", "claude"] },
      }),
      rule("one", {
        match: { taskType: ["b"], autonomy: ["read-only"] },
        action: { type: "fanout", instances: ["codex", "antigravity"] },
      }),
      rule("none", {
        match: { taskType: ["c"], autonomy: ["read-only"] },
        action: { type: "fanout", instances: ["antigravity", "ghost"] },
      }),
    ];
    const issues = validate(r);
    expect(brief(issues)).toEqual([
      "warning pins[1].action",
      "error pins[2].action.instances[1]",
      "warning pins[2].action",
    ]);
    expect(issues[0]?.message).toContain("1 of [codex, antigravity] is enabled");
    expect(issues[2]?.message).toContain("0 of [antigravity, ghost] are enabled");
  });

  it("accepts a fanout once both instances are enabled", () => {
    const r = base();
    const agy = r.instances.find((i) => i.id === "antigravity");
    if (!agy) throw new Error("fixture");
    agy.enabled = true;
    r.pins = [
      rule("second-opinion", {
        match: { taskType: ["review"], autonomy: ["read-only"] },
        action: { type: "fanout", instances: ["codex", "antigravity"] },
      }),
    ];
    expect(validate(r)).toEqual([]);
  });

  it("warns when a provider or fallback only names disabled instances", () => {
    const r = base();
    r.pins = [
      rule("a", {
        match: { autonomy: ["read-only"], taskType: ["a"] },
        action: { type: "provider", instance: "antigravity" },
      }),
      rule("b", {
        match: { autonomy: ["read-only"], taskType: ["b"] },
        action: { type: "fallback", instances: ["antigravity"], strategy: "ordered" },
      }),
    ];
    expect(brief(validate(r))).toEqual(["warning pins[0].action", "warning pins[1].action"]);
  });

  it("warns when a rule can hand worktree tasks to the read-only antigravity instance", () => {
    const r = base();
    r.pins = [
      rule("any", {
        match: { taskType: ["a"] },
        action: { type: "fallback", instances: ["codex", "antigravity"], strategy: "ordered" },
      }),
      rule("direct-too", {
        match: { taskType: ["b"], autonomy: ["read-only", "direct"] },
        action: { type: "provider", instance: "antigravity" },
      }),
      rule("read-only", {
        match: { taskType: ["c"], autonomy: ["read-only"] },
        action: { type: "fallback", instances: ["antigravity", "codex"], strategy: "ordered" },
      }),
      rule("above-ceiling", {
        match: { taskType: ["d"], autonomy: ["direct"] },
        action: { type: "fallback", instances: ["codex", "antigravity"], strategy: "ordered" },
      }),
    ];
    const issues = validate(r).filter((i) => i.message.includes("accepts at most"));
    expect(brief(issues)).toEqual(["warning pins[0].action"]);
    expect(issues[0]?.message).toContain("worktree");
    expect(issues[0]?.message).toContain("match.autonomy: [read-only]");
  });

  it("errors when the soft quota threshold is below the hard one", () => {
    const r = base();
    const codex = r.instances.find((i) => i.id === "codex");
    if (!codex) throw new Error("fixture");
    codex.thresholds = { soft: 5, hard: 20 };
    const issues = validate(r);
    expect(brief(issues)).toEqual(["error instances.codex.thresholds"]);
    expect(issues[0]?.message).toContain("soft (5)");
    codex.thresholds = { soft: 20, hard: 20 };
    expect(validate(r)).toEqual([]);
  });

  it("accepts host and reject actions", () => {
    const r = base();
    r.pins = [
      rule("host", { match: { taskType: ["a"] } }),
      rule("no", { match: { taskType: ["b"] }, action: { type: "reject", reason: "no" } }),
    ];
    expect(validate(r)).toEqual([]);
  });
});
