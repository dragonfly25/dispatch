/** `dispatch install` and `dispatch uninstall` (repo part, WP21). */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import { globalConfigPath, type PathEnv } from "../config/paths.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { installRepo, requireRepo, uninstallRepo } from "../install/repo.js";
import type { CliIo } from "./program.js";
import { runSetup, type SetupCommandDeps } from "./setup.js";

/** What `ensureGlobalSetup` receives. */
export interface SetupContext {
  env: PathEnv;
  io: CliIo;
  /** Interactive terminal available (the real `setup` may ask questions). */
  interactive: boolean;
  /** `install --yes`: apply setup without asking. */
  yes: boolean;
  /** `install --non-interactive`: never prompt. */
  nonInteractive: boolean;
}

/** Injectable collaborators of the repo commands. */
export interface RepoCommandDeps {
  cwd(): string;
  env: PathEnv;
  now(): Date;
  /** True when stdin and stdout are terminals. */
  isInteractive(): boolean;
  /** Asks a yes/no question on the terminal. */
  confirm(question: string): Promise<boolean>;
  /**
   * Makes sure the global setup exists. Default: when `~/.dispatch/config.yaml` is missing, runs
   * the real `dispatch setup` flow (WP17). Return false to stop with exit 2.
   */
  ensureGlobalSetup(ctx: SetupContext): Promise<boolean>;
}

/** Reads one answer line from `input`, printing `question` on `output`; only y/yes confirms. */
export async function promptYesNo(
  question: string,
  input: Readable = process.stdin,
  output: Writable = process.stderr,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""));
      rl.question(`${question} [y/N] `, resolve);
    });
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** Default: run `dispatch setup` (respecting --yes / --non-interactive) when the global config is missing. */
function setupRunner(setup: SetupCommandDeps): RepoCommandDeps["ensureGlobalSetup"] {
  return async (ctx) => {
    if (existsSync(globalConfigPath(ctx.env))) return true;
    ctx.io.out("No global Dispatch setup yet: running `dispatch setup` first.\n");
    await runSetup(ctx.io, setup, { yes: ctx.yes, nonInteractive: ctx.nonInteractive });
    return true;
  };
}

function defaultDeps(setup: SetupCommandDeps): RepoCommandDeps {
  return {
    cwd: () => process.cwd(),
    env: setup.env,
    now: () => new Date(),
    isInteractive: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
    confirm: (q) => promptYesNo(q),
    ensureGlobalSetup: setupRunner(setup),
  };
}

interface InstallFlags {
  nonInteractive?: boolean;
  profile?: string;
  unspecifiedModel?: string;
  yes?: boolean;
  trust: boolean;
  force?: boolean;
  skipSetup?: boolean;
}

/** What {@link registerRepoCommands} hands back for WP17's `uninstall` command to call. */
export interface RepoCommandHandles {
  /** The repo part of `uninstall` (no `--global`). */
  uninstall(io: CliIo, opts: { yes: boolean; force: boolean }): Promise<void>;
}

/**
 * Registers `install` on `program` and returns the repo-level uninstall. `uninstall` itself is
 * registered once, by `registerSetupCommands`, which routes `--global` to WP17's flow.
 */
export function registerRepoCommands(
  program: Command,
  io: CliIo,
  overrides: Partial<RepoCommandDeps>,
  setup: SetupCommandDeps,
): RepoCommandHandles {
  const deps: RepoCommandDeps = { ...defaultDeps(setup), ...overrides };
  const say = (line: string): void => io.out(line);

  /**
   * A confirm function, or undefined when the flags say not to ask. Without a terminal it fails
   * only when a question is actually asked, so no-op runs still succeed in scripts.
   */
  const confirmFor = (skip: boolean | undefined): RepoCommandDeps["confirm"] | undefined => {
    if (skip) return undefined;
    return (question) => {
      if (!deps.isInteractive()) {
        throw new DispatchError(
          "confirmation needed but there is no terminal: pass --yes (or --non-interactive)",
          ExitCode.USAGE,
          "install.no_tty",
        );
      }
      return deps.confirm(question);
    };
  };

  program
    .command("install")
    .description("create .dispatch/ (config, profiles, mappings) in the current git repository")
    .option("--non-interactive", "never prompt; use flags and defaults")
    .option("--profile <name>", "routing profile to activate (default: balance)")
    .option("--unspecified-model <value>", "inherit | classify | <tier> (default: balanced)")
    .option("--yes", "do not ask for confirmation")
    .option("--no-trust", "do not trust the new policy files (run `dispatch trust` later)")
    .option("--force", "use an existing .dispatch/, creating only the files that are missing")
    .option("--skip-setup", "do not run `dispatch setup` when the global config is missing")
    .action(async (flags: InstallFlags) => {
      const confirm = confirmFor(flags.yes || flags.nonInteractive);
      const interactive = deps.isInteractive() && !flags.nonInteractive;
      const cwd = deps.cwd();
      requireRepo(cwd);
      const setupCtx = {
        env: deps.env,
        io,
        interactive,
        yes: Boolean(flags.yes),
        nonInteractive: Boolean(flags.nonInteractive),
      };
      if (!flags.skipSetup && !(await deps.ensureGlobalSetup(setupCtx))) {
        throw new DispatchError("global setup missing", ExitCode.USAGE, "install.no_setup");
      }
      const result = await installRepo({
        cwd,
        env: deps.env,
        now: deps.now(),
        say,
        profile: flags.profile,
        unspecifiedModel: flags.unspecifiedModel,
        force: flags.force,
        trust: flags.trust,
        allowNewGlobalConfig: !flags.skipSetup,
        confirm,
      });
      if (result.status === "aborted") return;
      say(
        `\nInstalled: ${result.created.length} file(s) in .dispatch/${result.trusted ? " (trusted)" : ""}.\n` +
          "Next steps:\n" +
          "  dispatch doctor   check the CLIs, logins and hooks\n" +
          "  dispatch status   see the quota of each provider\n" +
          "  git add .dispatch && git commit   share the policy with your team\n",
      );
    });

  return {
    uninstall: async (_io, opts) => {
      await uninstallRepo({
        cwd: deps.cwd(),
        env: deps.env,
        say,
        force: opts.force,
        confirm: confirmFor(opts.yes),
      });
    },
  };
}
