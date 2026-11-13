import { Command, CommanderError } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { CODEX_WINDOWS_NO_RULES, codexRulesSupported } from "../hosts/codex/integration.js";
import { CODEX_SANDBOX_MESSAGE, codexSandboxActive } from "../platform/host.js";
import { currentInstallPaths } from "../platform/launcher.js";
import { assertSupportedPlatform } from "../platform/platform.js";
import { type CliDeps, registerReadCommands } from "./commands/index.js";
import { ExitRequest } from "./exit.js";
import { type CliIo, processIo } from "./io.js";
import { type RepoCommandDeps, registerRepoCommands } from "./repo-commands.js";
import { defaultSetupDeps, registerSetupCommands, type SetupCommandDeps } from "./setup.js";

export type { CliIo } from "./io.js";

/** Package version, read from package.json at build time. */
export const VERSION: string = pkg.version;

/**
 * Builds the commander program. `setupDeps` overrides the setup commands' collaborators and
 * `repoDeps` those of `install`/`uninstall`, and `readDeps` carries the process facts the read
 * commands use (cwd, environment, clock, spawner); tests inject their own. Later work packages register more commands here.
 */
export function buildProgram(
  io: CliIo = processIo,
  setupDeps: Partial<SetupCommandDeps> = {},
  repoDeps: Partial<RepoCommandDeps> = {},
  readDeps: Omit<CliDeps, "io"> = { cwd: process.cwd(), env: process.env },
): Command {
  const program = new Command()
    .name("dispatch")
    .description("Route coding-agent tasks across your Claude Code, Codex and Antigravity plans.")
    .version(VERSION, "-v, --version", "print the version")
    .helpOption("-h, --help", "show help")
    .showHelpAfterError("(run `dispatch --help` for usage)")
    .configureOutput({ writeOut: io.out, writeErr: io.err })
    .exitOverride()
    .addCommand(
      new Command("__paths")
        .description("print the absolute node, cli and hook paths as JSON (internal)")
        .action(() => io.out(`${JSON.stringify(currentInstallPaths())}\n`)),
      { hidden: true },
    );
  const fullSetup: SetupCommandDeps = { ...defaultSetupDeps(), ...setupDeps };
  // `install` and the repo part of `uninstall` (WP21) share the setup deps: install runs the
  // real setup when the global config is missing.
  const repo = registerRepoCommands(program, io, repoDeps, fullSetup);
  registerSetupCommands(program, io, { repoUninstall: repo.uninstall, ...fullSetup });
  registerReadCommands(program, { ...readDeps, io });
  return program;
}

/** Process facts the entry gates depend on; injectable for tests. */
export interface CliContext {
  platform: string;
  env: Readonly<Record<string, string | undefined>>;
}

const processContext = (): CliContext => ({ platform: process.platform, env: process.env });

/** Arguments that only print help or the version and are safe everywhere. */
const INFO_ONLY = new Set(["-h", "--help", "-v", "--version"]);

/**
 * Runs the CLI with `args` (without node and script path) and returns the exit code.
 * Never calls `process.exit`. Usage errors map to {@link ExitCode.USAGE}. Gates first: unsupported
 * platform (USAGE) and the Codex sandbox (REJECTED, except for help/version).
 */
export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
  program: Command = buildProgram(io),
  ctx: CliContext = processContext(),
): Promise<number> {
  try {
    assertSupportedPlatform(ctx.platform);
    if (args.length === 0) {
      io.out(program.helpInformation());
      return ExitCode.OK;
    }
    // `doctor` is exempt: it is how the user finds out why the rule did not match (--from-host).
    if (codexSandboxActive(ctx.env) && !INFO_ONLY.has(args[0] ?? "") && args[0] !== "doctor") {
      const message = codexRulesSupported(ctx.platform as NodeJS.Platform)
        ? CODEX_SANDBOX_MESSAGE
        : `running inside the Codex sandbox: ${CODEX_WINDOWS_NO_RULES}`;
      io.err(`dispatch: ${message}\n`);
      return ExitCode.REJECTED;
    }
    await program.parseAsync([...args], { from: "user" });
    return ExitCode.OK;
  } catch (err) {
    if (err instanceof ExitRequest) return err.code;
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
