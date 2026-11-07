import { describe, expect, it } from "vitest";
import { ExitCode } from "../../src/core/contracts.js";
import { DispatchError } from "../../src/core/errors.js";
import {
  assertDepthAllowed,
  currentDepth,
  RecursionRejectedError,
} from "../../src/runner/depth.js";

describe("recursion depth guard [UC13]", () => {
  it("[UC13] treats an unset or empty DISPATCH_DEPTH as depth 0 and allows it", () => {
    expect(currentDepth({})).toBe(0);
    expect(currentDepth({ DISPATCH_DEPTH: "" })).toBe(0);
    expect(currentDepth({ DISPATCH_DEPTH: undefined })).toBe(0);
    expect(assertDepthAllowed({}, 1)).toBe(0);
  });

  it("[UC13] refuses when DISPATCH_DEPTH >= max_depth with outcome rejected / reason recursion", () => {
    let caught: unknown;
    try {
      assertDepthAllowed({ DISPATCH_DEPTH: "1" }, 1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RecursionRejectedError);
    expect(caught).toBeInstanceOf(DispatchError);
    const e = caught as RecursionRejectedError;
    expect(e.outcome).toBe("rejected");
    expect(e.reason).toBe("recursion");
    expect(e.exitCode).toBe(ExitCode.REJECTED);
    expect(e.code).toBe("run.depth_exceeded");
    expect(e.depth).toBe(1);
    expect(e.maxDepth).toBe(1);
  });

  it("allows nesting below a raised max_depth and refuses at it", () => {
    expect(assertDepthAllowed({ DISPATCH_DEPTH: "1" }, 2)).toBe(1);
    expect(() => assertDepthAllowed({ DISPATCH_DEPTH: "2" }, 2)).toThrow(RecursionRejectedError);
    expect(() => assertDepthAllowed({ DISPATCH_DEPTH: "7" }, 2)).toThrow(RecursionRejectedError);
  });

  it("fails closed on a malformed or negative DISPATCH_DEPTH", () => {
    for (const bad of ["abc", "-1", "1.5", "1e3", "0x1"]) {
      expect(currentDepth({ DISPATCH_DEPTH: bad })).toBe(Number.POSITIVE_INFINITY);
      expect(() => assertDepthAllowed({ DISPATCH_DEPTH: bad }, 1)).toThrow(RecursionRejectedError);
    }
  });

  it("tolerates surrounding whitespace", () => {
    expect(currentDepth({ DISPATCH_DEPTH: " 2 " })).toBe(2);
  });
});
