import { describe, expect, it } from "vitest";
import {
  decide,
  describeExclusions,
  excludeUnavailable,
  renderExplain,
} from "../../../src/router/index.js";
import { makeConfig, makeInput } from "./fixtures.js";

describe("excludeUnavailable", () => {
  it("disables enabled instances that have a reason, keeps the rest, reports them in order", () => {
    const cfg = makeConfig();
    const r = excludeUnavailable(cfg, (i) => (i.adapter === "claude" ? `no ${i.id}` : null));
    expect(r.excluded).toEqual([
      { id: "claude", reason: "no claude" },
      { id: "claude-alt", reason: "no claude-alt" },
    ]);
    expect(r.routing.instances.map((i) => [i.id, i.enabled])).toEqual([
      ["claude", false],
      ["claude-alt", false],
      ["codex", true],
      ["agy", true],
    ]);
    // The input config is not mutated.
    expect(cfg.instances.every((i) => i.enabled)).toBe(true);
  });

  it("returns the same routing when nothing is excluded, and skips disabled instances", () => {
    const cfg = makeConfig();
    cfg.instances[3] = { ...(cfg.instances[3] as (typeof cfg.instances)[number]), enabled: false };
    const r = excludeUnavailable(cfg, (i) => (i.id === "agy" ? "never asked" : null));
    expect(r.excluded).toEqual([]);
    expect(r.routing).toBe(cfg);
  });

  it("describeExclusions joins id: reason pairs", () => {
    expect(describeExclusions([])).toBe("");
    expect(
      describeExclusions([
        { id: "a", reason: "x" },
        { id: "b", reason: "y" },
      ]),
    ).toBe("a: x; b: y");
  });
});

describe("routing around an excluded instance", () => {
  it("a fallback chain skips it (filtered: disabled) and explain shows the reason", () => {
    const base = makeInput({
      host: { self: null },
      config: {
        pins: [
          {
            id: "all-to-claude-then-codex",
            match: {},
            action: { type: "fallback", instances: ["claude", "codex"], strategy: "ordered" },
          },
        ],
      },
    });
    const r = excludeUnavailable(base.routing as unknown as ReturnType<typeof makeConfig>, (i) =>
      i.adapter === "claude" ? "not on this OS" : null,
    );
    const input = { ...base, routing: r.routing as unknown as Record<string, unknown> };
    const decision = decide(input);
    expect(decision.action).toBe("delegate");
    expect(decision.targets.map((t) => t.instance)).toEqual(["codex"]);
    expect(decision.chain).toContainEqual(
      expect.objectContaining({ layer: "filter", ruleId: "claude", effect: "filtered: disabled" }),
    );
    const text = renderExplain(input, decision, undefined, r.excluded);
    expect(text).toContain("Unavailable (disabled for this decision):");
    expect(text).toContain("  claude: not on this OS");
    expect(renderExplain(input, decision)).not.toContain("Unavailable");
  });
});
