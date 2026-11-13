/** Windows env of the doctor's listing probes (injected platform). */
import { describe, expect, it } from "vitest";
import { adapterPlatformBlocker } from "../../src/adapters/platform.js";
import type { AppContext } from "../../src/app/context.js";
import type { ExecutionInstance } from "../../src/config/load.js";
import { checkInstance, type InstanceCheckDeps, listingEnv } from "../../src/doctor/provider.js";

describe("doctor listing env", () => {
  it("adds the Windows base variables, matched without case", () => {
    const env = listingEnv(
      { Path: "C:\\bin", SystemRoot: "C:\\Windows", ComSpec: "cmd", SECRET: "x" },
      { adapter: "codex", configDir: "C:\\c" },
      "win32",
    );
    expect(env).toEqual({
      TERM: "dumb",
      Path: "C:\\bin",
      SystemRoot: "C:\\Windows",
      ComSpec: "cmd",
      CODEX_HOME: "C:\\c",
    });
  });

  it("POSIX keeps the exact-name allow-list", () => {
    expect(
      listingEnv(
        { PATH: "/bin", Path: "x", SystemRoot: "y", LC_ALL: "" },
        { adapter: "claude" },
        "linux",
      ),
    ).toEqual({ TERM: "dumb", PATH: "/bin", LC_ALL: "" });
  });
});

describe("doctor instance checks on Windows", () => {
  const none = { isExecutableFile: () => false, realpath: (p: string) => p };
  const inst = (adapter: string, id = adapter): ExecutionInstance => ({
    id,
    adapter,
    pool: "subscription",
    enabled: true,
    maxAutonomy: "worktree",
    concurrency: 1,
    envPassthrough: [],
  });
  const ctx = { env: {} } as unknown as AppContext;
  const deps = (platform: NodeJS.Platform): InstanceCheckDeps => ({
    spawner: { spawn: async () => ({ exitCode: 1, signal: null, timedOut: false }) },
    resolveFs: none,
    fixtureVersions: null,
    platform,
  });

  it("warns (not fails) for claude and antigravity with the adapter's reason, before any probe", async () => {
    for (const adapter of ["claude", "antigravity"]) {
      const r = await checkInstance(ctx, inst(adapter), deps("win32"));
      expect(r.lines).toHaveLength(1);
      expect(r.lines[0]).toMatchObject({ status: "warn", id: `${adapter}.platform` });
      expect(r.lines[0]?.message).toBe(
        `not used on this OS: ${adapterPlatformBlocker(adapter, "win32")}`,
      );
      expect(r.binary).toBeNull();
    }
  });

  it("warns codex users about the elevated sandbox setup, then keeps checking", async () => {
    const r = await checkInstance(ctx, inst("codex"), deps("win32"));
    expect(r.lines[0]).toMatchObject({ status: "warn", id: "codex.platform" });
    expect(r.lines[0]?.message).toContain('windows.sandbox="elevated"');
    expect(r.lines[0]?.fix).toContain("codex sandbox setup --elevated");
    expect(r.lines[1]).toMatchObject({ status: "fail", id: "codex.binary" });
  });

  it("adds no platform line on POSIX", async () => {
    for (const adapter of ["claude", "codex"]) {
      const r = await checkInstance(ctx, inst(adapter), deps("darwin"));
      expect(r.lines.map((l) => l.id)).not.toContain(`${adapter}.platform`);
    }
  });
});
