/**
 * Built-in host integrations. WP22 (claude-code) and WP27 (codex) add one `registerHost(...)` line
 * each here, plus their doctor checks; their hook handlers go in `src/hook/handlers.ts`.
 */
import { manifestCheck, registry } from "./_framework/index.js";
import { claudeDoctorChecks } from "./claude-code/doctor.js";
import { claudeCodeIntegration } from "./claude-code/integration.js";

let done = false;

/** Registers the built-in hosts and framework doctor checks once; returns the registry. */
export function builtinRegistry(): typeof registry {
  if (!done) {
    registry.registerDoctorCheck(manifestCheck);
    registry.registerHost(claudeCodeIntegration);
    for (const check of claudeDoctorChecks()) registry.registerDoctorCheck(check);
    done = true;
  }
  return registry;
}
