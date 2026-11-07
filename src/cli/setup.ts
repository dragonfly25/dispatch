/**
 * `dispatch setup [--refresh] [--yes] [--non-interactive]` and `dispatch uninstall --global
 * [--keep-home]`. Repo-level `install`/`uninstall` belong to WP21: it passes `repoUninstall`.
 */
import { createInterface } from "node:readline/promises";
import { type Command, Option } from "commander";
import { refreshHookCacheSafely } from "../app/hook-cache.js";
import { dispatchHome } from "../config/paths.js";
import { ExitCode, type HostIntegration } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import {
  applySetup,
  type CommandRunner,
  planSetup,
  uninstallGlobal,
} from "../hosts/_framework/index.js";
import { builtinRegistry } from "../hosts/index.js";
import { currentInstallPaths, type InstallPaths } from "../platform/launcher.js";
import { createCommandRunner } from "../runner/command.js";

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
export interface SetupOptions {
  refresh?: boolean;
  yes?: boolean;
  nonInteractive?: boolean;
}

/** The `dispatch setup` flow; `install` runs it too when the global config is missing. */
export async function runSetup(
  io: SetupIo,
  deps: SetupCommandDeps,
  opts: SetupOptions,
): Promise<void> {
  const { home, dispatchHome: dHome } = requireHome(deps.env);
  const plan = await planSetup({
    home,
    dispatchHome: dHome,
    install: deps.install(),
    hosts: deps.hosts(),
  });
  io.out(plan.preview);
  if (!opts.yes && (opts.nonInteractive || !deps.interactive)) {
    throw new DispatchError(
      "nothing was changed; re-run with --yes to apply this plan",
      ExitCode.USAGE,
      "setup.needs_confirmation",
    );
  }
  const summary = await applySetup(plan, {
    dispatchHome: dHome,
    refresh: opts.refresh === true,
    runner: deps.runner(home),
    confirm: opts.yes
      ? true
      : async () => /^y(es)?$/i.test((await deps.ask("Apply these changes? [y/N] ")).trim()),
  });
  if (!summary.confirmed) {
    io.out("Nothing was changed.\n");
    return;
  }
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

/** Registers `setup` and `uninstall` on `program`. */
export function registerSetupCommands(program: Command, io: SetupIo, deps: SetupCommandDeps): void {
  program
    .command("setup")
    .description("install the launcher and the host integrations for this user (once)")
    .option("--refresh", "re-render host files and remove edits that are no longer planned")
    .option("-y, --yes", "apply without asking")
    .option("--non-interactive", "never prompt; without --yes only print the plan")
    .action((opts: SetupOptions) => runSetup(io, deps, opts));

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
