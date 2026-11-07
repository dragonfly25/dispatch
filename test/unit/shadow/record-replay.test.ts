import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchError } from "../../../src/core/errors.js";
import { decide, decideForProfiles } from "../../../src/router/index.js";
import {
  diffDecisions,
  recordDecisionWithShadow,
  replayDecision,
  shadowProfileNames,
} from "../../../src/shadow/index.js";
import { makeConfig, makeInput } from "../router/fixtures.js";
import { at, seedDecision, seedInput, type TempStore, tempStore } from "./helpers.js";

let t: TempStore;
beforeEach(async () => {
  t = await tempStore();
});
afterEach(async () => {
  await t.close();
});

describe("[UC8] recordDecisionWithShadow", () => {
  it("stores the real decision and one shadow decision per other profile on the same snapshot", async () => {
    const input = makeInput();
    const decision = decide(input);
    const { id, shadow } = await recordDecisionWithShadow(t.store, input, decision, {
      clock: t.clock,
    });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Object.keys(shadow)).toEqual(["preserve", "specialize", "off"]);
    expect(shadow).toEqual(decideForProfiles(input, ["preserve", "specialize", "off"]));

    const [rec] = await t.store.listDecisions(at(-60));
    expect(rec).toMatchObject({ id, createdAt: input.now, runId: null, decision });
    expect(rec?.input).toEqual(input);
    const rows = t.store.listShadow(at(-60));
    expect(rows.map((r) => r.profile)).toEqual(["off", "preserve", "specialize"]);
    expect(rows.every((r) => r.decisionId === id)).toBe(true);
  });

  it("uses routing.shadowProfiles when set, and explicit profiles over both", async () => {
    const input = makeInput({ config: { shadowProfiles: ["off", "balance", "off"] } });
    expect(shadowProfileNames(input)).toEqual(["off"]);
    expect(shadowProfileNames(input, ["specialize", "balance"])).toEqual(["specialize"]);
    expect(shadowProfileNames(input, [])).toEqual(["off"]);
    const { shadow } = await recordDecisionWithShadow(t.store, input, decide(input), { id: "x" });
    expect(Object.keys(shadow)).toEqual(["off"]);
  });

  it("honours id, createdAt and runId", async () => {
    const input = makeInput();
    await recordDecisionWithShadow(t.store, input, decide(input), {
      id: "mine",
      createdAt: at(5),
      runId: "run-9",
      profiles: ["off"],
    });
    expect(await t.store.listDecisions(at(0))).toMatchObject([
      { id: "mine", createdAt: at(5), runId: "run-9" },
    ]);
  });

  it("redacts the stored input but computes shadow decisions from the live one", async () => {
    const input = makeInput({
      task: { prompt: "use key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789" },
    });
    await recordDecisionWithShadow(t.store, input, decide(input), { id: "r", profiles: ["off"] });
    const [rec] = await t.store.listDecisions(at(-60));
    expect(JSON.stringify(rec?.input)).not.toContain(
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
    );
  });

  it("writes nothing when a profile is unknown or the decision does not match the input", async () => {
    const input = makeInput();
    const decision = decide(input);
    await expect(
      recordDecisionWithShadow(t.store, input, decision, { profiles: ["nope"] }),
    ).rejects.toMatchObject({ code: "router.config_invalid" });
    await expect(
      recordDecisionWithShadow(t.store, makeInput({ task: { id: "other" } }), decision),
    ).rejects.toMatchObject({ code: "shadow.hash_mismatch" });
    expect(await t.store.listDecisions(at(-60))).toEqual([]);
    expect(t.store.listShadow(at(-60))).toEqual([]);
  });
});

describe("[AC3] replayDecision", () => {
  it("reproduces identical decisions from the stored input", async () => {
    for (let i = 0; i < 12; i++) {
      const { id } = await seedDecision(t.store, i);
      const r = await replayDecision(t.store, id);
      expect(r.identical, `${id}: ${JSON.stringify(r.diff)}`).toBe(true);
      expect(r.diff).toEqual([]);
      expect(r.replayed).toEqual(r.recorded);
      expect(r.configSubstituted).toBe(false);
      expect(r.profile).toBe("balance");
    }
  });

  it("reproduces shadow decisions when asked to replay as another profile", async () => {
    const { id } = await seedDecision(t.store, 2);
    const r = await replayDecision(t.store, id, { profile: "preserve" });
    expect(r.identical).toBe(true);
    expect(r.profile).toBe("preserve");
    expect(r.recorded.inputHash).not.toBe((await replayDecision(t.store, id)).recorded.inputHash);
    // Naming the active profile is the plain replay.
    expect((await replayDecision(t.store, id, { profile: "balance" })).identical).toBe(true);
  });

  it("reports a diff when the routing config changes", async () => {
    const { id, input } = await seedDecision(t.store, 2); // review task, balance -> fallback
    const changed = makeConfig({
      profiles: {
        ...makeConfig().profiles,
        balance: {
          rules: [{ id: "all", match: {}, action: { type: "provider", instance: "claude-alt" } }],
        },
      },
    });
    const r = await replayDecision(t.store, id, {
      withConfig: changed as unknown as Record<string, unknown>,
    });
    expect(r.configSubstituted).toBe(true);
    expect(r.identical).toBe(false);
    expect(r.input.routing).toEqual(changed);
    expect(r.replayed).toEqual(
      decide({ ...input, routing: changed as unknown as Record<string, unknown> }),
    );
    const fields = r.diff.map((d) => d.field);
    expect(fields).toContain("inputHash");
    expect(fields).toContain("mode");
    expect(fields.some((f) => f.startsWith("targets["))).toBe(true);
    expect(fields.some((f) => f.startsWith("chain["))).toBe(true);
  });

  it("fails clearly for unknown ids and missing shadow rows", async () => {
    const { id } = await seedDecision(t.store, 1);
    await expect(replayDecision(t.store, "nope")).rejects.toBeInstanceOf(DispatchError);
    await expect(replayDecision(t.store, "nope")).rejects.toMatchObject({
      code: "shadow.not_found",
    });
    await expect(replayDecision(t.store, id, { profile: "off" })).rejects.toMatchObject({
      code: "shadow.not_found",
    });
  });

  it("copes with a stored input without an active profile name", async () => {
    const input = seedInput(1);
    const decision = decide(input);
    await t.store.recordDecision({ id: "legacy", createdAt: at(1), runId: null, input, decision });
    const r = await replayDecision(t.store, "legacy");
    expect(r.profile).toBe("balance");
  });
});

describe("diffDecisions", () => {
  it("is empty for equal decisions and lists length differences", () => {
    const a = decide(makeInput());
    expect(diffDecisions(a, structuredClone(a))).toEqual([]);
    const b = { ...a, targets: [], chain: a.chain.slice(1), reason: "other" };
    const d = diffDecisions(a, b);
    expect(d.find((x) => x.field === "reason")).toBeDefined();
    expect(d.some((x) => x.replayed === "(none)")).toBe(true);
  });
});
