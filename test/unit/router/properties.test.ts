import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { DecisionInput } from "../../../src/core/contracts.js";
import type { Rule } from "../../../src/core/routing.js";
import { decide, inputHash } from "../../../src/router/index.js";
import { makeInput, win } from "./fixtures.js";

const IDS = ["claude", "claude-alt", "codex", "agy"] as const;

const usedArb = fc.option(fc.integer({ min: 0, max: 100 }), { nil: null });

const inputArb = fc
  .record({
    self: fc.constantFrom(null, ...IDS),
    used: fc.record({ claude: usedArb, "claude-alt": usedArb, codex: usedArb, agy: usedArb }),
    unavailable: fc.subarray([...IDS]),
    taskType: fc.option(fc.constantFrom("test", "review", "docs"), { nil: undefined }),
    paths: fc.subarray(["src/a.ts", "docs/x.md", "db/migrations/1.sql"]),
    autonomy: fc.constantFrom("read-only", "worktree", "direct"),
    requestedModel: fc.option(fc.constantFrom("claude-opus-4-1", "gpt-5", "gemini-pro", "zzz"), {
      nil: undefined,
    }),
    effort: fc.option(fc.constantFrom("low", "medium", "high"), { nil: undefined }),
    profile: fc.constantFrom("balance", "preserve", "specialize", "off"),
    preset: fc.constantFrom("mirror", "economy"),
    unspecified: fc.constantFrom("inherit", "balanced", "fast", "classify"),
    session: fc.option(
      fc.record({ value: fc.constantFrom("claude-opus-4-1", "x"), observed: fc.boolean() }),
      {
        nil: undefined,
      },
    ),
  })
  .map((r): DecisionInput => {
    const input = makeInput({
      used: r.used,
      host: r.session ? { self: r.self, sessionModel: r.session } : { self: r.self },
      task: {
        taskType: r.taskType,
        paths: r.paths,
        autonomy: r.autonomy,
        requestedModel: r.requestedModel,
        effort: r.effort,
      },
      config: {
        activeProfile: r.profile,
        activePreset: r.preset,
        unspecifiedModel: r.unspecified,
        pins: [],
        directMappings: [
          { fromModel: "gemini-*", instance: "agy", model: "gemini-ultra", effort: "high" },
        ],
      },
    });
    for (const id of r.unavailable) {
      input.quota.instances[id] = {
        windows: input.quota.instances[id]?.windows ?? [],
        pool: "subscription",
        unavailableUntil: "2026-11-07T12:00:00.000Z",
      };
    }
    return JSON.parse(JSON.stringify(input)) as DecisionInput;
  });

const pinActionArb: fc.Arbitrary<Rule["action"]> = fc.oneof(
  fc.constant({ type: "host" as const }),
  fc.constant({ type: "reject" as const, reason: "pinned" }),
  fc.constantFrom(...IDS).map((instance) => ({ type: "provider" as const, instance })),
  fc
    .subarray([...IDS], { minLength: 1 })
    .map((instances) => ({ type: "fallback" as const, instances, strategy: "ordered" as const })),
);

/** Deep copy with every object's keys in reverse order. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.keys(v)
      .reverse()
      .map((k) => [k, reverseKeys((v as Record<string, unknown>)[k])]),
  );
}

const withRouting = (input: DecisionInput, patch: Record<string, unknown>): DecisionInput => ({
  ...input,
  routing: { ...input.routing, ...patch },
});

describe("router properties", () => {
  it("[AC3] determinism: equal inputs (any key order) give deep-equal decisions", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        expect(decide(structuredClone(input))).toEqual(decide(input));
        expect(decide(reverseKeys(input) as DecisionInput)).toEqual(decide(input));
      }),
    );
  });

  it("[UC12] never routes to the host itself", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = decide(input);
        expect(d.targets.map((t) => t.instance)).not.toContain(input.host.self);
      }),
    );
  });

  it("[UC5] a matching pin always wins", () => {
    fc.assert(
      fc.property(inputArb, pinActionArb, (input, action) => {
        const pinned = withRouting(
          {
            ...input,
            task: { ...input.task, paths: [...input.task.paths, "db/migrations/9.sql"] },
          },
          { pins: [{ id: "pin", match: { paths: ["db/migrations/**"] }, action }] },
        );
        const d = decide(pinned);
        expect(d.chain.find((t) => t.layer === "pin")).toMatchObject({
          ruleId: "pin",
          matched: true,
        });
        expect(d.chain.some((t) => t.layer === "profile" || t.ruleId.startsWith("map:"))).toBe(
          false,
        );
        expect(d.reason).toContain("pin pin");
      }),
    );
  });

  it("[UC4] when every instance is below its hard limit the result is host or reject", () => {
    fc.assert(
      fc.property(inputArb, fc.integer({ min: 91, max: 100 }), (input, used) => {
        const quota = structuredClone(input.quota);
        for (const id of IDS) quota.instances[id] = { windows: [win(used)], pool: "subscription" };
        expect(["host", "reject"]).toContain(decide({ ...input, quota }).action);
      }),
    );
  });

  it("[AC3] inputHash is the hash of the input and replay reproduces the decision", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const d = decide(input);
        expect(d.inputHash).toBe(inputHash(input));
        const stored = JSON.parse(JSON.stringify(input)) as DecisionInput;
        expect(decide(stored)).toEqual(d);
      }),
    );
  });
});
