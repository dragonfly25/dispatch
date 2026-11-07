import type { CommandRunner } from "../hosts/_framework/edits.js";
import { execTool } from "./exec.js";

/**
 * Production {@link CommandRunner} for `cli-command` setup ops (e.g. `claude plugin install …`).
 * Runs without a shell in `cwd` (normally HOME) with a 120 s timeout by default.
 */
export function createCommandRunner(opts: { cwd: string; timeoutMs?: number }): CommandRunner {
  return {
    async run(binary, argv) {
      const r = await execTool(binary, argv, {
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs ?? 120_000,
      });
      return { code: r.code, stdout: r.stdout, stderr: r.stderr };
    },
  };
}
