import { describe, expect, it } from "vitest";
import { registerDoctorCheck, registerHost, registry } from "../../src/hosts/_framework/index.js";
import { builtinRegistry } from "../../src/hosts/index.js";
import { createCommandRunner } from "../../src/runner/command.js";
import { fakeCodexHost } from "../support/fake-host.js";

describe("createCommandRunner", () => {
  it("runs a binary without a shell and reports exit code and output", async () => {
    const runner = createCommandRunner({ cwd: process.cwd() });
    const r = await runner.run(process.execPath, ["-e", "console.log('hi'); process.exit(3)"]);
    expect(r).toEqual({ code: 3, stdout: "hi\n", stderr: "" });
  });
});

describe("process-wide registry", () => {
  it("builtinRegistry registers the framework checks once; helpers add to it", () => {
    expect(builtinRegistry()).toBe(builtinRegistry());
    expect(registry.doctorChecks().map((c) => c.id)).toContain("setup.manifest");
    registerHost(fakeCodexHost());
    registerDoctorCheck({ id: "test.extra", run: () => ({ status: "ok", message: "" }) });
    expect(registry.getHost("codex")?.waitTimeoutSec).toBe(280);
    expect(registry.doctorChecks().map((c) => c.id)).toContain("test.extra");
  });
});
