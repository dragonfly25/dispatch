import { dirname, join, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { powershellQuote } from "./invocation.js";
import { isWindows, type OsPlatform } from "./os.js";

/** Absolute paths of the running installation. */
export interface InstallPaths {
  nodePath: string;
  cliPath: string;
  hookPath: string;
}

function invalid(what: string, reason: string): never {
  throw new DispatchError(`${what}: ${reason}`, ExitCode.USAGE, "launcher.unsafe_path");
}

/**
 * Validates an absolute path with no NUL or newline (the minimum for any shell quoting). With
 * `platform` win32 the path must be drive- or UNC-absolute (`C:\x`, `\\server\share`), not a
 * drive-relative `\x`; otherwise it must be POSIX-absolute.
 */
function checkPath(what: string, p: string, platform: OsPlatform = "linux"): void {
  const absolute = isWindows(platform)
    ? win32.isAbsolute(p) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(p)
    : posix.isAbsolute(p);
  if (!absolute) invalid(what, `path must be absolute: ${JSON.stringify(p)}`);
  if (/[\0\n\r]/.test(p)) invalid(what, "path contains a NUL or newline");
}

/** Characters that are special inside a double-quoted POSIX shell string. */
const DOUBLE_QUOTE_UNSAFE = /["$`\\]/;

/** Characters that cmd.exe interprets even inside a double-quoted batch-file argument. */
const CMD_UNSAFE = /["%!^&|<>]/;

/**
 * Renders the launcher under `~/.dispatch/bin` ({@link launcherFileName}).
 *
 * - POSIX: `dispatch`, a sh script that execs the absolute node with the absolute cli. Paths
 *   containing `"`, `$`, backtick, backslash, NUL or a newline are rejected (USAGE) instead of
 *   escaped, so the script can never be made to run anything else.
 * - Windows: `dispatch.cmd` (CRLF, `@echo off`) that runs `"<node.exe>" ... "<cli.mjs>" %*`. Paths
 *   containing `"`, `%`, `!`, `^`, `&`, `|`, `<`, `>`, NUL or a newline are rejected the same way.
 *   This file is for the user's own shell; hosts call node and the cli directly
 *   ({@link hostInvocation}) because cmd.exe re-parses `%*`.
 */
export function renderLauncherScript(
  paths: Pick<InstallPaths, "nodePath" | "cliPath">,
  platform: OsPlatform = process.platform,
): string {
  if (isWindows(platform)) return renderLauncherCmd(paths);
  for (const [what, p] of [
    ["node path", paths.nodePath],
    ["cli path", paths.cliPath],
  ] as const) {
    checkPath(what, p);
    if (DOUBLE_QUOTE_UNSAFE.test(p)) {
      invalid(what, `path contains a shell-special character (" $ \` \\): ${JSON.stringify(p)}`);
    }
  }
  return `#!/bin/sh\nexec "${paths.nodePath}" --disable-warning=ExperimentalWarning "${paths.cliPath}" "$@"\n`;
}

/** The Windows `dispatch.cmd` launcher (see {@link renderLauncherScript}). */
function renderLauncherCmd(paths: Pick<InstallPaths, "nodePath" | "cliPath">): string {
  for (const [what, p] of [
    ["node path", paths.nodePath],
    ["cli path", paths.cliPath],
  ] as const) {
    checkPath(what, p, "win32");
    if (CMD_UNSAFE.test(p)) {
      invalid(
        what,
        `path contains a cmd-special character (" % ! ^ & | < >): ${JSON.stringify(p)}`,
      );
    }
  }
  return `@echo off\r\n"${paths.nodePath}" --disable-warning=ExperimentalWarning "${paths.cliPath}" %*\r\n`;
}

const LAUNCHER_EXEC_SH = /^exec "([^"]+)"(?: [^"\s]+)* "([^"]+)" "\$@"$/m;
const LAUNCHER_EXEC_CMD = /^"([^"]+)"(?: [^"\s]+)* "([^"]+)" %\*\r?$/m;

/**
 * The node and cli paths a rendered launcher runs (either flavour: the sh `exec` line or the
 * `dispatch.cmd` line), or null for an unrecognised file.
 */
export function parseLauncherScript(
  text: string,
): Pick<InstallPaths, "nodePath" | "cliPath"> | null {
  const m = LAUNCHER_EXEC_SH.exec(text) ?? LAUNCHER_EXEC_CMD.exec(text);
  return m?.[1] && m[2] ? { nodePath: m[1], cliPath: m[2] } : null;
}

/** Single-quotes `s` for POSIX sh (an embedded `'` becomes `'\''`). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** The fields every hook rendering validates. */
export interface HookArgs {
  nodePath: string;
  hookPath: string;
  host: string;
  event: string;
}

/** Validates the hook paths for `platform` and the `host`/`event` tokens. */
function checkHookArgs(args: HookArgs, platform: OsPlatform): void {
  checkPath("node path", args.nodePath, platform);
  checkPath("hook path", args.hookPath, platform);
  for (const [what, v] of [
    ["host", args.host],
    ["event", args.event],
  ] as const) {
    if (!TOKEN.test(v)) invalid(what, `must match ${TOKEN}: ${JSON.stringify(v)}`);
  }
}

/**
 * Renders the host hook command (shell form). It stays silent (exit 0) when invoked from a
 * Dispatch child or when node or the hook file is gone, so an uninstalled Dispatch never breaks
 * a host.
 *
 * - POSIX (`sh -c`):
 *
 *       [ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x N ] && [ -f H ] || exit 0; exec N H <host> <event>
 *
 *   Paths are single-quoted.
 * - Windows: the PowerShell script Codex runs with `powershell.exe -NoProfile -Command` (its
 *   default Windows shell, docs/spikes/windows.md). `$OutputEncoding` and the console input
 *   and output encodings are set to UTF-8 without BOM first (Windows PowerShell 5.1 otherwise
 *   decodes stdin and native output with the OEM code page, garbling a cwd such as
 *   `C:\Users\José\repo`; setting the console encodings is best effort, since it can throw
 *   when no console is attached), then stdin is forwarded through `$input`; paths are PowerShell single-quoted literals (no expansion). Claude Code on
 *   Windows uses {@link renderHookExec} instead.
 *
 * `host` and `event` must be simple tokens.
 */
export function renderHookCommand(args: HookArgs, platform: OsPlatform = process.platform): string {
  if (isWindows(platform)) return renderPowerShellHookCommand(args);
  checkHookArgs(args, "linux");
  const node = shQuote(args.nodePath);
  const hook = shQuote(args.hookPath);
  return `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x ${node} ] && [ -f ${hook} ] || exit 0; exec ${node} ${hook} ${args.host} ${args.event}`;
}

/** The Windows (PowerShell) form of {@link renderHookCommand}. */
function renderPowerShellHookCommand(args: HookArgs): string {
  checkHookArgs(args, "win32");
  const node = powershellQuote(args.nodePath);
  const hook = powershellQuote(args.hookPath);
  return (
    "if ($env:DISPATCH_DEPTH) { exit 0 }; " +
    `if (-not (Test-Path -LiteralPath ${node} -PathType Leaf) -or -not (Test-Path -LiteralPath ${hook} -PathType Leaf)) { exit 0 }; ` +
    "$utf8 = New-Object System.Text.UTF8Encoding $false; " +
    "try { [Console]::InputEncoding = $utf8; [Console]::OutputEncoding = $utf8 } catch {}; " +
    "$OutputEncoding = $utf8; " +
    `$input | & ${node} ${hook} ${args.host} ${args.event}; exit $LASTEXITCODE`
  );
}

/**
 * The exec form of a hook (no shell): `command` is the absolute node, `args` the hook entry,
 * host and event. Claude Code on Windows runs it this way (`args` set; Claude Code 2.1.139+), so
 * no shell ever parses the paths. A missing node or hook file is a non-blocking hook error there;
 * the hook entry itself returns silently for a Dispatch child (`DISPATCH_DEPTH`).
 */
export function renderHookExec(
  args: HookArgs,
  platform: OsPlatform = process.platform,
): { command: string; args: string[] } {
  checkHookArgs(args, isWindows(platform) ? "win32" : "linux");
  return { command: args.nodePath, args: [args.hookPath, args.host, args.event] };
}

/**
 * Paths of the running installation: `process.execPath` plus `cli.mjs` and `hook.mjs`, which the
 * build emits side by side. `moduleUrl` is the `import.meta.url` of a built dist file (the
 * default only gives meaningful paths inside the bundle).
 */
export function currentInstallPaths(
  opts: { moduleUrl?: string; execPath?: string } = {},
): InstallPaths {
  const dir = dirname(fileURLToPath(opts.moduleUrl ?? import.meta.url));
  return {
    nodePath: opts.execPath ?? process.execPath,
    cliPath: join(dir, "cli.mjs"),
    hookPath: join(dir, "hook.mjs"),
  };
}
