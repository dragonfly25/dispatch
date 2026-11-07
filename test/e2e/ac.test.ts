/**
 * Acceptance criteria that are not a use case of their own (spec §12):
 * [AC3] every routing decision is reproducible with `explain` and has a log.
 * (AC1 is the sum of UC1-UC14; AC2 is [UC14][AC2]; AC4 is in uc11.test.ts; AC5 is [UC9][AC5] and
 * test/security/collaborator.test.ts; AC6 is a documentation check in scripts/acceptance.mjs;
 * AC7 is test/security/run.test.ts.)
 */
import { describe, expect, it } from "vitest";
import { createWorld, parseJson, THREE_PROVIDERS, useBundles } from "./harness.js";

useBundles();

const GLOBAL = `${THREE_PROVIDERS}pins:
  - id: keep-secrets
    match: { paths: ["secrets/**"] }
    action: { type: reject, reason: "secrets/ is never delegated" }
  - id: keep-migrations
    match: { paths: ["db/**"] }
    action: { type: host }
`;

interface LogJson {
  run: { runId: string };
  decisions: { id: string; decision: { action: string; reason: string } }[];
}

describe("[AC3] every decision is reproducible and logged", () => {
  it("[AC3] delegate, host, reject and quota-fallback decisions each have a log and replay without a diff", () => {
    const w = createWorld({
      global: GLOBAL,
      env: { CLAUDECODE: "1" },
      scenarios: {
        codex: [
          { scenario: "success_edit", file: "math.js", content: "x\n" },
          { scenario: "quota_exhausted" },
        ],
      },
    });
    const runs = [
      w.run(["--path", "math.js"]), // delegate -> codex
      w.run(["--path", "db/schema.sql"]), // pin -> host
      w.run(["--path", "secrets/key.txt"]), // pin -> reject
      w.run(["--path", "math.js"]), // delegate -> codex says quota_exhausted
      w.run(["--path", "math.js"]), // codex now unavailable -> host
    ];
    expect(runs.map((r) => r.result?.decisions[0]?.action)).toEqual([
      "delegate",
      "host",
      "reject",
      "delegate",
      "host",
    ]);
    expect(runs.map((r) => r.code)).toEqual([0, 0, 3, 0, 0]);

    for (const r of runs) {
      const runId = r.result?.runId ?? "";
      // A log: the run's record with its decision(s).
      const log = parseJson<LogJson>(w.dispatch(["logs", "--task", runId, "--json"]));
      expect(log.decisions, runId).toHaveLength(1);
      const decision = log.decisions[0];
      expect(decision?.decision.action).toBe(r.result?.decisions[0]?.action);
      expect(decision?.decision.reason).toBe(r.result?.decisions[0]?.reason);

      // Reproducible: replaying the stored input through today's router gives the same decision.
      const replay = w.dispatch(["explain", "--replay", decision?.id ?? "", "--json"]);
      expect(replay.code, replay.stderr).toBe(0);
      const out = parseJson<{ identical: boolean; diff: unknown[] }>(replay);
      expect(out.identical, runId).toBe(true);
      expect(out.diff, runId).toEqual([]);
      const text = w.dispatch(["explain", "--replay", decision?.id ?? ""]).stdout;
      expect(text).toContain(`Replay of decision ${decision?.id}`);
      expect(text).toContain("IDENTICAL");
    }
  });
});
