/**
 * Test helper process (bundled by the runner tests, never run in production): spawns one child
 * through ProcessSpawner and relays its lines. The tests send it SIGINT/SIGTERM and then check
 * that the child's whole process group is gone.
 * Usage: node spawn-helper.mjs '<json SpawnRequest>'
 */
import { ProcessSpawner } from "../../src/runner/proc.js";

const req = JSON.parse(process.argv[2] ?? "{}");
const result = await new ProcessSpawner().spawn({
  ...req,
  onLine: (stream: string, line: string) => process.stdout.write(`${stream}:${line}\n`),
});
process.stdout.write(`done:${JSON.stringify(result)}\n`);
