/**
 * [UC4] Fallback on quota (spec §11 UC4). Verifica: three decisions are logged; the user sees in
 * `status` both providers unavailable with an estimated reset.
 *
 * Host: Claude Code (CLAUDECODE=1), profile `balance` (the default). Codex is under its hard limit
 * (the app-server reports 3% remaining < hard 5%): a delegable read-only task goes to Antigravity
 * (the only external provider that may take it), which answers `quota_exhausted`; the task returns
 * to the orchestrator with the reason. Three tasks in sequence give the three logged decisions.
 *
 * Lower-level proofs: test/unit/runner-orchestrate.test.ts ([UC4] x3), cli-status.test.ts,
 * quota-provider.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createWorld, parseJson, THREE_PROVIDERS, useBundles } from "./harness.js";

useBundles();

const HOST = { CLAUDECODE: "1" };
const EXHAUSTED = { scenario: "quota_exhausted" as const };

interface StatusJson {
  instances: {
    id: string;
    unavailableUntil: string | null;
    lastQuotaError: string | null;
    windows: { kind: string; remainingPct: number | null; resetAt: string | null }[];
  }[];
}

describe("[UC4] fallback on quota", () => {
  it("[UC4] codex under its hard limit -> agy (read-only) -> quota_exhausted -> back to the host", () => {
    const w = createWorld({
      global: THREE_PROVIDERS,
      env: HOST,
      scenarios: {
        agy: [EXHAUSTED],
        codex: [{ scenario: "success_edit", file: "math.js", content: "never runs\n" }],
        // 97% used = 3% remaining, below the default hard limit of 5%.
        "codex:app-server": { primaryUsed: 97, secondaryUsed: 40 },
      },
    });

    // Decision 1: a write task. Codex is under its hard limit, agy is read-only, claude is the
    // host: nothing can take it, so it stays on the orchestrator and nothing is spawned.
    const d1 = w.run(["--autonomy", "worktree", "--task-type", "test"]);
    expect(d1.code, d1.stderr).toBe(0);
    expect(d1.result).toMatchObject({ status: "returned_to_host", externalAgent: null });
    expect(d1.result?.decisions[0]?.action).toBe("host");

    // Decision 2: a read-only task goes to agy; agy has no quota left.
    const d2 = w.run(["--autonomy", "read-only", "--task-type", "review"]);
    expect(d2.code, d2.stderr).toBe(0);
    expect(d2.result).toMatchObject({
      status: "returned_to_host",
      outcome: "quota_exhausted",
      externalAgent: null,
    });
    expect(d2.result?.decisions[0]).toMatchObject({
      action: "delegate",
      targets: [{ instance: "antigravity" }],
    });
    const filtered = d2.result?.decisions[0]?.chain.find((c) => c.ruleId === "codex");
    expect(filtered?.effect).toMatch(/below hard limit \(remaining 3% < 5%\)/);
    // The orchestrator gets the reason, in the result and on its exit code (0: it proceeds natively).
    expect(d2.result?.summary).toMatch(/antigravity: quota_exhausted/);

    // Decision 3: the same again. agy is now marked unavailable, so no process is started at all.
    const d3 = w.run(["--autonomy", "read-only", "--task-type", "review"]);
    expect(d3.code, d3.stderr).toBe(0);
    expect(d3.result?.status).toBe("returned_to_host");
    expect(d3.result?.decisions[0]?.action).toBe("host");
    expect(d3.result?.summary).toMatch(/every fallback candidate was filtered out/);
    const unavailable = d3.result?.decisions[0]?.chain.find((c) => c.ruleId === "antigravity");
    expect(unavailable?.effect).toMatch(/unavailable until /);

    // Three decisions are logged, one per run, newest first in `logs`.
    const list = w.dispatch(["logs"]);
    const rows = list.stdout.split("\n").filter((l) => /^[0-9A-Z]{26} /.test(l));
    expect(rows).toHaveLength(3);
    for (const r of [d1, d2, d3]) {
      const log = w.dispatch(["logs", "--task", r.result?.runId ?? ""]);
      expect(log.stdout).toContain("Decisions (1):");
    }
    expect(w.dispatch(["logs", "--task", d2.result?.runId ?? ""]).stdout).toContain(
      "delegate fallback -> antigravity",
    );
    expect(w.dispatch(["logs", "--task", d3.result?.runId ?? ""]).stdout).toContain("host: host:");

    // Only agy was ever started (once); codex and claude never.
    expect(w.fakes.readLog({ cli: "agy", kind: "run" })).toHaveLength(1);
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toEqual([]);
    expect(w.fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);

    // status: agy unavailable with an estimated reset; codex shows 3% left and when it resets.
    const status = parseJson<StatusJson>(w.dispatch(["status", "--json"]));
    const agy = status.instances.find((i) => i.id === "antigravity");
    expect(agy?.unavailableUntil).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(Date.parse(agy?.unavailableUntil ?? "")).toBeGreaterThan(Date.now());
    expect(agy?.lastQuotaError).toMatch(/exhausted your quota/);
    const codexWindow = status.instances.find((i) => i.id === "codex")?.windows[0];
    expect(codexWindow?.remainingPct).toBe(3);
    expect(codexWindow?.resetAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    const text = w.dispatch(["status"]).stdout;
    expect(text).toMatch(/antigravity .*\n\s+unavailable until \d{4}-\d\d-\d\d \d\d:\d\d \(in /);
  });

  it("[UC4] both providers exhausted: status marks both unavailable with a reset and the task returns", () => {
    const w = createWorld({
      global: THREE_PROVIDERS,
      env: HOST,
      scenarios: { codex: [EXHAUSTED], agy: [EXHAUSTED] },
    });
    // preserve: codex first, then claude (the host, skipped), then antigravity for read-only tasks.
    w.writeGlobal(`${THREE_PROVIDERS}profile: preserve\n`);
    const r = w.run(["--autonomy", "read-only", "--task-type", "review"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ status: "returned_to_host", outcome: "quota_exhausted" });
    expect(r.result?.decisions[0]?.targets.map((t) => t.instance)).toEqual([
      "codex",
      "antigravity",
    ]);
    expect(r.result?.summary).toMatch(/codex: quota_exhausted.*antigravity: quota_exhausted/);

    const status = parseJson<StatusJson>(w.dispatch(["status", "--json"]));
    for (const id of ["codex", "antigravity"]) {
      const inst = status.instances.find((i) => i.id === id);
      expect(inst?.unavailableUntil, id).toMatch(/^\d{4}-\d\d-\d\dT/);
      expect(Date.parse(inst?.unavailableUntil ?? "")).toBeGreaterThan(Date.now());
    }
    const text = w.dispatch(["status"]).stdout;
    expect(text.match(/unavailable until \d{4}-\d\d-\d\d \d\d:\d\d/g)).toHaveLength(2);
    // The next task does not touch either CLI: both are filtered before anything starts.
    const again = w.run(["--autonomy", "read-only"]);
    expect(again.result?.status).toBe("returned_to_host");
    expect(w.fakes.readLog({ cli: "codex", kind: "run" })).toHaveLength(1);
    expect(w.fakes.readLog({ cli: "agy", kind: "run" })).toHaveLength(1);
  });
});
