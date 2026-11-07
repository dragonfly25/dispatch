import { describe, expect, it } from "vitest";
import type { DecisionInput } from "../../../src/core/contracts.js";
import { decide, decideForProfiles, renderExplain } from "../../../src/router/index.js";
import { makeInput, win } from "./fixtures.js";

const explain = (input: DecisionInput, alternatives?: string[]) =>
  renderExplain(input, decide(input), alternatives && decideForProfiles(input, alternatives));

const opusSession = { sessionModel: { value: "claude-opus-4-1", observed: true } };

describe("renderExplain", () => {
  it("[UC6] balanced: an Opus session still gets the balanced tier", () => {
    expect(explain(makeInput({ host: opusSession, used: { codex: 40 } }))).toMatchSnapshot();
  });

  it("[UC6] inherit: an Opus session maps to max; unobserved records decided_without", () => {
    const config = { unspecifiedModel: "inherit" };
    expect(
      explain(makeInput({ config, host: opusSession, used: { codex: 40 } })),
    ).toMatchSnapshot();
    expect(explain(makeInput({ config }))).toMatchSnapshot();
  });

  it("[UC4] filters, quota used and alternative profiles", () => {
    const input = makeInput({
      task: { taskType: "test", requestedModel: "gpt-5-pro", effort: "high" },
      quota: {
        codex: {
          pool: "subscription",
          windows: [
            win(95, { source: "codex-app-server" }),
            win(40, { kind: "7d", reliability: "estimated" }),
          ],
        },
        agy: { pool: "subscription", windows: [], unavailableUntil: "2026-11-07T12:00:00.000Z" },
      },
    });
    expect(explain(input, ["preserve", "specialize", "off"])).toMatchSnapshot();
  });

  it("[UC5] pin and direct mapping sources", () => {
    expect(
      explain(makeInput({ task: { paths: ["db/migrations/1.sql"] } }), ["off"]),
    ).toMatchSnapshot();
    const config = {
      directMappings: [
        { fromModel: "claude-opus-*", instance: "codex", model: "gpt-5-pro", effort: "xhigh" },
      ],
      activePreset: "economy",
    };
    expect(
      explain(
        makeInput({ config, task: { requestedModel: "claude-opus-4-1" }, host: { self: null } }),
      ),
    ).toMatchSnapshot();
  });

  it("is deterministic and skips empty sections", () => {
    const input = makeInput({ config: { activeProfile: "off" } });
    const text = explain(input, []);
    expect(text).toBe(explain(input, []));
    expect(text).toContain("Candidates:\n  (none)");
    expect(text).not.toContain("Quota used");
    expect(text).not.toContain("Other profiles");
  });
});
