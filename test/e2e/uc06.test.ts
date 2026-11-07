/**
 * [UC6] Unspecified model (spec §11 UC6). Verifica: `explain` shows both paths: with
 * `unspecified_model: balanced` the external agent gets tier `balanced` even if the session runs
 * Opus; with `inherit` it would get `max`. Deviation 12: `balanced` is the default because the host
 * session model usually cannot be observed; when `inherit` has nothing to inherit, the decision
 * says so (`decided_without: session_model`).
 *
 * Lower-level proofs: test/unit/router/explain.test.ts (snapshots), test/unit/cli-explain.test.ts,
 * test/unit/config/validate.test.ts ([UC6]).
 */
import { describe, expect, it } from "vitest";
import { createWorld, EDIT_CODEX, parseJson, THREE_PROVIDERS, useBundles } from "./harness.js";

useBundles();

const HOST = { CLAUDECODE: "1" };
const OPUS = "claude-opus-5-5";

interface ExplainJson {
  decision: {
    action: string;
    targets: { instance: string; tier: string; model: string }[];
    chain: { ruleId: string; effect: string; note?: string }[];
  };
}

const explain = (w: ReturnType<typeof createWorld>, ...extra: string[]) =>
  parseJson<ExplainJson>(w.dispatch(["explain", "--json", "--task", "write tests", ...extra]));

describe("[UC6] unspecified model", () => {
  it("[UC6] balanced (default): an Opus session still gives the external agent tier balanced", () => {
    const w = createWorld({ global: THREE_PROVIDERS, env: HOST });
    const e = explain(w, "--session-model", OPUS);
    expect(e.decision.targets[0]).toMatchObject({
      instance: "codex",
      tier: "balanced",
      model: "gpt-6-sol",
    });
    expect(e.decision.chain.find((c) => c.ruleId.startsWith("tier:"))?.ruleId).toBe(
      "tier:unspecified:balanced",
    );
    expect(w.dispatch(["explain", "--task", "x", "--session-model", OPUS]).stdout).toContain(
      "Requested model: (unspecified: balanced)",
    );
  });

  it("[UC6] inherit: the same Opus session gives tier max; without an observed session it says why", () => {
    const w = createWorld({ global: `${THREE_PROVIDERS}unspecified_model: inherit\n`, env: HOST });
    const e = explain(w, "--session-model", OPUS);
    expect(e.decision.targets[0]).toMatchObject({
      instance: "codex",
      tier: "max",
      model: "gpt-6.1-sol",
    });
    expect(e.decision.chain.find((c) => c.ruleId === "tier:unspecified:inherit")?.note).toContain(
      `session model ${OPUS}`,
    );
    // No session model (Claude's SessionStart carries none): the fallback is logged, not silent.
    const blind = explain(w);
    expect(blind.decision.targets[0]?.tier).toBe("balanced");
    expect(blind.decision.chain.find((c) => c.ruleId === "tier:unspecified:inherit")?.note).toMatch(
      /decided_without: session_model \(session model absent\)/,
    );
  });

  it("[UC6] a real run hands the external CLI the balanced model and its decision replays", () => {
    const w = createWorld({
      global: `${THREE_PROVIDERS}unspecified_model: inherit\n`,
      env: HOST,
      scenarios: EDIT_CODEX,
    });
    const r = w.run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.result?.decisions[0]?.targets[0]).toMatchObject({ tier: "balanced" });
    const codexRun = w.fakes.readLog({ cli: "codex", kind: "run" })[0];
    const model = codexRun?.argv[codexRun.argv.indexOf("-m") + 1];
    expect(model).toBe("gpt-6-sol");
    // The decision, with its decided_without note, is stored and replays to the same outcome.
    const replay = w.dispatch(["explain", "--json", "--replay", decisionId(w, r.result?.runId)]);
    expect(replay.code, replay.stderr).toBe(0);
    expect(JSON.stringify(parseJson(replay))).toContain("decided_without: session_model");
  });

  it("[UC6] an explicit requested model beats unspecified_model (tier from the model's family)", () => {
    const w = createWorld({ global: `${THREE_PROVIDERS}unspecified_model: inherit\n`, env: HOST });
    const e = explain(w, "--model", "claude-haiku-5-5");
    expect(e.decision.targets[0]).toMatchObject({ tier: "fast", model: "gpt-6-luna" });
  });
});

function decisionId(w: ReturnType<typeof createWorld>, runId: string | undefined): string {
  const text = w.dispatch(["logs", "--task", runId ?? ""]).stdout;
  const m = /^\s+\d{4}-\d\d-\d\d \d\d:\d\d\s+([0-9A-Z]{26})\s/m.exec(text);
  if (!m?.[1]) throw new Error(`no decision id in:\n${text}`);
  return m[1];
}
