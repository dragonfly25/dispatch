import { describe, expect, it } from "vitest";
import { systemClock } from "../../src/core/clock.js";
import { ExitCode } from "../../src/core/contracts.js";
import { DispatchError, exitCodeOf } from "../../src/core/errors.js";
import { newRunId, RUN_ID_PATTERN, runIdTime } from "../../src/core/ids.js";
import { FakeClock } from "../stubs/index.js";

describe("systemClock", () => {
  it("returns wall time and a non-decreasing monotonic time", () => {
    const before = Date.now();
    expect(systemClock.now().getTime()).toBeGreaterThanOrEqual(before);
    const a = systemClock.monotonicMs();
    expect(systemClock.monotonicMs()).toBeGreaterThanOrEqual(a);
  });
});

describe("newRunId", () => {
  it("produces 26-char ids that encode the creation time", () => {
    const clock = new FakeClock("2026-03-04T05:06:07.890Z");
    const id = newRunId(clock);
    expect(id).toMatch(RUN_ID_PATTERN);
    expect(runIdTime(id).toISOString()).toBe("2026-03-04T05:06:07.890Z");
  });

  it("sorts by creation time", () => {
    const clock = new FakeClock();
    const ids = [] as string[];
    for (let i = 0; i < 50; i++) {
      ids.push(newRunId(clock));
      clock.advance(1);
    }
    expect([...ids].sort()).toEqual(ids);
  });

  it("is deterministic given clock and randomness", () => {
    const zeros = (n: number) => new Uint8Array(n);
    expect(newRunId(new FakeClock("1970-01-01T00:00:00.000Z"), zeros)).toBe("0".repeat(26));
  });

  it("uses the system clock by default and differs between calls", () => {
    expect(newRunId()).not.toBe(newRunId());
  });

  it("rejects invalid input", () => {
    expect(() => newRunId(new FakeClock("1960-01-01T00:00:00.000Z"))).toThrow(RangeError);
    expect(() => runIdTime("not-an-id")).toThrow(RangeError);
  });
});

describe("DispatchError", () => {
  it("carries an exit code and a stable code", () => {
    const err = new DispatchError("bad flag", ExitCode.USAGE, "cli.usage", { cause: "x" });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("DispatchError");
    expect(err.code).toBe("cli.usage");
    expect(err.cause).toBe("x");
    expect(exitCodeOf(err)).toBe(2);
  });

  it("defaults to FAILED", () => {
    expect(new DispatchError("boom").exitCode).toBe(ExitCode.FAILED);
    expect(exitCodeOf(new Error("other"))).toBe(ExitCode.FAILED);
  });
});
