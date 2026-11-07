/**
 * `dispatch setup [--refresh] [--yes] [--non-interactive] [--reconfigure] [answer flags]` and
 * `dispatch uninstall --global [--keep-home]`. Setup installs the launcher and the host
 * integrations and, when `~/.dispatch/config.yaml` does not exist (or with `--reconfigure`),
 * asks the four setup questions and writes it (spec §10). Repo-level `install`/`uninstall`
 * belong to WP21: it passes `repoUninstall`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { type Command, Option } from "commander";
import { refreshHookCacheSafely } from "../app/hook-cache.js";
import { dispatchHome, globalConfigPath, PROFILES_DIR } from "../config/paths.js";
import { ExitCode, type HostIntegration } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  applySetup,
  type CommandRunner,
  planSetup,
  uninstallGlobal,
} from "../hosts/_framework/index.js";
import { builtinRegistry } from "../hosts/index.js";
import { shippedProfiles } from "../install/repo.js";
import { currentInstallPaths, type InstallPaths } from "../platform/launcher.js";
import { createCommandRunner } from "../runner/command.js";
import {
  type AnswerFlags,
  assertAgyConsent,
  hasAnswerFlags,
  presetAnswers,
  withDefaults,
} from "../setup/answers.js";
import { createDetector, type Detector } from "../setup/detect.js";
import {
  currentAnswers,
  readConfigText,
  renderGlobalConfig,
  updateGlobalConfig,
  writeGlobalConfig,
} from "../setup/global-config.js";
import { describeAnswers, runWizard } from "../setup/wizard.js";

/** Output sinks (same shape as the program's). */
export interface SetupIo {
  out(text: string): void;
  err(text: string): void;
}

/** Injectable dependencies of the setup commands. */
export interface SetupCommandDeps {
  env: Readonly<Record<string, string | undefined>>;
  install: () => InstallPaths;
  hosts: () => readonly HostIntegration[];
  runner: (home: string) => CommandRunner;
  /** Asks a yes/no question; resolves the raw answer. */
  ask: (question: string) => Promise<string>;
  /** True when a person can answer prompts (stdin is a TTY). */
  interactive: boolean;
  /** Quota-free CLI detection for the wizard; default: the real probes over `env`. */
  detect?: Detector;
  /** Repo-level uninstall (WP21): `uninstall` without `--global`. */
  repoUninstall?: (io: SetupIo, opts: { yes: boolean; force: boolean }) => Promise<void>;
}

async function askTty(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Production defaults. */
export function defaultSetupDeps(): SetupCommandDeps {
  return {
    env: process.env,
    install: () => currentInstallPaths(),
    hosts: () => builtinRegistry().hosts(),
    runner: (home) => createCommandRunner({ cwd: home }),
    ask: askTty,
    interactive: process.stdin.isTTY === true,
  };
}

function requireHome(env: SetupCommandDeps["env"]): { home: string; dispatchHome: string } {
  const home = env.HOME;
  if (!home) throw new DispatchError("HOME is not set", ExitCode.USAGE, "setup.no_home");
  return { home, dispatchHome: dispatchHome(env) };
}

/** Options of `dispatch setup`. */
export interface SetupOptions extends AnswerFlags {
  refresh?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
  /** Change the answers of an existing global config (comments and unknown keys are kept). */
  reconfigure?: boolean;
}

/** The global config setup is about to write. */
interface ConfigChange {
  path: string;
  text: string;
  mode: "create" | "update";
  lines: string[];
}

/** Profile names that exist: the shipped ones and the user's own in `~/.dispatch/profiles/`. */
function knownProfiles(env: SetupCommandDeps["env"]): string[] {
  const dir = join(dispatchHome(env), PROFILES_DIR);
  const own = existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".yaml"))
        .map((n) => n.slice(0, -".yaml".length))
    : [];
  return [...new Set([...shippedProfiles(), ...own])];
}

/**
 * Decides what to write to the global config, asking the wizard's questions when a person can
 * answer. Never writes. An existing config is left alone unless `--reconfigure`.
 */
async function planGlobalConfig(
  io: SetupIo,
  deps: SetupCommandDeps,
  opts: SetupOptions,
  interactive: boolean,
): Promise<ConfigChange | null> {
  const path = globalConfigPath(deps.env);
  const existing = readConfigText(path);
  if (existing !== null && !opts.reconfigure) {
    if (hasAnswerFlags(opts)) {
      io.err(
        `warning: ${path} exists, so the answer flags were ignored; add --reconfigure to change it\n`,
      );
    } else {
      io.out(`Keeping ${path} (\`dispatch setup --reconfigure\` changes it).\n`);
    }
    return null;
  }
  const preset = presetAnswers(opts, knownProfiles(deps.env));
  const answers = interactive
    ? await runWizard(
        { io, ask: deps.ask, detect: deps.detect ?? createDetector(deps.env), env: deps.env },
        preset,
        existing === null ? null : currentAnswers(existing),
      )
    : preset;
  if (existing === null) {
    const resolved = withDefaults(answers);
    return {
      path,
      text: renderGlobalConfig(resolved),
      mode: "create",
      lines: describeAnswers(resolved),
    };
  }
  assertAgyConsent(answers);
  return {
    path,
    text: updateGlobalConfig(existing, answers, path),
    mode: "update",
    lines: describeAnswers(answers),
  };
}

function renderChange(c: ConfigChange): string {
  const verb = c.mode === "create" ? "create" : "update";
  return `Global config: ${verb} ${c.path}\n${c.lines.map((l) => `  - ${l}`).join("\n")}\n\n`;
}

/** The `dispatch setup` flow; `install` runs it too when the global config is missing. */
export async function runSetup(
  io: SetupIo,
  deps: SetupCommandDeps,
  opts: SetupOptions,
): Promise<void> {
  const { home, dispatchHome: dHome } = requireHome(deps.env);
  const interactive = deps.interactive && !opts.nonInteractive;
  const change = await planGlobalConfig(io, deps, opts, interactive);
  const plan = await planSetup({
    home,
    dispatchHome: dHome,
    install: deps.install(),
    hosts: deps.hosts(),
  });
  if (change) io.out(renderChange(change));
  io.out(plan.preview);
  if (!opts.yes && !interactive) {
    throw new DispatchError(
      "nothing was changed; re-run with --yes to apply this plan",
      ExitCode.USAGE,
      "setup.needs_confirmation",
    );
  }
  const ok =
    opts.yes === true || /^y(es)?$/i.test((await deps.ask("Apply these changes? [y/N] ")).trim());
  if (!ok) {
    io.out("Nothing was changed.\n");
    return;
  }
  if (change) {
    writeGlobalConfig(change.path, change.text, change.mode);
    io.out(`Wrote ${change.path}\n`);
  }
  const summary = await applySetup(plan, {
    dispatchHome: dHome,
    refresh: opts.refresh === true,
    runner: deps.runner(home),
    confirm: true,
  });
  for (const w of summary.warnings) io.err(`warning: ${w}\n`);
  refreshHookCacheSafely({ cwd: process.cwd(), env: deps.env }, (m) => io.err(`warning: ${m}\n`));
  io.out(
    `Setup done: ${summary.applied.length} applied, ${summary.unchanged.length} unchanged, ${summary.removed.length} removed.\n`,
  );
  if (!opts.refresh && plan.stale.length > 0) {
    io.out(
      `${plan.stale.length} earlier edit(s) are no longer planned; run \`dispatch setup --refresh\` to remove them.\n`,
    );
  }
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

/** Adds the answer flags shared by `setup` and `install` to `cmd`. */
export function addAnswerOptions(cmd: Command): Command {
  return cmd
    .option("--answers <file>", "YAML file with the setup answers (flags win over it)")
    .option("--host <id>", "client you mainly use: claude-code | codex | none")
    .option(
      "--plan <provider=plan>",
      "plan of a provider, e.g. claude=max5x (repeatable; plan `unknown` skips it)",
      collect,
    )
    .option("--autonomy <level>", "ceiling for delegated agents: read-only | worktree | direct")
    .option("--enable-antigravity", "enable the experimental Antigravity provider")
    .option("--accept-agy-terms", "accept the risk and Google's terms for Antigravity");
}

/** Registers `setup` and `uninstall` on `program`. */
export function registerSetupCommands(program: Command, io: SetupIo, deps: SetupCommandDeps): void {
  const setup = program
    .command("setup")
    .description(
      "install the launcher and host integrations and write ~/.dispatch/config.yaml (once)",
    )
    .option("--refresh", "re-render host files and remove edits that are no longer planned")
    .option("-y, --yes", "apply without asking")
    .option(
      "--non-interactive",
      "never prompt: answers come from flags or --answers, defaults otherwise (add --yes to apply)",
    )
    .option("--reconfigure", "change the answers in an existing ~/.dispatch/config.yaml")
    .option("--profile <name>", "starting strategy: balance | preserve | specialize");
  addAnswerOptions(setup);
  setup.action((opts: SetupOptions) => runSetup(io, deps, opts));

  program
    .command("uninstall")
    .description("remove Dispatch from this repo, or with --global from this user account")
    .option("-y, --yes", "repo part: remove without asking")
    .option("--force", "repo part: also remove files edited since install")
    .option("--global", "remove the host integrations, the launcher and ~/.dispatch")
    .addOption(new Option("--keep-home", "with --global: keep ~/.dispatch (config and state)"))
    .action(
      async (opts: { global?: boolean; keepHome?: boolean; yes?: boolean; force?: boolean }) => {
        if (!opts.global) {
          if (!deps.repoUninstall) {
            throw new DispatchError(
              "repo-level uninstall is not available yet; use `dispatch uninstall --global`",
              ExitCode.USAGE,
              "uninstall.repo_unavailable",
            );
          }
          await deps.repoUninstall(io, { yes: opts.yes === true, force: opts.force === true });
          return;
        }
        const { home, dispatchHome: dHome } = requireHome(deps.env);
        const summary = await uninstallGlobal({
          dispatchHome: dHome,
          keepDispatchHome: opts.keepHome === true,
          runner: deps.runner(home),
        });
        for (const w of summary.warnings) io.err(`warning: ${w}\n`);
        // With the home gone there is nothing to cache (and no hook left to read it).
        if (!summary.homeRemoved) {
          refreshHookCacheSafely({ cwd: process.cwd(), env: deps.env }, (m) =>
            io.err(`warning: ${m}\n`),
          );
        }
        io.out(
          `Removed ${summary.reverted.length} Dispatch edit(s)${summary.homeRemoved ? ` and ${dHome}` : ""}.\n`,
        );
      },
    );
}
