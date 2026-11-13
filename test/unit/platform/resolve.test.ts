import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchError } from "../../../src/core/errors.js";
import {
  isWindowsAbsolute,
  nodeResolveFs,
  type ResolveFs,
  type ResolveOptions,
  resolveBinary,
  windowsExtensions,
  windowsPathEntries,
} from "../../../src/platform/resolve.js";

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
// POSIX rules are pinned (the default platform would apply the Windows rules on windows-latest).
const base = () => ({
  platform: "darwin" as const,
  execPath: join(root, "nodebin", "node"),
  fs: {
    isExecutableFile: (p: string) => p.startsWith(root) && nodeResolveFs.isExecutableFile(p),
    realpath: nodeResolveFs.realpath,
  } satisfies ResolveFs,
});

// These cases use real executable bits and symlinks, which Windows does not have.
describe.skipIf(process.platform === "win32")("resolveBinary [UC1]", () => {
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

describe("resolveBinary on win32", () => {
  const USER = "C:\\Users\\me";
  const NPM = `${USER}\\AppData\\Roaming\\npm`;
  const NODE = "C:\\Program Files\\nodejs\\node.exe";

  /** Fake Windows fs: `files` exist (case-insensitively, like NTFS); records every probe. */
  function winFs(files: string[]) {
    const lower = new Set(files.map((f) => f.toLowerCase()));
    const seen: string[] = [];
    const fs: ResolveFs = {
      isExecutableFile(p) {
        seen.push(p);
        return lower.has(p.toLowerCase());
      },
      realpath: (p) => `R:${p}`,
    };
    return { fs, seen };
  }

  const win = (
    files: string[],
    env: Record<string, string>,
    extra: Partial<ResolveOptions> = {},
  ) => {
    const { fs, seen } = winFs(files);
    const r = resolveBinary("codex", { platform: "win32", execPath: NODE, env, fs, ...extra });
    return { r, seen };
  };

  it("finds the npm .cmd shim on Path (case-insensitive name, quoted and relative entries)", () => {
    const { r, seen } = win([`${NPM}\\codex`, `${NPM}\\codex.cmd`, `${NPM}\\codex.ps1`], {
      Path: `"C:\\Windows\\system32";relative\\dir;;"${NPM}"`,
    });
    expect(r).toEqual({
      path: `${NPM}\\codex.cmd`,
      realpath: `R:${NPM}\\codex.cmd`,
      source: "path",
    });
    expect(seen).toEqual([
      "C:\\Windows\\system32\\codex.com",
      "C:\\Windows\\system32\\codex.exe",
      "C:\\Windows\\system32\\codex.bat",
      "C:\\Windows\\system32\\codex.cmd",
      `${NPM}\\codex.com`,
      `${NPM}\\codex.exe`,
      `${NPM}\\codex.bat`,
      `${NPM}\\codex.cmd`,
    ]);
  });

  it("never accepts an extensionless or .ps1 file", () => {
    const { r } = win([`${NPM}\\codex`, `${NPM}\\codex.ps1`], {
      PATH: NPM,
      APPDATA: `${USER}\\AppData\\Roaming`,
    });
    expect(r).toBeNull();
  });

  it("follows PATHEXT order, ignoring extensions it cannot start", () => {
    const { r, seen } = win([`${NPM}\\codex.exe`, `${NPM}\\codex.cmd`], {
      PATH: NPM,
      PATHEXT: ".CMD;.PS1;.JS;.EXE;.cmd",
    });
    expect(r?.path).toBe(`${NPM}\\codex.cmd`);
    expect(seen).toEqual([`${NPM}\\codex.cmd`]);
    const { seen: seen2 } = win([], { PATH: NPM, PATHEXT: ".JS;.VBS" });
    expect(seen2.slice(0, 4)).toEqual(
      [".com", ".exe", ".bat", ".cmd"].map((e) => `${NPM}\\codex${e}`),
    );
  });

  it("does not split PATH on ':' (drive letters) and skips root- and drive-relative dirs", () => {
    const { seen } = win([], { PATH: "\\tools;C:tools;D:\\bin", PATHEXT: ".EXE" });
    expect(seen[0]).toBe("D:\\bin\\codex.exe");
  });

  it("accepts UNC directories", () => {
    const { r } = win(["\\\\server\\share\\bin\\codex.exe"], { PATH: "\\\\server\\share\\bin" });
    expect(r?.path).toBe("\\\\server\\share\\bin\\codex.exe");
  });

  it("searches the well-known Windows dirs in order", () => {
    const env = {
      PATH: "C:\\Windows",
      PATHEXT: ".EXE;.CMD",
      USERPROFILE: USER,
      APPDATA: `${USER}\\AppData\\Roaming`,
      NPM_CONFIG_PREFIX: "D:\\npm-global",
    };
    const { r, seen } = win([], env, { extraDirs: ["E:\\extra"] });
    expect(r).toBeNull();
    expect(seen).toEqual([
      "C:\\Windows\\codex.exe",
      "C:\\Windows\\codex.cmd",
      `${USER}\\.local\\bin\\codex.exe`,
      `${USER}\\.local\\bin\\codex.cmd`,
      `${NPM}\\codex.exe`,
      `${NPM}\\codex.cmd`,
      "D:\\npm-global\\codex.exe",
      "D:\\npm-global\\codex.cmd",
      "C:\\Program Files\\nodejs\\codex.exe",
      "C:\\Program Files\\nodejs\\codex.cmd",
      "E:\\extra\\codex.exe",
      "E:\\extra\\codex.cmd",
    ]);
  });

  it("finds the Claude Code native install in %USERPROFILE%\\.local\\bin", () => {
    const exe = `${USER}\\.local\\bin\\codex.exe`;
    const { r } = win([exe], { USERPROFILE: USER });
    expect(r).toMatchObject({ path: exe, source: "well-known" });
  });

  it("uses HOMEDRIVE+HOMEPATH and process.execPath when nothing else is given", () => {
    const { fs, seen } = winFs([]);
    resolveBinary("codex", {
      platform: "win32",
      env: { HOMEDRIVE: "C:", HOMEPATH: "\\Users\\me", PATHEXT: ".EXE" },
      fs,
    });
    expect(seen[0]).toBe(`${USER}\\.local\\bin\\codex.exe`);
    // On a Windows host process.execPath's dir is searched too; elsewhere it is not
    // drive-qualified and is skipped.
    const nodeDir = win32.dirname(process.execPath);
    expect(seen.slice(1)).toEqual(
      isWindowsAbsolute(nodeDir) ? [win32.join(nodeDir, "codex.exe")] : [],
    );
  });

  it("returns null with an empty env", () => {
    expect(win([], {}).r).toBeNull();
  });

  it("defaults to node:fs and process.execPath", () => {
    expect(resolveBinary("definitely-not-installed", { platform: "win32", env: {} })).toBeNull();
    expect(resolveBinary("definitely-not-installed", { env: {} })).toBeNull();
  });

  it("accepts a configured absolute .exe/.cmd and refuses everything else", () => {
    const cfg = "C:\\Tools\\Codex\\codex.EXE";
    expect(win([cfg], {}, { configured: cfg }).r).toMatchObject({ path: cfg, source: "config" });
    const unc = "\\\\srv\\tools\\codex.cmd";
    expect(win([unc], {}, { configured: unc }).r?.path).toBe(unc);

    const cases: [string, RegExp][] = [
      ["codex.exe", /absolute path/],
      ["\\Tools\\codex.exe", /absolute path/],
      ["C:codex.exe", /absolute path/],
      ["/usr/local/bin/codex", /absolute path/],
      ["C:\\Tools\\codex", /\.exe, \.com, \.cmd or \.bat/],
      ["C:\\Tools\\codex.ps1", /\.exe, \.com, \.cmd or \.bat/],
      ["C:\\Tools\\missing.exe", /missing or not executable/],
    ];
    for (const [configured, re] of cases) {
      const call = () => win([`${NPM}\\codex.cmd`], { PATH: NPM }, { configured });
      expect(call).toThrow(DispatchError);
      expect(call).toThrow(re);
    }
  });
});

describe("Windows helpers", () => {
  it("isWindowsAbsolute", () => {
    for (const p of ["C:\\x", "c:/x", "\\\\srv\\share", "//srv/share"]) {
      expect(isWindowsAbsolute(p)).toBe(true);
    }
    for (const p of ["", "x", "\\x", "/x", "C:x", "C:", "\\\\", "\\\\\\x"]) {
      expect(isWindowsAbsolute(p)).toBe(false);
    }
  });

  it("windowsExtensions and windowsPathEntries read env case-insensitively", () => {
    expect(windowsExtensions({ PathExt: ".exe; .CMD" })).toEqual([".exe", ".cmd"]);
    expect(windowsExtensions({})).toEqual([".com", ".exe", ".bat", ".cmd"]);
    expect(windowsPathEntries({ path: ' "C:\\a b" ;C:\\c;' })).toEqual(["C:\\a b", "C:\\c"]);
    expect(windowsPathEntries({})).toEqual([]);
  });

  it("keeps POSIX rules when platform is darwin even with Windows-looking env", () => {
    const fs: ResolveFs = { isExecutableFile: (p) => p === "/a/codex", realpath: (p) => p };
    expect(
      resolveBinary("codex", {
        platform: "darwin",
        env: { PATH: "/a", Path: "C:\\x" },
        fs,
        execPath: "/n/node",
      })?.path,
    ).toBe("/a/codex");
  });
});
