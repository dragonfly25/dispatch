import { runCli } from "./program.js";

process.exitCode = await runCli(process.argv.slice(2));
