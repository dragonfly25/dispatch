/** Registers the read-only and housekeeping commands (WP20, WP25). Later work packages add their own `register*` calls. */
import type { Command } from "commander";
import { registerDoctor } from "./doctor.js";
import { registerExplain } from "./explain.js";
import { registerGc } from "./gc.js";
import { registerLogs } from "./logs.js";
import { registerProfiles } from "./profiles.js";
import { registerProviders } from "./providers.js";
import { registerRun } from "./run.js";
import type { CliDeps } from "./shared.js";
import { registerStatus } from "./status.js";
import { registerTrust } from "./trust.js";
import { registerUse } from "./use.js";
import { registerValidate } from "./validate.js";

export type { CliDeps } from "./shared.js";

/** `explain`, `validate`, `profiles`, `use`, `providers`, `trust`, `status`, `logs`, `gc`, `run` and `doctor`. */
export function registerReadCommands(program: Command, deps: CliDeps): void {
  registerRun(program, deps);
  registerExplain(program, deps);
  registerValidate(program, deps);
  registerProfiles(program, deps);
  registerUse(program, deps);
  registerProviders(program, deps);
  registerTrust(program, deps);
  registerStatus(program, deps);
  registerLogs(program, deps);
  registerGc(program, deps);
  registerDoctor(program, deps);
}
