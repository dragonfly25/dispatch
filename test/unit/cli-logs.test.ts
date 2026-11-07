import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideForTest } from "./cli-logs.fixtures.js";
import { event, HOUR, iso, MIN, opsHarness, runRecord } from "./cli-ops.helpers.js";

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC";
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe("logs", () => {
  it("lists recent runs, newest first, with outcome, duration and patch state", async () => {
    const h = opsHarness();
    await h.store.recordRun(runRecord("run-old", { createdAt: iso(-2 * HOUR) }));
    await h.store.recordRun(
      runRecord("run-fail", {
        createdAt: iso(-1 * HOUR),
        instance: "claude-alt",
        result: { outcome: "failed", durationMs: 125_000, patch: null },
      }),
    );
    await h.store.recordRun(runRecord("run-live", { status: "running", createdAt: iso(-MIN) }));

    const r = await h.run(["logs"]);
    expect(r.code).toBe(0);
    const lines = r.out.trimEnd().split("\n");
    expect(lines[0]).toMatch(/^run +started +instance +outcome +duration +patch applies$/);
    expect(lines[1]).toMatch(/^run-live +2026-11-07 09:59 +codex +running +- +-$/);
    expect(lines[2]).toMatch(/^run-fail +2026-11-07 09:00 +claude-alt +failed +2m +-$/);
    expect(lines[3]).toMatch(/^run-old +2026-11-07 08:00 +codex +success +4s +yes$/);

    const limited = await h.run(["logs", "--limit", "1", "--json"]);
    const rows = JSON.parse(limited.out);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ runId: "run-live", status: "running", patchApplies: null });
  });

  it("[SEC-network] shows the sandbox network decision of a run that has one", async () => {
    const h = opsHarness();
    const sandboxNetwork = {
      enabled: true,
      scope: "delegated-agents",
      agent: "builder",
      reason: "delegated agent builder (network: delegated-agents)",
    };
    await h.store.recordRun(runRecord("run-net", { result: { sandboxNetwork } as never }));
    await h.store.recordRun(runRecord("run-plain"));
    const r = await h.run(["logs", "--task", "run-net"]);
    expect(r.out).toContain(
      "  sandbox network on (delegated agent builder (network: delegated-agents))",
    );
    const json = JSON.parse((await h.run(["logs", "--task", "run-net", "--json"])).out);
    expect(json.run.result.sandboxNetwork).toEqual(sandboxNetwork);
    expect((await h.run(["logs", "--task", "run-plain"])).out).not.toContain("sandbox network");
  });

  it("says so when nothing was recorded", async () => {
    const r = await opsHarness().run(["logs"]);
    expect(r.out).toBe("no recorded runs\n");
  });

  it("rejects a bad --limit", async () => {
    const r = await opsHarness().run(["logs", "--limit", "0"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--limit must be a positive integer");
  });

  describe("--task", () => {
    async function seed() {
      const h = opsHarness();
      await h.store.recordRun(runRecord("run-1", { result: { summary: "Added 3 tests" } }));
      await h.store.recordRun(runRecord("run-2"));
      await decideForTest(h.store, "run-1");
      await h.store.appendEvent("run-1", event("reading", 1000, { path: "src/a.ts" }));
      await h.store.appendEvent("run-1", event("running", 2000, { detail: "pnpm test" }));
      await h.store.appendEvent("run-1", event("done", 3000));
      await h.store.appendEvent("run-2", event("error", 1000, { detail: "other run" }));
      return h;
    }

    it("shows one run's decisions and events, and only its own", async () => {
      const h = await seed();
      const r = await h.run(["logs", "--task", "run-1"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Run run-1: completed (success)");
      expect(r.out).toContain("patch /home/u/.dispatch/runs/01KA/patch.diff (applies: yes)");
      expect(r.out).toContain("summary (untrusted external output): Added 3 tests");
      expect(r.out).toMatch(
        /Decisions \(1\):\n {2}2026-11-07 10:00 {2}dec-run-1 {2}delegate fallback -> codex, agy, claude-alt: /,
      );
      expect(r.out).toContain("Events (3):");
      expect(r.out).toMatch(/ {2}10:00:01 {2}reading +src\/a\.ts/);
      expect(r.out).toMatch(/ {2}10:00:02 {2}running +pnpm test/);
      expect(r.out).not.toContain("other run");
    });

    it("--json carries the run, decisions and events as stored", async () => {
      const h = await seed();
      const j = JSON.parse((await h.run(["logs", "--task", "run-1", "--json"])).out);
      expect(j.run.runId).toBe("run-1");
      expect(j.decisions).toHaveLength(1);
      expect(j.decisions[0].runId).toBe("run-1");
      expect(j.events.map((e: { kind: string }) => e.kind)).toEqual(["reading", "running", "done"]);
    });

    it("stored events are the redacted ones", async () => {
      const h = opsHarness();
      await h.store.recordRun(runRecord("run-s"));
      await h.store.appendEvent(
        "run-s",
        event("running", 0, {
          detail:
            "curl -H 'Authorization: Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789'",
        }),
      );
      const r = await h.run(["logs", "--task", "run-s"]);
      expect(r.out).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
    });

    it("an unknown run exits 2", async () => {
      const r = await opsHarness().run(["logs", "--task", "nope"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("no such run: nope");
    });

    it("a running run shows no duration yet", async () => {
      const h = opsHarness();
      await h.store.recordRun(runRecord("run-r", { status: "running" }));
      const r = await h.run(["logs", "--task", "run-r"]);
      expect(r.out).toContain("Run run-r: running");
      expect(r.out).not.toContain("duration");
    });
  });

  describe("--follow", () => {
    it("tails new events and terminates when the run completes", async () => {
      let polls = 0;
      const h = opsHarness({
        async sleep() {
          polls++;
          if (polls === 1)
            await h.store.appendEvent("run-f", event("editing", 2000, { path: "b.ts" }));
          if (polls === 2) {
            await h.store.appendEvent("run-f", event("done", 3000));
            await h.store.updateRun("run-f", {
              status: "completed",
              result: runRecord("run-f").result,
            });
          }
        },
      });
      await h.store.recordRun(runRecord("run-f", { status: "running" }));
      await h.store.appendEvent("run-f", event("reading", 1000, { path: "a.ts" }));

      const r = await h.run(["logs", "--follow", "--task", "run-f"]);
      expect(r.code).toBe(0);
      expect(polls).toBe(2);
      const lines = r.out.trimEnd().split("\n");
      expect(lines).toEqual([
        "run-f  10:00:01  reading   a.ts",
        "run-f  10:00:02  editing   b.ts",
        "run-f  10:00:03  done",
        "run-f  finished: success",
      ]);
    });

    it("without --task follows every running run, including ones that start meanwhile", async () => {
      let polls = 0;
      const h = opsHarness({
        async sleep() {
          polls++;
          if (polls === 1) {
            await h.store.recordRun(runRecord("run-b", { status: "running" }));
            await h.store.appendEvent("run-b", event("thinking", 2000));
            await h.store.updateRun("run-a", { status: "rejected", result: null });
          }
          if (polls === 2) await h.store.updateRun("run-b", { status: "returned_to_host" });
        },
      });
      await h.store.recordRun(runRecord("run-a", { status: "running" }));
      await h.store.recordRun(runRecord("old", { status: "completed" }));
      await h.store.appendEvent("old", event("done", 0));
      await h.store.appendEvent("run-a", event("reading", 1000));

      const r = await h.run(["logs", "--follow", "--json"]);
      expect(r.code).toBe(0);
      const msgs = r.out
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(msgs.map((m) => m.runId + (m.finished ? ":finished" : ""))).toEqual([
        "run-a",
        "run-a:finished",
        "run-b",
        "run-b:finished",
      ]);
      expect(msgs[1].finished).toMatchObject({ status: "rejected", outcome: "rejected" });
    });

    it("returns at once when nothing is running", async () => {
      const h = opsHarness({
        async sleep() {
          throw new Error("must not sleep");
        },
      });
      const r = await h.run(["logs", "--follow"]);
      expect(r.code).toBe(0);
      expect(r.out).toBe("");
    });

    it("an already finished run prints its events once and ends", async () => {
      const h = opsHarness({
        async sleep() {
          throw new Error("must not sleep");
        },
      });
      await h.store.recordRun(runRecord("run-d"));
      await h.store.appendEvent("run-d", event("done", 1000));
      const r = await h.run(["logs", "--follow", "--task", "run-d"]);
      expect(r.out).toBe("run-d  10:00:01  done\nrun-d  finished: success\n");
    });

    it("an unknown run exits 2", async () => {
      const r = await opsHarness().run(["logs", "--follow", "--task", "ghost"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("no such run: ghost");
    });

    it("sleeps 500 ms between polls by default injection point", async () => {
      const waits: number[] = [];
      const h = opsHarness({
        async sleep(ms) {
          waits.push(ms);
          await h.store.updateRun("run-p", {
            status: "completed",
            result: runRecord("run-p").result,
          });
        },
      });
      await h.store.recordRun(runRecord("run-p", { status: "running" }));
      await h.run(["logs", "--follow", "--task", "run-p"]);
      expect(waits).toEqual([500]);
    });
  });
});
