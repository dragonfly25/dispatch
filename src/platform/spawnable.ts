/**
 * Turns a resolved executable into something `child_process.spawn` can start with
 * `shell: false` on every platform.
 *
 * On Windows, Node refuses to spawn `.cmd`/`.bat` files without a shell (CVE-2024-27980), and
 * running them through `cmd.exe` would expose prompts and paths to cmd's quoting rules. So an npm
 * `cmd-shim` wrapper (`claude.cmd`, `codex.cmd`, ...) is unwrapped to `node <script>`; any other
 * batch file is refused. `.exe` files and every POSIX path pass through unchanged.
 */
import { readFileSync, statSync } from "node:fs";
import { win32 } from "node:path";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { isWindows, type OsPlatform } from "./os.js";
import { isWindowsAbsolute } from "./resolve.js";

/** What to hand to `spawn(command, args, { shell: false })`. */
export interface SpawnCommand {
  command: string;
  args: string[];
}

/** Options of {@link toSpawnCommand}. */
export interface ToSpawnOptions {
  platform?: OsPlatform;
  /** Node used for an unwrapped npm shim when the shim's own `node.exe` sibling is absent. */
  nodePath?: string;
  /** Reads a shim's text; injectable for tests. */
  readFile?: (path: string) => string;
  /** True when the path exists; injectable for tests. */
  exists?: (path: string) => boolean;
}

/**
 * What an npm/pnpm/yarn `cmd-shim` batch file runs, with paths relative to the shim's directory
 * (backslash-separated, as written in the shim):
 * - `node`: `node [nodeArgs] <script> %*` (the shim prefers its sibling `node.exe`);
 * - `direct`: `<target> %*` (the package's bin is not a node script, e.g. a bundled `.exe`).
 */
export type CmdShim =
  | { kind: "node"; script: string; nodeArgs: string[] }
  | { kind: "direct"; target: string };

/** `"%dp0%\rel"` (cmd-shim >= 3) or `"%~dp0\rel"` (older npm, pnpm). No `%`/`"` inside `rel`. */
const DP0_PATH = String.raw`"(?:%dp0%|%~dp0)\\([^"%\r\n]+)"`;
/** Optional interpreter flags from the package's shebang (`#!/usr/bin/env node --flag`). */
const ARGS = String.raw`((?:\s+[^\s"%]+)*?)`;
/** Interpreter forms npm/pnpm shims use before the script. */
const NODE_PROG = String.raw`(?:"%_prog%"|"(?:%dp0%|%~dp0)\\node\.exe"|node)`;
const NODE_LINE = new RegExp(String.raw`^${NODE_PROG}${ARGS}\s+${DP0_PATH}\s+%\*$`);
const DIRECT_LINE = new RegExp(String.raw`^${DP0_PATH}${ARGS}\s+%\*$`);
/** cmd-shim's prefix that ends `SETLOCAL` before running the program. */
const ENDLOCAL_PREFIX =
  /^endLocal\s*&\s*goto\s+#_undefined_#\s+2>NUL\s*\|\|\s*title\s+%COMSPEC%\s*&\s*/i;
const PROG_SET = /SET\s+"_prog=([^"]*)"/gi;
/** A shebang flag we are willing to forward to node, e.g. `--no-warnings`, `--max-old-space-size=4096`. */
const NODE_FLAG = /^--?[A-Za-z0-9][A-Za-z0-9-]*(=[A-Za-z0-9._:/-]+)?$/;

/**
 * Parses the text of a Windows `cmd-shim` (npm, pnpm, yarn) and returns what it runs, or null
 * when the text is not recognisably one. Every line that forwards `%*` must be an invocation of
 * the same target; `_prog` may only be `node` or the shim's sibling `node.exe`; the relative path
 * must not contain `%` or `"` (no variable expansion) and must not be absolute.
 */
export function parseCmdShim(text: string): CmdShim | null {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("%*"));
  if (lines.length === 0) return null;

  let progSet = false;
  for (const m of text.matchAll(PROG_SET)) {
    const prog = String(m[1]);
    if (!/^(node|%dp0%\\node\.exe|%~dp0\\node\.exe)$/i.test(prog)) return null;
    progSet = true;
  }

  let found: CmdShim | null = null;
  for (const raw of lines) {
    const line = raw.replace(/^@/, "").replace(ENDLOCAL_PREFIX, "");
    let current: CmdShim | null = null;
    const node = NODE_LINE.exec(line);
    if (node) {
      // `%_prog%` unset by the shim would come from the caller's environment.
      if (line.startsWith('"%_prog%"') && !progSet) return null;
      const nodeArgs = String(node[1]).trim().split(/\s+/).filter(Boolean);
      if (!nodeArgs.every((a) => NODE_FLAG.test(a))) return null;
      current = { kind: "node", script: String(node[2]), nodeArgs };
    } else {
      const direct = DIRECT_LINE.exec(line);
      if (!direct || String(direct[2]).trim() !== "") return null;
      current = { kind: "direct", target: String(direct[1]) };
    }
    const rel = current.kind === "node" ? current.script : current.target;
    if (win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
    if (found === null) found = current;
    else if (JSON.stringify(found) !== JSON.stringify(current)) return null;
  }
  return found;
}

/** The script path an npm `cmd-shim` runs with node (relative to the shim's dir), or null. */
export function parseNpmCmdShim(text: string): string | null {
  const shim = parseCmdShim(text);
  return shim?.kind === "node" ? shim.script : null;
}

/** True when `path` is an existing regular file (after symlinks); the default `exists`. */
export function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function unspawnable(binary: string, reason: string): DispatchError {
  return new DispatchError(
    `cannot start ${binary}: ${reason}. Windows runs .cmd/.bat files only through cmd.exe, ` +
      "which Dispatch never uses; set `binary:` for this provider to the program's .exe.",
    ExitCode.USAGE,
    "binary.unspawnable",
  );
}

/**
 * Returns the command and argv to spawn `binary` with `argv`. Throws a USAGE DispatchError
 * (`binary.unspawnable`) for a Windows batch file that is not a recognisable npm shim.
 *
 * Windows: `.exe`/`.com` pass through; a `.cmd`/`.bat` npm shim becomes
 * `<shimDir>\node.exe <script> ...argv` (or `opts.nodePath ?? process.execPath` when the shim has
 * no sibling `node.exe`), or the shim's `.exe` target for a direct shim. The script/target must
 * be an existing file. Any other file (no extension, `.ps1`, `.js`, ...) is refused. POSIX: pass
 * through.
 */
export function toSpawnCommand(
  binary: string,
  argv: readonly string[],
  opts: ToSpawnOptions = {},
): SpawnCommand {
  if (!isWindows(opts.platform ?? process.platform)) return { command: binary, args: [...argv] };

  const ext = win32.extname(binary).toLowerCase();
  if (ext === ".exe" || ext === ".com") return { command: binary, args: [...argv] };
  if (ext !== ".cmd" && ext !== ".bat") {
    throw unspawnable(binary, "only .exe, .com and npm .cmd shims can be started on Windows");
  }
  if (!isWindowsAbsolute(binary)) {
    throw unspawnable(binary, "a batch file must be given as an absolute path");
  }

  const readFile = opts.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const exists = opts.exists ?? isRegularFile;
  let text: string;
  try {
    text = readFile(binary);
  } catch {
    throw unspawnable(binary, "the batch file cannot be read");
  }
  const shim = parseCmdShim(text);
  if (shim === null) throw unspawnable(binary, "the batch file is not an npm cmd-shim");

  const dir = win32.dirname(binary);
  if (shim.kind === "direct") {
    const target = win32.join(dir, shim.target);
    const targetExt = win32.extname(target).toLowerCase();
    if (targetExt !== ".exe" && targetExt !== ".com") {
      throw unspawnable(binary, `the shim runs ${target}, which is not a .exe`);
    }
    if (!exists(target)) throw unspawnable(binary, `the shim's target ${target} does not exist`);
    return { command: target, args: [...argv] };
  }

  const script = win32.join(dir, shim.script);
  if (!exists(script)) throw unspawnable(binary, `the shim's script ${script} does not exist`);
  const sibling = win32.join(dir, "node.exe");
  const node = exists(sibling) ? sibling : (opts.nodePath ?? process.execPath);
  return { command: node, args: [...shim.nodeArgs, script, ...argv] };
}
