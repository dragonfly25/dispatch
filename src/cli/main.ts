import { runCli } from "./program.js";
import { installWarningFilter } from "./warnings.js";

installWarningFilter();
process.exitCode = await runCli(process.argv.slice(2));
