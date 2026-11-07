import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Absolute paths of the running installation. */
export interface InstallPaths {
  nodePath: string;
  cliPath: string;
  hookPath: string;
}

function invalid(what: string, reason: string): never {
  throw new DispatchError(`${what}: ${reason}`, ExitCode.USAGE, "launcher.unsafe_path");
}

/** Validates an absolute path with no NUL or newline (the minimum for any shell quoting). */
function checkPath(what: string, p: string): void {
  if (!isAbsolute(p)) invalid(what, `path must be absolute: ${JSON.stringify(p)}`);
  if (/[\0\n\r]/.test(p)) invalid(what, "path contains a NUL or newline");
}

/** Characters that are special inside a double-quoted POSIX shell string. */
const DOUBLE_QUOTE_UNSAFE = /["$`\\]/;

/**
 * Renders the `~/.dispatch/bin/dispatch` launcher: a POSIX sh script that execs the absolute node
 * with the absolute cli. Paths containing `"`, `$`, backtick, backslash, NUL or a newline are
 * rejected (USAGE) instead of escaped, so the script can never be made to run anything else.
 */
export function renderLauncherScript(paths: Pick<InstallPaths, "nodePath" | "cliPath">): string {
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

/** Single-quotes `s` for POSIX sh (an embedded `'` becomes `'\''`). */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Renders the host hook command. It stays silent (exit 0) when invoked from a Dispatch child or
 * when node or the hook file is gone, so an uninstalled Dispatch never breaks a host:
 *
 *     [ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x N ] && [ -f H ] || exit 0; exec N H <host> <event>
 *
 * Paths are single-quoted; `host` and `event` must be simple tokens.
 */
export function renderHookCommand(args: {
  nodePath: string;
  hookPath: string;
  host: string;
  event: string;
}): string {
  checkPath("node path", args.nodePath);
  checkPath("hook path", args.hookPath);
  for (const [what, v] of [
    ["host", args.host],
    ["event", args.event],
  ] as const) {
    if (!TOKEN.test(v)) invalid(what, `must match ${TOKEN}: ${JSON.stringify(v)}`);
  }
  const node = shQuote(args.nodePath);
  const hook = shQuote(args.hookPath);
  return `[ -n "$DISPATCH_DEPTH" ] && exit 0; [ -x ${node} ] && [ -f ${hook} ] || exit 0; exec ${node} ${hook} ${args.host} ${args.event}`;
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
