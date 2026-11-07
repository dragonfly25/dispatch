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
import pkg from "../../package.json" with { type: "json" };
import { refreshHookCacheSafely } from "../app/hook-cache.js";
import { browserToolsDir, installStatus } from "../browser/index.js";
import { browserInstallOp, npmCliFor, provisionBlocker } from "../browser/install.js";
import { dispatchHome, globalConfigPath, PROFILES_DIR } from "../config/paths.js";
import { type EditOp, ExitCode, type HostIntegration } from "../core/contracts.js";
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
  FORWARD_MCP_GRANT,
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
import { linePrompter, type Prompter } from "../setup/prompter.js";
import { describeAnswers, runWizard } from "../setup/wizard.js";
import { type ClackApi, clackPrompter, loadClack } from "./prompter.js";
import { type ConfigPreview, renderPlanPreview, setupNextSteps } from "./setup-preview.js";
import { createUi, hintRows, nextSteps, outUi } from "./ui.js";

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
  /** True when stdin AND stdout are terminals: the interactive flow then uses clack. */
  tty?: boolean;
  /** Loads `@clack/prompts` (tests inject a fake). */
  clack?: () => Promise<ClackApi>;
  /** Effective user id (setup never installs the browser as root); default `process.getuid()`. */
  uid?: number | undefined;
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
    tty: process.stdin.isTTY === true && process.stdout.isTTY === true,
    uid: process.getuid?.(),
  };
}

function requireHome(env: SetupCommandDeps["env"]): { home: string; dispatchHome: string } {
  const home = env.HOME;
  if (!home) throw new DispatchError("HOME is not set", ExitCode.USAGE, "setup.no_home");
  return { home, dispatchHome: dispatchHome(env) };
}

/**
 * The setup op that installs the isolated browser, or why it cannot be planned (root, no npm next
 * to node). Only called when the config being written (or kept) says `hosts.claude-code.browser`.
 */
function browserTool(
  dispatchHome: string,
  nodePath: string,
  uid: number | undefined,
): { op?: EditOp; blocked?: string } {
  const blocked = provisionBlocker(nodePath, uid);
  const npmCli = blocked === null ? npmCliFor(nodePath) : null;
  if (npmCli === null) {
    return { blocked: `${blocked ?? "npm not found"}; the isolated browser is not installed` };
  }
  return { op: browserInstallOp({ dispatchHome, nodePath, npmCli }) };
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
interface ConfigChange extends ConfigPreview {
  text: string;
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
  prompter: Prompter | null,
): Promise<ConfigChange | null> {
  const path = globalConfigPath(deps.env);
  const existing = readConfigText(path);
  if (existing !== null && !opts.reconfigure) {
    if (hasAnswerFlags(opts)) {
      io.err(
        `warning: ${path} exists, so the answer flags were ignored; add --reconfigure to change it\n`,
      );
    } else {
      const keep = `Keeping ${path} (\`dispatch setup --reconfigure\` changes it).`;
      if (prompter?.rich) prompter.info(keep);
      else io.out(`${keep}\n`);
    }
    return null;
  }
  const preset = presetAnswers(opts, knownProfiles(deps.env));
  const answers = prompter
    ? await runWizard(
        {
          io,
          ask: deps.ask,
          detect: deps.detect ?? createDetector(deps.env),
          env: deps.env,
          prompter,
        },
        preset,
        existing === null ? null : currentAnswers(existing),
      )
    : preset;
  const grants = (forward: boolean | undefined) =>
    forward ? { grants: [`${FORWARD_MCP_GRANT} (hosts.claude-code.forward_mcp: true)`] } : {};
  if (existing === null) {
    const resolved = withDefaults(answers);
    return {
      path,
      text: renderGlobalConfig(resolved),
      mode: "create",
      lines: describeAnswers(resolved),
      ...grants(resolved.forwardMcp),
    };
  }
  assertAgyConsent(answers);
  return {
    path,
    text: updateGlobalConfig(existing, answers, path),
    mode: "update",
    lines: describeAnswers(answers),
    ...grants(answers.forwardMcp),
  };
}

/**
 * The prompter of an interactive setup: clack on a real terminal (stdin and stdout TTYs), the
 * numbered readline prompter otherwise. Null when nobody can answer.
 */
export async function choosePrompter(
  io: SetupIo,
  deps: SetupCommandDeps,
  interactive: boolean,
): Promise<Prompter | null> {
  if (!interactive) return null;
  if (deps.tty) return clackPrompter(await (deps.clack ?? loadClack)());
  return linePrompter(io, deps.ask);
}

/** The `dispatch setup` flow; `install` runs it too when the global config is missing. */
export async function runSetup(
  io: SetupIo,
  deps: SetupCommandDeps,
  opts: SetupOptions,
): Promise<void> {
  const { home, dispatchHome: dHome } = requireHome(deps.env);
  const interactive = deps.interactive && !opts.nonInteractive;
  const prompter = await choosePrompter(io, deps, interactive);
  const rich = prompter?.rich === true;
  const ui = rich ? createUi(true) : outUi(io);
  if (rich) prompter?.intro(ui.bold(`Dispatch setup · v${pkg.version}`));
  const change = await planGlobalConfig(io, deps, opts, prompter);
  const install = deps.install();
  const configText = change?.text ?? readConfigText(globalConfigPath(deps.env));
  const browserOn = configText !== null && currentAnswers(configText).browser === true;
  const browser = browserOn ? browserTool(dHome, install.nodePath, deps.uid) : null;
  if (browser?.blocked) io.err(`warning: ${browser.blocked}\n`);
  const plan = await planSetup({
    home,
    dispatchHome: dHome,
    install,
    hosts: deps.hosts(),
    ...(browser?.op ? { tools: [{ id: "browser", ops: [browser.op] }] } : {}),
  });
  const preview = renderPlanPreview(plan, change, { ui, home });
  if (rich && prompter) {
    prompter.note("Plan", preview.changes.trimEnd());
    if (preview.grants) prompter.note("Trust grants", preview.grants.trimEnd());
  } else io.out(`${preview.changes}${preview.grants ? `\n${preview.grants}` : ""}`);
  if (!opts.yes && !prompter) {
    throw new DispatchError(
      "nothing was changed; re-run with --yes to apply this plan",
      ExitCode.USAGE,
      "setup.needs_confirmation",
    );
  }
  const ok = opts.yes === true || (await prompter?.confirm("Apply these changes?")) === true;
  if (!ok) {
    if (rich) prompter?.outro("Nothing was changed.");
    else io.out("Nothing was changed.\n");
    return;
  }
  const spin = prompter?.spinner();
  spin?.start("Applying the changes");
  if (change) {
    writeGlobalConfig(change.path, change.text, change.mode);
    if (!rich) io.out(`Wrote ${change.path}\n`);
  }
  const summary = await applySetup(plan, {
    dispatchHome: dHome,
    refresh: opts.refresh === true,
    runner: deps.runner(home),
    confirm: true,
  });
  const done = `Setup done: ${summary.applied.length} applied, ${summary.unchanged.length} unchanged, ${summary.removed.length} removed.`;
  spin?.stop(done);
  for (const w of summary.warnings) io.err(`warning: ${w}\n`);
  if (browser?.op) {
    const st = installStatus(browserToolsDir(dHome));
    if (!st.ok) io.err(`warning: the isolated browser is ${st.reason}; it will not be used\n`);
  }
  refreshHookCacheSafely({ cwd: process.cwd(), env: deps.env }, (m) => io.err(`warning: ${m}\n`));
  if (!rich) io.out(`${done}\n`);
  if (!opts.refresh && plan.stale.length > 0) {
    const stale = `${plan.stale.length} earlier edit(s) are no longer planned; run \`dispatch setup --refresh\` to remove them.`;
    if (rich) prompter?.warn(stale);
    else io.out(`${stale}\n`);
  }
  const steps = setupNextSteps(plan.detected);
  if (rich && prompter) {
    prompter.note(
      "Next steps",
      hintRows(ui, steps)
        .map((l) => l.trimStart())
        .join("\n"),
    );
    prompter.outro(ui.green("Dispatch is set up."));
  } else io.out(`\n${nextSteps(ui, steps)}`);
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
    .option("--accept-agy-terms", "accept the risk and Google's terms for Antigravity")
    .option(
      "--forward-mcp",
      "trust grant: forward the MCP servers an agent needs to the external agent that runs it",
    )
    .option("--no-forward-mcp", "do not forward MCP servers (agents that use MCP stay on Claude)")
    .option(
      "--browser",
      "trust grant: install the isolated browser (Playwright MCP + installed Chrome) for delegated agents",
    )
    .option(
      "--no-browser",
      "no isolated browser (agents that use the desktop browser stay on Claude)",
    );
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
        const ui = outUi(io);
        const removed = `Removed ${summary.reverted.length} Dispatch edit(s)${summary.homeRemoved ? ` and ${dHome}` : ""}.`;
        io.out(`${ui.enabled ? `${ui.mark("ok")} ${removed}` : removed}\n`);
      },
    );
}
