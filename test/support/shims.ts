/**
 * Node-script shims for tests, in the shape the platform expects: a POSIX `#!/bin/sh` script, or
 * on Windows an npm `cmd-shim` `.cmd` that production `toSpawnCommand` unwraps to
 * `node <script>` (so tests exercise the real Windows spawn path, never `cmd.exe`).
 */
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isWindows, type OsPlatform } from "../../src/platform/os.js";

/**
 * Text of an npm cmd-shim (cmd-shim >= 3 layout, CRLF) that runs `node "%dp0%\<rel>" %*`.
 * `rel` is relative to the shim's directory and uses backslashes.
 */
export function npmCmdShim(rel: string): string {
  const lines = [
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
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${rel}" %*`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** File name of an executable shim named `name` on `platform` (`name` or `name.cmd`). */
export function shimFileName(name: string, platform: OsPlatform = process.platform): string {
  return isWindows(platform) ? `${name}.cmd` : name;
}

const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Writes an executable `name` into `dir` that runs `node <script> "$@"` with `env` set, and returns
 * its path. POSIX: one `#!/bin/sh` file (mode 0755). Windows: `name.mjs` (sets `env`, then imports
 * `script`) plus the `name.cmd` cmd-shim that unwraps to `node name.mjs`.
 */
export function writeNodeShim(
  dir: string,
  name: string,
  script: string,
  env: Record<string, string> = {},
  platform: OsPlatform = process.platform,
): string {
  if (isWindows(platform)) {
    const entry = join(dir, `${name}.mjs`);
    writeFileSync(
      entry,
      [
        'import { pathToFileURL } from "node:url";',
        `Object.assign(process.env, ${JSON.stringify(env)});`,
        `await import(pathToFileURL(${JSON.stringify(script)}).href);`,
        "",
      ].join("\n"),
    );
    const shim = join(dir, `${name}.cmd`);
    writeFileSync(shim, npmCmdShim(`${name}.mjs`));
    return shim;
  }
  const file = join(dir, name);
  const assigns = Object.entries(env).map(([k, v]) => `${k}=${shq(v)} `);
  writeFileSync(
    file,
    `#!/bin/sh\n${assigns.join("")}exec ${shq(process.execPath)} ${shq(script)} "$@"\n`,
  );
  chmodSync(file, 0o755);
  return file;
}
