/** Registers the read-only commands (WP20). Later work packages add their own `register*` calls. */
import type { Command } from "commander";
import { registerExplain } from "./explain.js";
import { registerProfiles } from "./profiles.js";
import { registerProviders } from "./providers.js";
import type { CliDeps } from "./shared.js";
import { registerTrust } from "./trust.js";
import { registerUse } from "./use.js";
import { registerValidate } from "./validate.js";

export type { CliDeps } from "./shared.js";

/** `explain`, `validate`, `profiles`, `use`, `providers`, `trust`. */
export function registerReadCommands(program: Command, deps: CliDeps): void {
  registerExplain(program, deps);
  registerValidate(program, deps);
  registerProfiles(program, deps);
  registerUse(program, deps);
  registerProviders(program, deps);
  registerTrust(program, deps);
}
