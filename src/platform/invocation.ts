/**
 * How a host's model calls Dispatch from its shell tool. Dependency-free: the hook entry
 * (`dist/hook.mjs`, ≤ 80 ms budget) imports it.
 *
 * On POSIX the model calls the launcher `~/.dispatch/bin/dispatch` by its absolute path. On
 * Windows the launcher is `dispatch.cmd`, and any batch file re-parses its arguments through
 * cmd.exe (`%*`): a task text holding `"` and `&` could then run a command (the "BatBadBut"
 * class). So on Windows the model calls the absolute `node.exe` with the absolute `cli.mjs`
 * instead, which no shell re-parses; `dispatch.cmd` stays for the user's own terminal.
 */
import { posix, win32 } from "node:path";
import { isWindows, type OsPlatform } from "./os.js";

/** The shell the model's command goes through. */
export type HostShell = "bash" | "powershell";

/** Paths needed to build the invocation. */
export interface InvocationPaths {
  /** `<dispatchHome>/bin/dispatch` (POSIX launcher). */
  launcherPath: string;
  nodePath: string;
  cliPath: string;
}

/** `cli.mjs`, which the build emits next to `hook.mjs` (the path rules of `platform`). */
export function cliPathBesideHook(
  hookPath: string,
  platform: OsPlatform = process.platform,
): string {
  const p = isWindows(platform) ? win32 : posix;
  return p.join(p.dirname(hookPath), "cli.mjs");
}

/** Single-quotes `s` for bash/sh (an embedded `'` becomes `'\''`). */
function bashQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Single-quotes `s` for PowerShell (every single-quote character, typographic too, doubled). */
export function powershellQuote(s: string): string {
  return `'${s.replace(/['‘’‚‛]/g, (q) => q + q)}'`;
}

/**
 * The command prefix the model writes before `run`, `wait`, ... in `shell`:
 *
 * - POSIX: the launcher path, unquoted (callers quote it for their context as before).
 * - Windows, bash (Claude Code's Bash tool is Git Bash): `'<node.exe>' '<cli.mjs>'`.
 * - Windows, PowerShell (Codex): `& '<node.exe>' '<cli.mjs>'`.
 */
export function hostInvocation(
  paths: InvocationPaths,
  shell: HostShell,
  platform: OsPlatform = process.platform,
): string {
  if (!isWindows(platform)) return paths.launcherPath;
  if (shell === "powershell") {
    return `& ${powershellQuote(paths.nodePath)} ${powershellQuote(paths.cliPath)}`;
  }
  return `${bashQuote(paths.nodePath)} ${bashQuote(paths.cliPath)}`;
}

/**
 * The invocation as seen from inside a running hook (`node hook.mjs <host> <event>`): the
 * launcher `<dispatchHome>/bin/dispatch` on POSIX; on Windows the running node and the
 * `cli.mjs` beside the running hook entry (`entry`, default `process.argv[1]`).
 */
export function runningInvocation(
  dispatchHome: string,
  shell: HostShell,
  platform: OsPlatform = process.platform,
  entry: string = process.argv[1] ?? "",
): string {
  const launcherPath = (isWindows(platform) ? win32 : posix).join(dispatchHome, "bin", "dispatch");
  if (!isWindows(platform)) return launcherPath;
  const cliPath = cliPathBesideHook(entry, platform);
  const paths = { launcherPath, nodePath: process.execPath, cliPath };
  return hostInvocation(paths, shell, platform);
}
