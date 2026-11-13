/**
 * The Windows layout of the test kit, exercised on every OS by injecting `platform: "win32"`:
 * committed npm cmd-shims that production `toSpawnCommand` unwraps to `node <cli>.mjs`, per-run
 * copies plus `.fake-env.json`, and the PATHEXT-aware real-CLI guard.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCmdShim, toSpawnCommand } from "../../src/platform/spawnable.js";
import { withWindowsBase } from "../security/harness.js";
import {
  assertFakeShimsInstalled,
  assertNoRealCli,
  createFakes,
  FAKE_CLIS,
  FAKES_BIN,
  resolveOnPath,
  tempHome,
} from "../support/index.js";
import { npmCmdShim, shimFileName, writeNodeShim } from "../support/shims.js";

describe("Windows fake layout [AC1]", () => {
  it("[AC1] the committed .cmd fakes are npm cmd-shims (CRLF) that unwrap to node <cli>.mjs", () => {
    for (const cli of FAKE_CLIS) {
      const text = readFileSync(join(FAKES_BIN, `${cli}.cmd`), "utf8");
      expect(text).toBe(npmCmdShim(`${cli}.mjs`));
      expect(text.split("\r\n").length).toBeGreaterThan(10);
      expect(parseCmdShim(text)).toEqual({ kind: "node", script: `${cli}.mjs`, nodeArgs: [] });
      const spawn = toSpawnCommand(`C:\\fakes\\bin\\${cli}.cmd`, ["-p"], {
        platform: "win32",
        nodePath: String.raw`C:\node\node.exe`,
        readFile: () => text,
        exists: (p) => !p.endsWith("node.exe"),
      });
      expect(spawn).toEqual({
        command: String.raw`C:\node\node.exe`,
        args: [`C:\\fakes\\bin\\${cli}.mjs`, "-p"],
      });
    }
    expect(() => assertFakeShimsInstalled("win32")).not.toThrow();
  });

  it("[AC1] createFakes copies the shim and entry, writes .fake-env.json and keeps one PATH key", () => {
    const fakes = createFakes(
      { "claude:version": { stdout: "9.9.9 (fake)\n" } },
      { platform: "win32", inheritEnv: true, env: { Path: "C:\\x" } },
    );
    try {
      for (const cli of FAKE_CLIS) {
        for (const f of [`${cli}.cmd`, `${cli}.mjs`]) {
          expect(readFileSync(join(fakes.binDir, f))).toEqual(readFileSync(join(FAKES_BIN, f)));
        }
        expect(existsSync(join(fakes.binDir, cli))).toBe(false);
      }
      expect(Object.keys(fakes.env).filter((k) => k.toUpperCase() === "PATH")).toEqual(["PATH"]);
      expect(fakes.env.PATH?.startsWith(`${fakes.binDir};`)).toBe(true);
      const config = JSON.parse(readFileSync(join(fakes.binDir, ".fake-env.json"), "utf8"));
      expect(config.FAKE_LOG).toBe(fakes.logPath);
      // What the unwrapped shim runs: `node <binDir>/claude.mjs`, with no FAKE_* in its env.
      const r = spawnSync(process.execPath, [join(fakes.binDir, "claude.mjs"), "--version"], {
        env: withWindowsBase({ PATH: process.env.PATH ?? "" }),
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("9.9.9 (fake)\n");
      expect(fakes.readLog()[0]).toMatchObject({ cli: "claude", key: "version" });
    } finally {
      fakes.dispose();
    }
  });

  it("[AC1] the guard honours PATHEXT and rejects decoys and altered copies", () => {
    const fakes = createFakes({}, { platform: "win32" });
    try {
      const decoy = join(fakes.stateDir, "decoy");
      mkdirSync(decoy);
      writeFileSync(join(decoy, "claude.exe"), "MZ");
      const path = fakes.env.PATH ?? "";
      expect(resolveOnPath("claude", path, "win32", ".EXE;.CMD")).toBe(
        join(fakes.binDir, "claude.cmd"),
      );
      expect(() => assertNoRealCli({ PATH: `${decoy};${path}` }, "win32")).toThrow(
        /claude: resolves to .*claude\.exe/,
      );
      // An extension outside PATHEXT is never picked.
      expect(() =>
        assertNoRealCli({ PATH: `${decoy};${path}`, PATHEXT: ".CMD" }, "win32"),
      ).not.toThrow();
      copyFileSync(join(FAKES_BIN, "claude.cmd"), join(decoy, "codex.cmd"));
      expect(() => assertNoRealCli({ PATH: `${decoy};${path}`, PATHEXT: ".CMD" }, "win32")).toThrow(
        /codex: resolves to/,
      );
      expect(() => assertNoRealCli({ Path: path }, "win32")).not.toThrow();
      expect(() => assertNoRealCli({ PATH: "C:\\Windows" }, "win32")).toThrow(/not on PATH/);
    } finally {
      fakes.dispose();
    }
  });

  it("[AC1] writeNodeShim writes a sh script on POSIX and a cmd-shim + .mjs entry on Windows", () => {
    const h = tempHome();
    try {
      const script = join(h.home, "echo.mjs");
      writeFileSync(script, "console.log(process.env.SHIM_VAR, ...process.argv.slice(2));\n");
      const posix = writeNodeShim(h.home, "p", script, { SHIM_VAR: "it's" }, "linux");
      expect(posix).toBe(join(h.home, shimFileName("p", "linux")));
      expect(readFileSync(posix, "utf8")).toMatch(/^#!\/bin\/sh\nSHIM_VAR='it'\\''s' exec /);
      const win = writeNodeShim(h.home, "w", script, { SHIM_VAR: "v" }, "win32");
      expect(win).toBe(join(h.home, "w.cmd"));
      expect(readFileSync(win, "utf8")).toBe(npmCmdShim("w.mjs"));
      const r = spawnSync(process.execPath, [join(h.home, "w.mjs"), "a", "b"], {
        encoding: "utf8",
      });
      expect(r.stdout).toBe("v a b\n");
    } finally {
      h.cleanup();
    }
  });

  it("[AC1] Windows test env: tempHome redirects APPDATA, runNode keeps the system variables", () => {
    const h = tempHome("win32");
    expect(h.env.USERPROFILE).toBe(h.home);
    expect(h.env.APPDATA).toBe(join(h.home, "AppData", "Roaming"));
    expect(tempHome("linux").env.APPDATA).toBeUndefined();
    h.cleanup();
    const source = { SystemRoot: "C:\\Windows", TEMP: "C:\\T", SECRET: "s" };
    expect(withWindowsBase({ A: "1" }, "win32", source)).toEqual({
      A: "1",
      SYSTEMROOT: "C:\\Windows",
      TEMP: "C:\\T",
    });
    expect(withWindowsBase({ TEMP: "mine" }, "win32", source).TEMP).toBe("mine");
    expect(withWindowsBase({ A: "1" }, "linux", source)).toEqual({ A: "1" });
  });
});
