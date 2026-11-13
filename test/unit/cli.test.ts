import { describe, expect, it, vi } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { buildProgram, runCli } from "../../src/cli/program.js";
import { DispatchError } from "../../src/core/errors.js";

function capture() {
  const io = { stdout: "", stderr: "" };
  const sink = {
    out(t: string) {
      io.stdout += t;
    },
    err(t: string) {
      io.stderr += t;
    },
  };
  return { io, sink };
}

describe("dispatch CLI", () => {
  it.each(["--version", "-v"])("%s prints the package version", async (flag) => {
    const { io, sink } = capture();
    expect(await runCli([flag], sink)).toBe(0);
    expect(io.stdout.trim()).toBe(pkg.version);
  });

  it("--help prints usage and exits 0", async () => {
    const { io, sink } = capture();
    expect(await runCli(["--help"], sink)).toBe(0);
    expect(io.stdout).toContain("Usage: dispatch");
  });

  it("no arguments prints help and exits 0", async () => {
    const { io, sink } = capture();
    expect(await runCli([], sink)).toBe(0);
    expect(io.stdout).toContain("Usage: dispatch");
  });

  it.each([["frobnicate"], ["--nope"]])("unknown input %s exits 2", async (arg) => {
    const { io, sink } = capture();
    expect(await runCli([arg], sink)).toBe(2);
    expect(io.stderr).not.toBe("");
  });

  it("writes to process stdout/stderr by default", async () => {
    const out = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await runCli(["--version"])).toBe(0);
      expect(await runCli(["frobnicate"])).toBe(2);
      expect(out).toHaveBeenCalledWith(`${pkg.version}\n`);
      expect(err).toHaveBeenCalled();
    } finally {
      out.mockRestore();
      err.mockRestore();
    }
  });

  it("returns 0 when a subcommand succeeds", async () => {
    const { sink } = capture();
    const program = buildProgram(sink);
    program.command("noop").action(() => {});
    expect(await runCli(["noop"], sink, program)).toBe(0);
  });

  it("maps a DispatchError thrown by a subcommand to its exit code", async () => {
    const { io, sink } = capture();
    const program = buildProgram(sink);
    program.command("boom").action(() => {
      throw new DispatchError("state is locked", 6, "state.locked");
    });
    expect(await runCli(["boom"], sink, program)).toBe(6);
    expect(io.stderr).toBe("dispatch: state is locked\n");
  });

  it("maps any other error to FAILED", async () => {
    const { io, sink } = capture();
    const make = (thrown: unknown) => {
      const program = buildProgram(sink);
      program.command("oops").action(() => {
        throw thrown;
      });
      return program;
    };
    expect(await runCli(["oops"], sink, make(new Error("kaput")))).toBe(4);
    expect(io.stderr).toContain("unexpected error: kaput");
    expect(await runCli(["oops"], sink, make("raw"))).toBe(4);
    expect(io.stderr).toContain("unexpected error: raw");
  });
});

describe("entry gates [UC1][UC10]", () => {
  const ctx = (env: Record<string, string> = {}) => ({ platform: "darwin", env });

  it("exits 2 on an unsupported platform, even with no args", async () => {
    for (const args of [["--version"], []]) {
      const { io, sink } = capture();
      const code = await runCli(args, sink, buildProgram(sink), { platform: "freebsd", env: {} });
      expect(code).toBe(2);
      expect(io.stderr).toMatch(/freebsd/);
    }
  });

  it("exits 3 (rejected) with the rules-file message inside the Codex sandbox", async () => {
    const { io, sink } = capture();
    const code = await runCli(
      ["__paths"],
      sink,
      buildProgram(sink),
      ctx({ CODEX_SANDBOX: "seatbelt" }),
    );
    expect(code).toBe(3);
    expect(io.stderr).toMatch(/rules file did not match/);
    expect(io.stdout).toBe("");
  });

  it("still allows help and version inside the Codex sandbox", async () => {
    const { io, sink } = capture();
    const code = await runCli(
      ["--version"],
      sink,
      buildProgram(sink),
      ctx({ CODEX_SANDBOX: "seatbelt" }),
    );
    expect(code).toBe(0);
    expect(io.stdout.trim()).toBe(pkg.version);
  });

  it("hidden __paths prints node/cli/hook paths as JSON and is not listed in help", async () => {
    const { io, sink } = capture();
    expect(await runCli(["__paths"], sink, buildProgram(sink), ctx())).toBe(0);
    const paths = JSON.parse(io.stdout);
    expect(Object.keys(paths).sort()).toEqual(["cliPath", "hookPath", "nodePath"]);
    expect(paths.nodePath).toBe(process.execPath);

    const help = capture();
    await runCli(["--help"], help.sink);
    expect(help.io.stdout).not.toContain("__paths");
  });
});
