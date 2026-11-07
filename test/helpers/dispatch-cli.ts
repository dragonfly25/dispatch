/**
 * Test helper process (bundled by the detach tests, never shipped): the real `dispatch` CLI entry,
 * so `startDetached` can start `__supervise` exactly as the installed bin would.
 * Usage: node dispatch-cli.mjs <args>
 */
import { runCli } from "../../src/cli/program.js";

process.exitCode = await runCli(process.argv.slice(2));
