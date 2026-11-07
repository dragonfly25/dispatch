/** Live finding: read-only commands must leave no trace when Dispatch was never set up. */
import { existsSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { harness } from "./cli-read.helpers.js";
import { doctorHarness } from "./doctor.helpers.js";

describe("read-only commands create no state", () => {
  const READ_ONLY: string[][] = [
    ["status"],
    ["status", "--json"],
    ["status", "--compare"],
    ["providers"],
    ["profiles"],
    ["validate"],
    ["logs"],
    ["explain", "--task", "fix a typo"],
  ];

  for (const args of READ_ONLY) {
    it(`[AC-notrace] dispatch ${args.join(" ")} does not create DISPATCH_HOME`, async () => {
      const h = harness();
      const r = await h.run(args, { env: { CLAUDECODE: "1" } });
      expect(r.code, r.err).toBe(0);
      expect(existsSync(h.sb.dispatchHome)).toBe(false);
    });
  }

  it("[AC-notrace] logs --task <unknown> fails cleanly without creating state", async () => {
    const h = harness();
    const r = await h.run(["logs", "--task", "nope"]);
    expect(r.code).not.toBe(0);
    expect(existsSync(h.sb.dispatchHome)).toBe(false);
  });

  it("[AC-notrace] status --set still creates the database (it records state)", async () => {
    const h = harness();
    const r = await h.run(["status", "--set", "claude", "40"]);
    expect(r.code, r.err).toBe(0);
    expect(existsSync(`${h.sb.dispatchHome}/state/dispatch.db`)).toBe(true);
  });
});

describe("doctor", () => {
  let d: ReturnType<typeof doctorHarness>;
  afterEach(() => d?.cleanup());

  it("[AC-notrace] does not create DISPATCH_HOME on a machine that was never set up", async () => {
    d = doctorHarness();
    rmSync(d.home.dispatchHome, { recursive: true, force: true });
    await d.run(["doctor", "--json"]);
    expect(existsSync(d.home.dispatchHome)).toBe(false);
  });
});

describe("status with a run id", () => {
  it("points at logs/wait instead of the --set message", async () => {
    const h = harness();
    const r = await h.run(["status", "01HZZZZZZZZZZZZZZZZZZZZZZZ"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("dispatch logs --task 01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(r.err).toContain("dispatch wait 01HZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(r.err).not.toContain("only make sense with --set");
  });

  it("keeps the --set message for a bare percentage", async () => {
    const h = harness();
    const r = await h.run(["status", "40"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("only make sense with --set");
  });
});
