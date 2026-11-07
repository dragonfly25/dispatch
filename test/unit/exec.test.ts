import { describe, expect, it } from "vitest";
import { DispatchError } from "../../src/core/errors.js";
import { execTool } from "../../src/runner/exec.js";

const cwd = process.cwd();

describe("execTool", () => {
  it("returns stdout and code 0", async () => {
    const r = await execTool(process.execPath, ["-e", "process.stdout.write('hi')"], { cwd });
    expect(r).toEqual({ code: 0, stdout: "hi", stderr: "", timedOut: false });
  });

  it("reports a non-zero exit through code instead of rejecting", async () => {
    const r = await execTool(process.execPath, ["-e", "console.error('boom');process.exit(3)"], {
      cwd,
    });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("boom");
  });

  it("feeds input to stdin", async () => {
    const r = await execTool(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
      cwd,
      input: "from stdin",
    });
    expect(r.stdout).toBe("from stdin");
  });

  it("does not choke when the child never reads stdin", async () => {
    const r = await execTool(process.execPath, ["-e", ""], { cwd, input: "x".repeat(1 << 20) });
    expect(r.code).toBe(0);
  });

  it("layers env over the parent environment", async () => {
    const r = await execTool(process.execPath, ["-e", "process.stdout.write(process.env.WP7_X)"], {
      cwd,
      env: { WP7_X: "yes" },
    });
    expect(r.stdout).toBe("yes");
  });

  it("never interprets arguments through a shell", async () => {
    const r = await execTool(
      process.execPath,
      ["-e", "process.stdout.write(process.argv[1])", "$HOME; echo pwned `id`"],
      { cwd },
    );
    expect(r.stdout).toBe("$HOME; echo pwned `id`");
  });

  it("kills a tool that exceeds the timeout", async () => {
    const r = await execTool(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
      cwd,
      timeoutMs: 150,
    });
    expect(r.timedOut).toBe(true);
    expect(r.code).toBe(-1);
  });

  it("rejects with a DispatchError when the binary cannot be spawned", async () => {
    await expect(execTool("definitely-not-a-binary-wp7", [], { cwd })).rejects.toBeInstanceOf(
      DispatchError,
    );
  });
});
