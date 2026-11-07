/**
 * Built-in host integrations. WP22 (claude-code) and WP27 (codex) add one `registerHost(...)` line
 * each here, plus their doctor checks; their hook handlers go in `src/hook/handlers.ts`.
 */
import { manifestCheck, registry } from "./_framework/index.js";

let done = false;

/** Registers the built-in hosts and framework doctor checks once; returns the registry. */
export function builtinRegistry(): typeof registry {
  if (!done) {
    registry.registerDoctorCheck(manifestCheck);
    done = true;
  }
  return registry;
}
