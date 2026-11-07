/**
 * Test helper standing in for a nested `dispatch run`: applies the recursion guard to its own
 * environment and exits with the mapped exit code (what the real CLI does before doing any work).
 */
import { exitCodeOf } from "../../src/core/errors.js";
import { assertDepthAllowed } from "../../src/runner/depth.js";

try {
  const depth = assertDepthAllowed(process.env, Number(process.argv[2] ?? "1"));
  process.stdout.write(`allowed depth=${depth}\n`);
} catch (err) {
  const e = err as { outcome?: string; reason?: string; message: string };
  process.stdout.write(`outcome=${e.outcome} reason=${e.reason}\n`);
  process.stderr.write(`${e.message}\n`);
  process.exitCode = exitCodeOf(err);
}
