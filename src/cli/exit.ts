import type { ExitCode } from "../core/contracts.js";

/**
 * Thrown by a command that has already printed everything and only wants a non-zero exit code
 * (e.g. `run` for a failed task, `wait` for a run that is still going). `runCli` returns `code`
 * and prints nothing more.
 */
export class ExitRequest extends Error {
  override readonly name = "ExitRequest";

  constructor(readonly code: ExitCode) {
    super(`exit ${code}`);
  }
}
