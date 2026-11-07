/** `dispatch validate`: static checks of the effective configuration (UC5, UC6). */
import type { Command } from "commander";
import { validate } from "../../config/index.js";
import { ExitCode } from "../../core/contracts.js";
import { DispatchError } from "../../core/errors.js";
import { type CliDeps, printJson, withContext } from "./shared.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Registers `validate`. Exit 2 when any error is found; warnings alone exit 0. */
export function registerValidate(program: Command, deps: CliDeps): void {
  program
    .command("validate")
    .description("check the effective configuration (exit 2 on any error)")
    .option("--json", "machine-readable output")
    .action(async (opts: { json?: boolean }) => {
      await withContext(deps, (ctx) => {
        const issues = validate(ctx.config);
        const errors = issues.filter((i) => i.level === "error").length;
        const warnings = issues.length - errors;
        if (opts.json) {
          printJson(deps.io, { ok: errors === 0, errors, warnings, issues });
        } else {
          for (const i of issues) deps.io.out(`${i.level.padEnd(7)} ${i.path}: ${i.message}\n`);
          deps.io.out(
            `${errors === 0 ? "Configuration OK" : "Configuration invalid"}: ${plural(errors, "error")}, ${plural(warnings, "warning")}\n`,
          );
        }
        if (errors > 0) {
          throw new DispatchError(
            `validation failed with ${plural(errors, "error")}`,
            ExitCode.USAGE,
            "config.validate",
          );
        }
      });
    });
}
