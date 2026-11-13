import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExitCode } from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import {
  isRegularFile,
  parseCmdShim,
  parseNpmCmdShim,
  toSpawnCommand,
} from "../../../src/platform/spawnable.js";

const crlf = (lines: string[]) => `${lines.join("\r\n")}\r\n`;

/** cmd-shim >= 3 (npm 7+, yarn): exactly what `npm i -g @openai/codex` writes. */
const NPM_SHIM = crlf([
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
]);

/** Older npm (cmd-shim 2.x). */
const OLD_NPM_SHIM = crlf([
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ") ELSE (",
  "  @SETLOCAL",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ")",
]);

/** pnpm (@zkochan/cmd-shim) global bin in PNPM_HOME. */
const PNPM_SHIM = crlf([
  "@SETLOCAL",
  "@IF NOT DEFINED NODE_PATH (",
  '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules"',
  ") ELSE (",
  '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\.pnpm\\node_modules;%NODE_PATH%"',
  ")",
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ") ELSE (",
  "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
  '  node  "%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  ")",
]);

/** cmd-shim for a bin without a shebang (runs the target directly). */
const DIRECT_SHIM = crlf([
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  '"%dp0%\\node_modules\\@acme\\tool\\bin\\tool.exe"   %*',
]);

const NPM_DIR = "C:\\Users\\me\\AppData\\Roaming\\npm";
const CODEX_CMD = `${NPM_DIR}\\codex.cmd`;
const CODEX_JS = `${NPM_DIR}\\node_modules\\@openai\\codex\\bin\\codex.js`;

function fake(files: Record<string, string>) {
  return {
    platform: "win32" as const,
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    readFile: (p: string) => {
      const t = files[p];
      if (t === undefined) throw new Error(`ENOENT ${p}`);
      return t;
    },
    exists: (p: string) => p in files,
  };
}

function unspawnable(fn: () => unknown, re?: RegExp): DispatchError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(DispatchError);
    const err = e as DispatchError;
    expect(err.exitCode).toBe(ExitCode.USAGE);
    expect(err.code).toBe("binary.unspawnable");
    expect(err.message).toMatch(/binary:/);
    expect(err.message).toMatch(/\.exe/);
    if (re) expect(err.message).toMatch(re);
    return err;
  }
  return expect.unreachable("did not throw");
}

describe("parseCmdShim", () => {
  it("parses the current npm cmd-shim", () => {
    expect(parseCmdShim(NPM_SHIM)).toEqual({
      kind: "node",
      script: "node_modules\\@openai\\codex\\bin\\codex.js",
      nodeArgs: [],
    });
    expect(parseNpmCmdShim(NPM_SHIM)).toBe("node_modules\\@openai\\codex\\bin\\codex.js");
  });

  it("parses LF-only text and a UTF-8 BOM-free variant the same way", () => {
    expect(parseNpmCmdShim(NPM_SHIM.replaceAll("\r\n", "\n"))).toBe(
      "node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it("parses older npm shims (%~dp0) and pnpm shims", () => {
    expect(parseNpmCmdShim(OLD_NPM_SHIM)).toBe("node_modules\\@anthropic-ai\\claude-code\\cli.js");
    expect(parseNpmCmdShim(PNPM_SHIM)).toBe(
      "global\\5\\node_modules\\@openai\\codex\\bin\\codex.js",
    );
  });

  it("parses a pnpm shim with a relative path going up", () => {
    const text = PNPM_SHIM.replaceAll(
      "global\\5\\node_modules\\@openai\\codex",
      "..\\@openai\\codex",
    );
    expect(parseNpmCmdShim(text)).toBe("..\\@openai\\codex\\bin\\codex.js");
  });

  it("keeps simple node flags from the shebang", () => {
    const text = NPM_SHIM.replace('"%_prog%"  "', '"%_prog%" --no-warnings  "');
    expect(parseCmdShim(text)).toMatchObject({ kind: "node", nodeArgs: ["--no-warnings"] });
  });

  it("parses a direct shim and parseNpmCmdShim ignores it", () => {
    expect(parseCmdShim(DIRECT_SHIM)).toEqual({
      kind: "direct",
      target: "node_modules\\@acme\\tool\\bin\\tool.exe",
    });
    expect(parseNpmCmdShim(DIRECT_SHIM)).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["no %* line", "@ECHO off\r\nnode foo.js\r\n"],
    ["a non-node interpreter", NPM_SHIM.replace('SET "_prog=node"', 'SET "_prog=sh"')],
    ["a non-node sibling", NPM_SHIM.replace('_prog=%dp0%\\node.exe"', '_prog=%dp0%\\sh.exe"')],
    ["%_prog% never set", NPM_SHIM.replace(/ {2}SET "_prog=[^\r]*\r\n/g, "")],
    ["a variable in the path", NPM_SHIM.replace("@openai", "%EVIL%")],
    ["an absolute script", NPM_SHIM.replace('"%dp0%\\node_modules', '"C:\\evil')],
    [
      "a drive-qualified relative path",
      NPM_SHIM.replace("%dp0%\\node_modules", "%dp0%\\C:node_modules"),
    ],
    ["an extra command", `${NPM_SHIM}calc.exe %*\r\n`],
    [
      "two different scripts",
      OLD_NPM_SHIM.replace(/node {2}"%~dp0\\node_modules/, 'node  "%~dp0\\x'),
    ],
    ["a quoted shebang arg", NPM_SHIM.replace('"%_prog%"  "', '"%_prog%" "--x"  "')],
    ["a suspicious shebang arg", NPM_SHIM.replace('"%_prog%"  "', '"%_prog%" -e&calc  "')],
    ["args after a direct target", DIRECT_SHIM.replace('.exe"   %*', '.exe" --flag %*')],
    ["a hand-written batch", '@echo off\r\npowershell -File "%~dp0\\x.ps1" %*\r\n'],
  ])("rejects %s", (_label, text) => {
    expect(parseCmdShim(text)).toBeNull();
  });
});

describe("toSpawnCommand", () => {
  it("passes everything through on POSIX", () => {
    expect(
      toSpawnCommand("/usr/local/bin/codex", ["exec", "--json"], { platform: "darwin" }),
    ).toEqual({ command: "/usr/local/bin/codex", args: ["exec", "--json"] });
    expect(toSpawnCommand("/x/codex.cmd", ["a"], { platform: "linux" })).toEqual({
      command: "/x/codex.cmd",
      args: ["a"],
    });
  });

  it("uses process.platform and copies argv by default", () => {
    const argv = ["a"];
    // A binary every platform passes through as is (Windows accepts only .exe/.com that way).
    const bin = process.platform === "win32" ? "C:\\x\\tool.exe" : "/bin/echo";
    const r = toSpawnCommand(bin, argv);
    expect(r).toEqual({ command: bin, args: ["a"] });
    expect(r.args).not.toBe(argv);
  });

  it("passes .exe and .com through on Windows", () => {
    const exe = "C:\\Users\\me\\.local\\bin\\claude.exe";
    expect(toSpawnCommand(exe, ["-p", "hi"], fake({}))).toEqual({
      command: exe,
      args: ["-p", "hi"],
    });
    expect(toSpawnCommand("C:\\x\\TOOL.COM", [], fake({}))).toEqual({
      command: "C:\\x\\TOOL.COM",
      args: [],
    });
  });

  it("unwraps an npm shim to node + script (no sibling node.exe)", () => {
    const r = toSpawnCommand(
      CODEX_CMD,
      ["exec", "a prompt with spaces & | ^"],
      fake({ [CODEX_CMD]: NPM_SHIM, [CODEX_JS]: "" }),
    );
    expect(r).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [CODEX_JS, "exec", "a prompt with spaces & | ^"],
    });
  });

  it("prefers the shim's sibling node.exe", () => {
    const sibling = `${NPM_DIR}\\node.exe`;
    const r = toSpawnCommand(
      CODEX_CMD,
      ["--version"],
      fake({ [CODEX_CMD]: NPM_SHIM, [CODEX_JS]: "", [sibling]: "" }),
    );
    expect(r).toEqual({ command: sibling, args: [CODEX_JS, "--version"] });
  });

  it("falls back to process.execPath without nodePath", () => {
    const { nodePath: _n, ...opts } = fake({ [CODEX_CMD]: NPM_SHIM, [CODEX_JS]: "" });
    expect(toSpawnCommand(CODEX_CMD, [], opts).command).toBe(process.execPath);
  });

  it("forwards shebang node flags before the script and accepts .bat and upper-case names", () => {
    const bat = `${NPM_DIR}\\CODEX.BAT`;
    const text = NPM_SHIM.replace('"%_prog%"  "', '"%_prog%" --no-warnings  "');
    const r = toSpawnCommand(bat, ["x"], fake({ [bat]: text, [CODEX_JS]: "" }));
    expect(r.args).toEqual(["--no-warnings", CODEX_JS, "x"]);
  });

  it("resolves a pnpm shim's ..\\ path against the shim dir", () => {
    const dir = "C:\\Users\\me\\proj\\node_modules\\.bin";
    const shim = `${dir}\\codex.CMD`;
    const text = PNPM_SHIM.replaceAll("global\\5\\node_modules\\@openai", "..\\@openai");
    const script = "C:\\Users\\me\\proj\\node_modules\\@openai\\codex\\bin\\codex.js";
    expect(toSpawnCommand(shim, [], fake({ [shim]: text, [script]: "" }))).toEqual({
      command: "C:\\Program Files\\nodejs\\node.exe",
      args: [script],
    });
  });

  it("runs a direct shim's .exe target", () => {
    const shim = `${NPM_DIR}\\tool.cmd`;
    const target = `${NPM_DIR}\\node_modules\\@acme\\tool\\bin\\tool.exe`;
    expect(toSpawnCommand(shim, ["a"], fake({ [shim]: DIRECT_SHIM, [target]: "" }))).toEqual({
      command: target,
      args: ["a"],
    });
  });

  it("refuses a direct shim whose target is missing or not a .exe", () => {
    const shim = `${NPM_DIR}\\tool.cmd`;
    unspawnable(() => toSpawnCommand(shim, [], fake({ [shim]: DIRECT_SHIM })), /does not exist/);
    const text = DIRECT_SHIM.replace("tool.exe", "tool.js");
    unspawnable(
      () =>
        toSpawnCommand(
          shim,
          [],
          fake({ [shim]: text, [`${NPM_DIR}\\node_modules\\@acme\\tool\\bin\\tool.js`]: "" }),
        ),
      /not a \.exe/,
    );
  });

  it("refuses a shim whose script does not exist", () => {
    const err = unspawnable(
      () => toSpawnCommand(CODEX_CMD, [], fake({ [CODEX_CMD]: NPM_SHIM })),
      /does not exist/,
    );
    expect(err.message).toContain(CODEX_CMD);
  });

  it("refuses a batch file that is not an npm shim, naming the file", () => {
    const bat = "C:\\tools\\agy.bat";
    const err = unspawnable(
      () => toSpawnCommand(bat, [], fake({ [bat]: "@echo off\r\nC:\\real\\agy.exe %*\r\n" })),
      /not an npm cmd-shim/,
    );
    expect(err.message).toContain(bat);
  });

  it("refuses an unreadable or relative batch file", () => {
    unspawnable(() => toSpawnCommand("C:\\gone\\codex.cmd", [], fake({})), /cannot be read/);
    unspawnable(() => toSpawnCommand("codex.cmd", [], fake({})), /absolute path/);
    unspawnable(() => toSpawnCommand("\\npm\\codex.cmd", [], fake({})), /absolute path/);
  });

  it.each(["C:\\npm\\codex", "C:\\npm\\codex.ps1", "C:\\npm\\codex.js"])(
    "refuses %s on Windows",
    (bin) => {
      unspawnable(() => toSpawnCommand(bin, [], fake({ [bin]: NPM_SHIM })), /only \.exe/);
    },
  );
});

describe("toSpawnCommand default fs", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "dispatch-spawnable-"));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("reads the shim with node:fs by default", () => {
    // win32.join rewrites the script path with backslashes, which macOS cannot open, so the
    // default read is proven by getting past parsing to the existence check.
    writeFileSync(join(root, "codex.cmd"), NPM_SHIM);
    expect(() =>
      toSpawnCommand(join(root, "codex.cmd").replace(/^\//, "//"), [], {
        platform: "win32",
      }),
    ).toThrow(/script .*codex\.js does not exist/);
    writeFileSync(join(root, "plain.cmd"), "@echo off\r\n");
    expect(() =>
      toSpawnCommand(join(root, "plain.cmd").replace(/^\//, "//"), [], { platform: "win32" }),
    ).toThrow(/not an npm cmd-shim/);
  });

  it("isRegularFile accepts files only", () => {
    mkdirSync(join(root, "dir"));
    writeFileSync(join(root, "f.js"), "");
    expect(isRegularFile(join(root, "f.js"))).toBe(true);
    expect(isRegularFile(join(root, "dir"))).toBe(false);
    expect(isRegularFile(join(root, "missing"))).toBe(false);
  });
});
