import { ExitCode } from "./contracts.js";

/**
 * Error carrying the CLI exit code it maps to. Throw it from any layer; the CLI entry turns it
 * into `process.exitCode` and prints `message` (never a stack trace) to stderr.
 */
export class DispatchError extends Error {
  override readonly name = "DispatchError";

  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.FAILED,
    /** Stable machine-readable code, e.g. "config.invalid", "run.depth_exceeded". */
    readonly code = "dispatch.error",
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Exit code for any thrown value: a DispatchError's own code, otherwise FAILED. */
export function exitCodeOf(err: unknown): ExitCode {
  return err instanceof DispatchError ? err.exitCode : ExitCode.FAILED;
}
