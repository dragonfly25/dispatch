import { Command, CommanderError } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";

/** Output sinks, injectable for tests. */
export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const processIo: CliIo = {
  out: (text) => process.stdout.write(text),
  err: (text) => process.stderr.write(text),
};

/** Package version, read from package.json at build time. */
export const VERSION: string = pkg.version;

/** Builds the commander program. Subcommands are registered here by later work packages. */
export function buildProgram(io: CliIo = processIo): Command {
  return new Command()
    .name("dispatch")
    .description("Route coding-agent tasks across your Claude Code, Codex and Antigravity plans.")
    .version(VERSION, "-v, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .showHelpAfterError("(run `dispatch --help` for usage)")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride();
}

/**
 * Runs the CLI with `args` (without node and script path) and returns the exit code.
 * Never calls `process.exit`. Usage errors map to {@link ExitCode.USAGE}.
 */
export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
  program: Command = buildProgram(io),
): Promise<number> {
  if (args.length === 0) {
    io.out(program.helpInformation());
    return ExitCode.OK;
  }
  try {
    await program.parseAsync([...args], { from: "user" });
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof CommanderError) {
      const ok = err.code === "commander.helpDisplayed" || err.code === "commander.version";
      return ok ? ExitCode.OK : ExitCode.USAGE;
    }
    if (err instanceof DispatchError) {
      io.err(`dispatch: ${err.message}\n`);
      return err.exitCode;
    }
    io.err(`dispatch: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
    return ExitCode.FAILED;
  }
}
