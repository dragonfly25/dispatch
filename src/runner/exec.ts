import { execFile } from "node:child_process";
import { DispatchError } from "../core/errors.js";

/** Options for {@link execTool}. */
export interface ExecToolOptions {
  cwd: string;
  /** Extra variables layered over the current environment. */
  env?: Record<string, string>;
  /** Written to the child's stdin, then stdin is closed. */
  input?: string;
  /** Kills the child (SIGKILL) after this many milliseconds. */
  timeoutMs?: number;
}

/** Outcome of a finished tool. `code` is -1 when the child died from a signal (e.g. timeout). */
export interface ExecToolResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Runs a short-lived tool (git, ...) without a shell. A non-zero exit is NOT an error: it is
 * reported through `code`. Only a failure to spawn (missing binary, bad cwd) rejects.
 */
export function execTool(
  cmd: string,
  args: readonly string[],
  opts: ExecToolOptions,
): Promise<ExecToolResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      [...args],
      {
        cwd: opts.cwd,
        env: { ...process.env, ...opts.env },
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout, stderr, timedOut: false });
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string };
        if (typeof e.code === "number") {
          return resolve({ code: e.code, stdout, stderr, timedOut: false });
        }
        if (e.killed) {
          return resolve({ code: -1, stdout, stderr, timedOut: opts.timeoutMs != null });
        }
        reject(
          new DispatchError(`failed to run ${cmd}: ${e.message}`, undefined, "exec.spawn_failed", {
            cause: err,
          }),
        );
      },
    );
    // A tool that exits before reading stdin makes the write fail with EPIPE; that is not an error.
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input);
  });
}
