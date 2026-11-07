import { describe, expect, it } from "vitest";
import { ExitCode } from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import {
  CODEX_SANDBOX_MESSAGE,
  codexSandboxActive,
  detectHost,
  parseDepth,
} from "../../../src/platform/host.js";
import { assertSupportedPlatform } from "../../../src/platform/platform.js";

describe("detectHost [UC10]", () => {
  it("[UC10] reports no host for an empty or unrelated env", () => {
    expect(detectHost({})).toEqual({ host: null, depth: 0, evidence: [] });
    expect(
      detectHost({ PATH: "/usr/bin", CLAUDE_CODE_ENTRYPOINT: "claude-desktop" }).host,
    ).toBeNull();
  });

  it("detects Claude Code with and without a session id", () => {
    expect(detectHost({ CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "abc" })).toEqual({
      host: "claude-code",
      sessionId: "abc",
      depth: 0,
      evidence: ["CLAUDECODE=1", "CLAUDE_CODE_SESSION_ID"],
    });
    const r = detectHost({ CLAUDECODE: "1" });
    expect(r.host).toBe("claude-code");
    expect(r).not.toHaveProperty("sessionId");
  });

  it("ignores CLAUDECODE values other than 1", () => {
    expect(detectHost({ CLAUDECODE: "0" }).host).toBeNull();
    expect(detectHost({ CLAUDECODE: "" }).host).toBeNull();
  });

  it("detects Codex from CODEX_THREAD_ID (or CODEX_SESSION_ID)", () => {
    expect(detectHost({ CODEX_THREAD_ID: "t-1", CODEX_VERSION: "0.167.0" })).toEqual({
      host: "codex",
      sessionId: "t-1",
      depth: 0,
      evidence: ["CODEX_THREAD_ID"],
    });
    expect(detectHost({ CODEX_SESSION_ID: "s-9" })).toMatchObject({
      host: "codex",
      sessionId: "s-9",
      evidence: ["CODEX_SESSION_ID"],
    });
    expect(detectHost({ CODEX_THREAD_ID: "t", CODEX_SESSION_ID: "s" }).sessionId).toBe("t");
  });

  it("detects Antigravity from ANTIGRAVITY_AGENT=1 only", () => {
    expect(detectHost({ ANTIGRAVITY_AGENT: "1" })).toEqual({
      host: "antigravity",
      depth: 0,
      evidence: ["ANTIGRAVITY_AGENT=1"],
    });
    expect(detectHost({ ANTIGRAVITY_AGENT: "true" }).host).toBeNull();
  });

  it("with several markers, picks claude-code > codex > antigravity and lists all evidence", () => {
    const r = detectHost({ ANTIGRAVITY_AGENT: "1", CODEX_THREAD_ID: "t", CLAUDECODE: "1" });
    expect(r.host).toBe("claude-code");
    expect(r.evidence).toEqual(["CLAUDECODE=1", "CODEX_THREAD_ID", "ANTIGRAVITY_AGENT=1"]);
    expect(detectHost({ ANTIGRAVITY_AGENT: "1", CODEX_THREAD_ID: "t" }).host).toBe("codex");
  });

  it("parses DISPATCH_DEPTH and records it as evidence, even without a host", () => {
    expect(detectHost({ DISPATCH_DEPTH: "2" })).toEqual({
      host: null,
      depth: 2,
      evidence: ["DISPATCH_DEPTH"],
    });
    expect(detectHost({ CLAUDECODE: "1", DISPATCH_DEPTH: "1" })).toMatchObject({
      depth: 1,
      evidence: ["CLAUDECODE=1", "DISPATCH_DEPTH"],
    });
  });

  it("parseDepth: unset/empty is 0, numbers parse, garbage counts as nested (1)", () => {
    expect(parseDepth({})).toBe(0);
    expect(parseDepth({ DISPATCH_DEPTH: "" })).toBe(0);
    expect(parseDepth({ DISPATCH_DEPTH: " 3 " })).toBe(3);
    expect(parseDepth({ DISPATCH_DEPTH: "0" })).toBe(0);
    expect(parseDepth({ DISPATCH_DEPTH: "abc" })).toBe(1);
    expect(parseDepth({ DISPATCH_DEPTH: "-1" })).toBe(1);
  });
});

describe("codexSandboxActive", () => {
  it("is true when CODEX_SANDBOX is set to anything non-empty", () => {
    expect(codexSandboxActive({ CODEX_SANDBOX: "seatbelt" })).toBe(true);
    expect(codexSandboxActive({ CODEX_SANDBOX: "" })).toBe(false);
    expect(codexSandboxActive({})).toBe(false);
    expect(codexSandboxActive({ CODEX_SANDBOX_NETWORK_DISABLED: "1" })).toBe(false);
  });

  it("has an actionable message", () => {
    expect(CODEX_SANDBOX_MESSAGE).toMatch(/rules file did not match/);
    expect(CODEX_SANDBOX_MESSAGE).toMatch(/absolute launcher/);
  });
});

describe("assertSupportedPlatform", () => {
  it.each(["darwin", "linux"])("accepts %s", (p) => {
    expect(() => assertSupportedPlatform(p)).not.toThrow();
  });

  it("accepts the current platform by default", () => {
    expect(() => assertSupportedPlatform()).not.toThrow();
  });

  it("rejects win32 with a WSL hint and USAGE exit code", () => {
    try {
      assertSupportedPlatform("win32");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DispatchError);
      expect((e as DispatchError).exitCode).toBe(ExitCode.USAGE);
      expect((e as DispatchError).message).toMatch(/WSL/);
    }
  });

  it("rejects other platforms too", () => {
    expect(() => assertSupportedPlatform("freebsd")).toThrow(/macOS and Linux/);
  });
});
