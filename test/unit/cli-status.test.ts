import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DAY,
  failingReader,
  HOUR,
  iso,
  MIN,
  NOW,
  opsHarness,
  reading,
  THREE_PROVIDERS,
} from "./cli-ops.helpers.js";
import { seedDecision } from "./shadow/helpers.js";

const savedTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = "UTC"; // local time in the output is then predictable
});
afterAll(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

const HOST = { CLAUDECODE: "1" };

describe("status", () => {
  it("[UC4] shows two exhausted providers as unavailable until their reset", async () => {
    const h = opsHarness();
    h.sb.global(THREE_PROVIDERS);
    h.store.recordQuotaReading(
      "codex",
      reading({ kind: "5h", usedPct: 100, resetAt: iso(2 * HOUR + 30 * MIN) }),
    );
    h.store.recordQuotaSignal("codex", iso(2 * HOUR + 30 * MIN), "You've hit your usage limit");
    h.store.recordQuotaReading(
      "antigravity",
      reading({ kind: "weekly:gemini", usedPct: 100, resetAt: iso(2 * DAY) }),
    );
    h.store.recordQuotaSignal("antigravity", iso(2 * DAY), "AGY_ERROR: quota");

    const r = await h.run(["status"], { env: HOST });
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "unavailable until 2026-11-07 12:30 (in 2h 30m) — You've hit your usage limit",
    );
    expect(r.out).toContain("unavailable until 2026-11-09 10:00 (in 2d) — AGY_ERROR: quota");
    expect(r.out).toMatch(
      /5h +\[-{10}\] +0% remaining +resets in 2h 30m \(2026-11-07 12:30\) +\[real\] +source fake-reader/,
    );

    const json = JSON.parse((await h.run(["status", "--json"], { env: HOST })).out);
    const byId = Object.fromEntries(json.instances.map((i: { id: string }) => [i.id, i]));
    expect(byId.codex.unavailableUntil).toBe(iso(2 * HOUR + 30 * MIN));
    expect(byId.antigravity.unavailableUntil).toBe(iso(2 * DAY));
    expect(byId.claude.unavailableUntil).toBeNull();
  });

  it("lists pool, plan, host marker, profile, repo and the experimental agy disclosure", async () => {
    const h = opsHarness();
    h.sb.global(THREE_PROVIDERS);
    const r = await h.run(["status"], { env: HOST });
    expect(r.out).toContain("Profile: balance   host claude-code (instance claude)");
    expect(r.out).toContain("Repo: no repo policy");
    expect(r.out).toContain(
      "claude  (claude)  enabled  pool subscription  plan max5x  (host — interactive usage not visible)",
    );
    expect(r.out).toContain("codex  (codex)  enabled  pool subscription  plan plus\n");
    expect(r.out).toContain("antigravity  (antigravity)  enabled  pool subscription  experimental");
    expect(r.out).toMatch(/Experimental: antigravity is enabled — experimental and read-only/);
    // nothing known yet: unknown windows, never invented numbers
    expect(r.out).toMatch(/5h +\[\.{10}\] +unknown +reset unknown +\[unknown\]/);
  });

  it("without a host nothing is marked as the host; a disabled agy is listed but not read", async () => {
    const h = opsHarness();
    const r = await h.run(["status"]);
    expect(r.out).toContain("no host detected");
    expect(r.out).not.toContain("interactive usage not visible");
    expect(r.out).toContain("antigravity  (antigravity)  disabled");
    expect(r.out).toContain("disabled: not read");
    expect(r.out).not.toContain("Experimental:");
  });

  it("estimates never apply to the host (real or unknown only)", async () => {
    const h = opsHarness();
    h.sb.global(THREE_PROVIDERS);
    const json = JSON.parse((await h.run(["status", "--json"], { env: HOST })).out);
    const claude = json.instances.find((i: { id: string }) => i.id === "claude");
    expect(claude.host).toBe(true);
    for (const w of claude.windows) expect(["real", "unknown"]).toContain(w.reliability);
  });

  it("flags an untrusted repo policy", async () => {
    const h = opsHarness();
    const repo = h.sb.repo("proj", { ".dispatch/config.yaml": "version: 1\nprofile: preserve\n" });
    const r = await h.run(["status"], { cwd: repo });
    expect(r.out).toContain("Repo: repo policy NOT trusted, ignored");
    const json = JSON.parse((await h.run(["status", "--json"], { cwd: repo })).out);
    expect(json.repo).toEqual({ status: "untrusted", trusted: false });
  });

  it("on a terminal: colored meters by threshold; --json stays byte-identical", async () => {
    const h = opsHarness();
    h.sb.global(THREE_PROVIDERS);
    h.store.recordQuotaReading("codex", reading({ kind: "5h", usedPct: 97 }));
    h.store.recordQuotaReading("claude", reading({ kind: "5h", usedPct: 10 }));
    const r = await h.run(["status"], { env: HOST, decorate: true });
    expect(r.code).toBe(0);
    // codex: 3% remaining is under the default hard limit (5): red; claude 90%: green.
    const esc = String.fromCharCode(27);
    expect(r.out).toContain(`${esc}[31m${"░".repeat(10)}${esc}[39m`);
    expect(r.out).toContain(`${esc}[32m${"█".repeat(9)}░${esc}[39m`);
    expect(r.out).toContain("resets ");
    const plain = await h.run(["status", "--json"], { env: HOST });
    const decorated = await h.run(["status", "--json"], { env: HOST, decorate: true });
    expect(decorated.out).toBe(plain.out);
  });

  describe("[UC11] broken reading channels", () => {
    it("a failing channel shows stale, the last good reading and the error", async () => {
      const h = opsHarness({ readers: [failingReader("codex-app-server", "format changed")] });
      h.sb.global(THREE_PROVIDERS);
      const lastGood = iso(-HOUR);
      h.store.recordQuotaReading(
        "codex",
        reading({ kind: "5h", usedPct: 55, readAt: lastGood, source: "codex-app-server" }),
      );
      const r = await h.run(["status"], { env: HOST });
      expect(r.code).toBe(0);
      expect(r.out).toMatch(/5h +\[#{5}-{5}\] +45% remaining .*\[stale\]/);
      expect(r.out).toContain(
        "reader codex-app-server: stale — last good reading 2026-11-07 09:00, channel error: format changed",
      );
      const json = JSON.parse((await h.run(["status", "--json"], { env: HOST })).out);
      const codex = json.instances.find((i: { id: string }) => i.id === "codex");
      expect(codex.lastGoodReading).toBe(lastGood);
      expect(codex.readerProblems[0]).toMatchObject({
        readerId: "codex-app-server",
        error: "format changed",
      });
    });

    it("a channel that never delivered says so", async () => {
      const h = opsHarness({ readers: [failingReader("codex-app-server", "timed out")] });
      h.sb.global(THREE_PROVIDERS);
      const r = await h.run(["status"], { env: HOST });
      expect(r.out).toContain("reader codex-app-server: no reading — channel error: timed out");
    });

    it("a reading that just got old is stale even without a failing channel", async () => {
      const h = opsHarness();
      h.sb.global(THREE_PROVIDERS);
      h.store.recordQuotaReading("codex", reading({ usedPct: 20, readAt: iso(-2 * HOUR) }));
      const r = await h.run(["status"], { env: HOST });
      expect(r.out).toContain("stale — last good reading 2026-11-07 08:00\n");
    });
  });

  describe("--set", () => {
    it("overrides the remaining % in status, then expires", async () => {
      const h = opsHarness();
      h.sb.global(THREE_PROVIDERS);
      const set = await h.run(["status", "--set", "codex", "40%", "--ttl", "2h"], { env: HOST });
      expect(set.code).toBe(0);
      expect(set.out).toBe("codex: 40% remaining (all windows) until 2026-11-07 12:00\n");

      const during = await h.run(["status"], { env: HOST });
      expect(during.out).toMatch(/5h +\[#{4}-{6}\] +40% remaining .*\[real\] +source manual/);
      expect(during.out).toMatch(/weekly +\[#{4}-{6}\] +40% remaining .*source manual/);

      h.clock.advance(3 * HOUR);
      const after = await h.run(["status"], { env: HOST });
      expect(after.out).not.toContain("source manual");
      expect(after.out).toMatch(/5h +\[\.{10}\] +unknown/);
    });

    it("--window limits the override to one window; a plain number works", async () => {
      const h = opsHarness();
      h.sb.global(THREE_PROVIDERS);
      const set = await h.run(["status", "--set", "claude", "75", "--window", "7d", "--json"]);
      expect(JSON.parse(set.out)).toMatchObject({
        instanceId: "claude",
        window: "7d",
        usedPct: 25,
        remainingPct: 75,
      });
      const out = (await h.run(["status"], { env: HOST })).out;
      expect(out).toMatch(/7d +\[#{8}-{2}\] +75% remaining .*source manual/);
      expect(out).toMatch(/5h +\[\.{10}\] +unknown/);
      expect(out).not.toContain("\x1b[");
    });

    it("rejects bad input with exit 2", async () => {
      const h = opsHarness();
      h.sb.global(THREE_PROVIDERS);
      const cases: [string[], RegExp][] = [
        [
          ["--set", "ghost", "40"],
          /unknown instance "ghost" \(known: claude, codex, antigravity\)/,
        ],
        [["--set", "codex", "140"], /between 0 and 100/],
        [["--set", "codex", "lots"], /between 0 and 100/],
        [["--set", "codex"], /--set needs a percentage/],
        [["--set", "codex", "40", "--ttl", "soon"], /--ttl must be a duration/],
        [["40"], /only make sense with --set/],
        [["--ttl", "1h"], /only make sense with --set/],
        [["--set", "codex", "40", "--compare"], /either --set or --compare/],
        [["--since", "7d"], /--since needs --compare/],
      ];
      for (const [args, message] of cases) {
        const r = await h.run(["status", ...args]);
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.err).toMatch(message);
      }
    });
  });

  describe("[UC8] --compare", () => {
    it("aggregates the recorded decisions per profile, labelled estimated", async () => {
      const h = opsHarness();
      for (let i = 0; i < 6; i++) await seedDecision(h.store, i);
      const r = await h.run(["status", "--compare"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("Dispatch status --compare (all recorded decisions)");
      expect(r.out).toContain("Real decisions: 6. All figures are ESTIMATED");
      expect(r.out).toMatch(/^profile +tasks +delegated/m);
      expect(r.out).toMatch(/^balance\*/m);
      expect(r.out).toMatch(/^preserve /m);
      expect(r.out).toContain("Host consumption: not observable");

      const json = JSON.parse((await h.run(["status", "--compare", "--json"])).out);
      expect(json).toMatchObject({ empty: false, decisions: 6, estimated: true });
      expect(json.profiles.map((p: { profile: string }) => p.profile)).toEqual([
        "balance",
        "preserve",
      ]);
    });

    it("--since looks back from now", async () => {
      const h = opsHarness();
      await seedDecision(h.store, 0);
      h.clock.advance(10 * DAY);
      const none = await h.run(["status", "--compare", "--since", "7d"]);
      expect(none.out).toContain("no recorded decisions");
      const all = await h.run(["status", "--compare", "--since", "30d", "--json"]);
      expect(JSON.parse(all.out).decisions).toBe(1);
    });

    it("an empty log prints 'no recorded decisions' and nothing else happens", async () => {
      const h = opsHarness();
      const r = await h.run(["status", "--compare"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain("no recorded decisions");
      expect(r.out).toContain("Nothing was executed");
      const json = JSON.parse((await h.run(["status", "--compare", "--json"])).out);
      expect(json).toMatchObject({ empty: true, message: "no recorded decisions", profiles: [] });
    });

    it("rejects a bad --since with exit 2", async () => {
      const r = await opsHarness().run(["status", "--compare", "--since", "yesterday"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("--since must be a duration");
    });
  });
});

describe("time helpers", () => {
  it("[UC4] relative times read naturally in both directions", async () => {
    const { formatRelative, formatSpan, parseDuration } = await import("../../src/cli/time.js");
    const now = new Date(NOW);
    expect(formatRelative(iso(0), now)).toBe("now");
    expect(formatRelative(iso(-5 * MIN), now)).toBe("5m ago");
    expect(formatRelative(iso(30_000), now)).toBe("in 30s");
    expect(formatRelative(iso(3 * HOUR + 20 * MIN), now)).toBe("in 3h 20m");
    expect(formatRelative("garbage", now)).toBe("garbage");
    expect(formatSpan(26 * HOUR)).toBe("1d 2h");
    expect(parseDuration("1.5h", "--x")).toBe(90 * MIN);
    expect(parseDuration("2w", "--x")).toBe(14 * DAY);
    expect(() => parseDuration("0h", "--x")).toThrow(/--x must be a duration/);
    expect(() => parseDuration("12", "--x")).toThrow();
  });
});
