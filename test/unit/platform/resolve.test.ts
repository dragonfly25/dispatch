import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchError } from "../../../src/core/errors.js";
import { nodeResolveFs, type ResolveFs, resolveBinary } from "../../../src/platform/resolve.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dispatch-resolve-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function exe(dir: string, name: string, mode = 0o755): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, mode);
  return p;
}

// Hermetic: only files under the temp root count as executables, so the machine's real
// /opt/homebrew/bin, /usr/local/bin etc. never leak into results; execPath points into the root.
const base = () => ({
  execPath: join(root, "nodebin", "node"),
  fs: {
    isExecutableFile: (p: string) => p.startsWith(root) && nodeResolveFs.isExecutableFile(p),
    realpath: nodeResolveFs.realpath,
  } satisfies ResolveFs,
});

describe("resolveBinary [UC1]", () => {
  it("prefers the configured absolute path over PATH", () => {
    const configured = exe(join(root, "cfg"), "claude");
    const onPath = exe(join(root, "p"), "claude");
    const r = resolveBinary("claude", {
      ...base(),
      configured,
      env: { PATH: join(root, "p") },
    });
    expect(r).toMatchObject({ path: configured, source: "config" });
    expect(r?.path).not.toBe(onPath);
  });

  it("errors when the configured path is missing, not executable, a directory or relative", () => {
    const noexec = exe(join(root, "cfg"), "claude", 0o644);
    const dir = join(root, "isdir");
    mkdirSync(dir);
    for (const configured of [join(root, "nope"), noexec, dir, "claude"]) {
      const call = () => resolveBinary("claude", { ...base(), configured, env: {} });
      expect(call).toThrow(DispatchError);
      expect(call).toThrow(/configured binary/);
    }
  });

  it("does not fall back to PATH when the configured path is broken", () => {
    exe(join(root, "p"), "claude");
    expect(() =>
      resolveBinary("claude", {
        ...base(),
        configured: join(root, "nope"),
        env: { PATH: join(root, "p") },
      }),
    ).toThrow(/not executable/);
  });

  it("walks PATH in order and skips non-executables and relative entries", () => {
    exe(join(root, "a"), "codex", 0o644);
    const b = exe(join(root, "b"), "codex");
    exe(join(root, "c"), "codex");
    const env = {
      PATH: ["", "rel/dir", join(root, "a"), join(root, "b"), join(root, "c")].join(":"),
    };
    expect(resolveBinary("codex", { ...base(), env })).toMatchObject({ path: b, source: "path" });
  });

  it("falls back to well-known dirs (HOME/.local/bin, npm prefix, node bin dir, extraDirs)", () => {
    const home = join(root, "home");
    const local = exe(join(home, ".local", "bin"), "agy");
    const env = { PATH: "/usr/bin:/bin", HOME: home };
    expect(resolveBinary("agy", { ...base(), env })).toMatchObject({
      path: local,
      source: "well-known",
    });

    const npm = exe(join(root, "prefix", "bin"), "npmtool");
    expect(
      resolveBinary("npmtool", { ...base(), env: { npm_config_prefix: join(root, "prefix") } }),
    ).toMatchObject({ path: npm, source: "well-known" });
    expect(
      resolveBinary("npmtool", { ...base(), env: { NPM_CONFIG_PREFIX: join(root, "prefix") } })
        ?.path,
    ).toBe(npm);

    const sibling = exe(join(root, "nodebin"), "sibling");
    expect(resolveBinary("sibling", { ...base(), env: {} })?.path).toBe(sibling);

    const extra = exe(join(root, "extra"), "extratool");
    expect(
      resolveBinary("extratool", { ...base(), env: {}, extraDirs: [join(root, "extra")] })?.path,
    ).toBe(extra);
  });

  it("checks PATH, then /opt/homebrew/bin, then /usr/local/bin through the injected fs", () => {
    const seen: string[] = [];
    const fs: ResolveFs = {
      isExecutableFile(p) {
        seen.push(p);
        return p === "/usr/local/bin/codex";
      },
      realpath: (p) => `/real${p}`,
    };
    const r = resolveBinary("codex", { ...base(), env: { PATH: "/usr/bin" }, fs });
    expect(r).toEqual({
      path: "/usr/local/bin/codex",
      realpath: "/real/usr/local/bin/codex",
      source: "well-known",
    });
    expect(seen.slice(0, 3)).toEqual([
      "/usr/bin/codex",
      "/opt/homebrew/bin/codex",
      "/usr/local/bin/codex",
    ]);
  });

  it("returns null when nothing is found (and tolerates a missing PATH)", () => {
    expect(resolveBinary("definitely-not-installed", { ...base(), env: {} })).toBeNull();
  });

  it("returns the realpath through symlinks (Caskroom-style versioned dir)", () => {
    const real = exe(join(root, "Caskroom", "codex", "0.167.0"), "codex-real");
    mkdirSync(join(root, "bin"));
    symlinkSync(real, join(root, "bin", "codex"));
    const r = resolveBinary("codex", { ...base(), env: { PATH: join(root, "bin") } });
    expect(r?.path).toBe(join(root, "bin", "codex"));
    // realpath also canonicalizes /var -> /private/var style prefixes, so compare canonically.
    expect(r?.realpath).toBe(nodeResolveFs.realpath(real));
    expect(r?.realpath).toContain("0.167.0");
  });

  it("treats a dangling symlink and a directory as not executable", () => {
    mkdirSync(join(root, "bin", "claude"), { recursive: true });
    symlinkSync(join(root, "gone"), join(root, "bin", "codex"));
    const env = { PATH: join(root, "bin") };
    expect(nodeResolveFs.isExecutableFile(join(root, "bin", "claude"))).toBe(false);
    expect(resolveBinary("codex", { ...base(), env })).toBeNull();
  });

  it("rejects names that are not plain file names", () => {
    for (const name of ["", "../x", "a/b", "a b", "-x"]) {
      expect(() => resolveBinary(name, { ...base(), env: {} })).toThrow(/invalid binary name/);
    }
  });
});
