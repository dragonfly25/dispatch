/** `dispatch install` and `dispatch uninstall` (repo part, WP21). */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Command } from "commander";
import { refreshHookCacheSafely } from "../app/hook-cache.js";
import { globalConfigPath, type PathEnv } from "../config/paths.js";
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { installRepo, requireRepo, uninstallRepo } from "../install/repo.js";
import type { AnswerFlags } from "../setup/answers.js";
import type { CliIo } from "./program.js";
import { addAnswerOptions, runSetup, type SetupCommandDeps } from "./setup.js";
import { nextSteps, outUi, type Ui } from "./ui.js";

/** What `ensureGlobalSetup` receives. */
export interface SetupContext {
  /** The answer flags of `install` (--host, --plan, --autonomy, ...), handed to the wizard. */
  answers: AnswerFlags;
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

/** The hints printed after a successful `install`. */
const INSTALL_NEXT: [string, string][] = [
  ["dispatch doctor", "check the CLIs, logins and hooks"],
  ["dispatch status", "see the quota of each provider"],
  ["git add .dispatch && git commit", "share the policy with your team"],
];

/**
 * Decorates one line printed by the repo install/uninstall flows: `+` creations green, `-`
 * removals yellow, warnings with a symbol. Plain output is returned unchanged.
 */
export function styleInstallLine(ui: Ui, line: string): string {
  if (!ui.enabled) return line;
  if (line.startsWith("  + ")) return `  ${ui.green("+")} ${line.slice(4)}`;
  if (line.startsWith("  - ")) return `  ${ui.yellow("-")} ${line.slice(4)}`;
  if (line.startsWith("  = ")) return ui.dim(line);
  if (line.startsWith("warning: ")) return `${ui.mark("warn")} ${ui.yellow(line.slice(9))}`;
  if (line.startsWith("Aborted")) return `${ui.mark("warn")} ${line}`;
  if (line.startsWith("Removed ")) return `${ui.mark("ok")} ${line}`;
  return line;
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
    await runSetup(ctx.io, setup, {
      ...ctx.answers,
      yes: ctx.yes,
      nonInteractive: ctx.nonInteractive,
    });
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

interface InstallFlags extends Omit<AnswerFlags, "profile"> {
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
  const ui = outUi(io);
  const say = (line: string): void => io.out(styleInstallLine(ui, line));
  /** Rewrites the hook cache for the policy now in effect in `cwd` (best effort). */
  const refresh = (cwd: string): void =>
    refreshHookCacheSafely({ cwd, env: deps.env }, (m) => io.err(`warning: ${m}\n`));

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

  const install = program
    .command("install")
    .description("create .dispatch/ (config, profiles, mappings) in the current git repository")
    .option("--non-interactive", "never prompt; use flags and defaults")
    .option("--profile <name>", "routing profile to activate (default: balance)")
    .option("--unspecified-model <value>", "inherit | classify | <tier> (default: balanced)")
    .option("--yes", "do not ask for confirmation")
    .option("--no-trust", "do not trust the new policy files (run `dispatch trust` later)")
    .option("--force", "use an existing .dispatch/, creating only the files that are missing")
    .option("--skip-setup", "do not run `dispatch setup` when the global config is missing");
  // The answer flags only matter when `install` has to run `setup` first (no global config yet).
  addAnswerOptions(install);
  install.action(async (flags: InstallFlags) => {
    const confirm = confirmFor(flags.yes || flags.nonInteractive);
    const interactive = deps.isInteractive() && !flags.nonInteractive;
    const cwd = deps.cwd();
    requireRepo(cwd);
    const setupCtx: SetupContext = {
      answers: {
        answers: flags.answers,
        host: flags.host,
        profile: flags.profile,
        autonomy: flags.autonomy,
        plan: flags.plan,
        enableAntigravity: flags.enableAntigravity,
        acceptAgyTerms: flags.acceptAgyTerms,
      },
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
    refresh(cwd);
    const done = `Installed: ${result.created.length} file(s) in .dispatch/${result.trusted ? " (trusted)" : ""}.`;
    io.out(`\n${ui.enabled ? `${ui.mark("ok")} ${ui.bold(done)}` : done}\n`);
    io.out(nextSteps(ui, INSTALL_NEXT));
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
      refresh(deps.cwd());
    },
  };
}
