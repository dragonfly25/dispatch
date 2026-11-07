/**
 * [UC11] Broken quota channel (spec §11 UC11) and AC4 (everything works with all readers off).
 * Verifica: no crash, routing is never blocked; `doctor` flags the channel; `status` shows `stale`
 * with the last good reading; the router uses the internal estimate.
 *
 * The fake `codex app-server` first answers normally (a good reading is stored), then changes its
 * format. Lower-level proofs: test/unit/quota-readers-integration.test.ts ([UC11] x4),
 * doctor.test.ts, cli-status.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  createWorld,
  EDIT_CODEX,
  HELP,
  parseJson,
  THREE_PROVIDERS,
  useBundles,
} from "./harness.js";

useBundles();

/** `cache_minutes: 0` makes every command read the channel again (no fresh-reading shortcut). */
const NO_CACHE = `${THREE_PROVIDERS}quota:\n  cache_minutes: 0\n`;

interface StatusJson {
  instances: {
    id: string;
    lastGoodReading: string | null;
    readerProblems: { readerId: string; error: string }[];
    windows: { kind: string; remainingPct: number | null; reliability: string; source: string }[];
  }[];
}

describe("[UC11] a provider's quota channel breaks", () => {
  it("[UC11] changed format: doctor flags it, status shows stale with the last good reading, routing continues", () => {
    const w = createWorld({ global: NO_CACHE, scenarios: EDIT_CODEX });
    // 1. Healthy: a real reading is stored.
    const good = parseJson<StatusJson>(w.dispatch(["status", "--json"]));
    const before = good.instances.find((i) => i.id === "codex");
    expect(before?.windows[0]).toMatchObject({ reliability: "real", source: "codex-app-server" });
    expect(before?.readerProblems).toEqual([]);

    // Read-only commands leave no trace; a delegated run stores the reading it routed on.
    expect(w.run().result?.status).toBe("completed");

    // 2. The endpoint changes format.
    w.fakes.setScenarios({
      ...HELP,
      ...EDIT_CODEX,
      "codex:app-server": { variant: "changed_format" },
    });

    // doctor flags the channel, says routing continues, and still ran every other check.
    const doctor = w.dispatch(["doctor", "--json"]);
    expect(doctor.code).toBe(4);
    const checks = parseJson<{ checks: { id: string; status: string; message: string }[] }>(
      doctor,
    ).checks;
    const quota = checks.find((c) => c.id === "codex.quota");
    expect(quota?.status).toBe("fail");
    expect(quota?.message).toContain("format changed");
    expect(quota?.message).toContain("Routing continues on estimates");
    expect(checks.find((c) => c.id === "codex.login")?.status).toBe("ok");
    expect(checks.find((c) => c.id === "claude.binary")?.status).toBe("ok");

    // status: stale, with the last good reading and the channel error; no crash (exit 0).
    const sj = w.dispatch(["status", "--json"]);
    expect(sj.code).toBe(0);
    const codex = parseJson<StatusJson>(sj).instances.find((i) => i.id === "codex");
    expect(codex?.lastGoodReading).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(codex?.readerProblems[0]).toMatchObject({ readerId: "codex-app-server" });
    expect(codex?.readerProblems[0]?.error).toMatch(/format changed/);
    expect(codex?.windows.every((x) => x.reliability !== "real")).toBe(true);
    const text = w.dispatch(["status"]).stdout;
    expect(text).toMatch(
      /reader codex-app-server: stale — last good reading \d{4}-\d\d-\d\d \d\d:\d\d, channel error: .*format changed/,
    );
    expect(text).toMatch(/\[(stale|estimated)\]/);

    // 3. Routing is not blocked: the task is delegated to codex on the internal estimate.
    const r = w.run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.result).toMatchObject({ status: "completed", outcome: "success" });
    expect(r.result?.externalAgent?.instance).toBe("codex");
  });

  it.each(["always_zero", "garbage"] as const)(
    "[UC11] app-server variant %s: nothing crashes, status says the channel is bad, the task still runs",
    (variant) => {
      const w = createWorld({
        global: NO_CACHE,
        scenarios: { ...EDIT_CODEX, "codex:app-server": { variant } },
      });
      const s = w.dispatch(["status", "--json"]);
      expect(s.code).toBe(0);
      expect(w.run().result?.status).toBe("completed");
    },
  );
});

describe("[AC4] every quota reader disabled", () => {
  const OFF = `${THREE_PROVIDERS}quota:
  readers:
    claude: { enabled: false }
    codex: { enabled: false }
    antigravity: { enabled: false }
`;

  it("[AC4] the system still delegates, estimates, and handles quota_exhausted", () => {
    const w = createWorld({
      global: OFF,
      scenarios: {
        codex: [
          { scenario: "success_edit", file: "math.js", content: "changed by codex\n" },
          { scenario: "quota_exhausted" },
        ],
        claude: [{ scenario: "quota_exhausted" }],
        "codex:app-server": { variant: "garbage" },
      },
    });
    // Delegation works, with no reader consulted at all.
    const first = w.run();
    expect(first.code, first.stderr).toBe(0);
    expect(first.result).toMatchObject({ status: "completed", outcome: "success" });
    expect(w.fakes.readLog({ cli: "codex", key: "app-server" })).toEqual([]);
    // status shows estimates only, no reader problems, exit 0.
    const status = parseJson<StatusJson>(w.dispatch(["status", "--json"]));
    for (const inst of status.instances) {
      expect(inst.readerProblems, inst.id).toEqual([]);
      for (const win of inst.windows) expect(win.reliability, inst.id).not.toBe("real");
    }
    // doctor does not call a switched-off reader a failure.
    const doctor = w.dispatch(["doctor", "--json"]);
    const q = parseJson<{ checks: { id: string; status: string; message: string }[] }>(
      doctor,
    ).checks.filter((c) => c.id.endsWith(".quota"));
    expect(q.length).toBeGreaterThan(0);
    for (const c of q) {
      expect(c.status, c.id).not.toBe("fail");
      expect(c.message, c.id).toContain("disabled");
    }
    // The provider says it is out of quota: the task goes back to the orchestrator, and the
    // router remembers the exhaustion from then on.
    const second = w.run();
    expect(second.code).toBe(0);
    expect(second.result).toMatchObject({ status: "returned_to_host", outcome: "quota_exhausted" });
    const third = w.run();
    expect(third.result?.status).toBe("returned_to_host");
    expect(
      w.fakes.readLog({ cli: "codex", kind: "run" }).filter((c) => c.args.includes("--json")),
    ).toHaveLength(2);
  });
});
