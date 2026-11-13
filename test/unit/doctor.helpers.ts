/** Harness for the `doctor` tests: fake CLIs, a temp HOME with a valid launcher, captured output. */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DoctorExtras } from "../../src/cli/commands/shared.js";
import { buildProgram, runCli } from "../../src/cli/program.js";
import type { DoctorLine, DoctorReport } from "../../src/doctor/types.js";
import { HostRegistry } from "../../src/hosts/_framework/registry.js";
import { renderLauncherScript } from "../../src/platform/launcher.js";
import { launcherFileName } from "../../src/platform/os.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  type TempHome,
  tempHome,
} from "../support/index.js";

/** `--help` texts that carry every flag the adapters require. */
export const HELP = {
  claude:
    "Usage: claude [options]\n  -p, --print\n  --safe-mode  Disable user hooks\n  --settings <json>\n",
  codex:
    "Usage: codex exec [options]\n  --json\n  --ephemeral\n  --ignore-user-config\n  --ignore-rules\n  --strict-config\n  -c, --config <k=v>\n  -C, --cd <dir>\n  -m, --model <m>\n  -o, --output-last-message <f>\n  -s, --sandbox <mode>\n",
  agy: "Usage: agy [options]\n  --output-format <f>\n  --sandbox\n  --disable-slash-commands\n  --model <m>\n  --effort <e>\n  --print-timeout <s>\n",
} as const;

/** The scenario that answers `<cli> --help` (a "run" for the fake). */
export const helpScenario = (cli: keyof typeof HELP) => ({
  scenario: "fail" as const,
  stdout: HELP[cli],
  stderr: "",
  exitCode: 0,
});

/** A successful agy reply (`result` event) with `text`. */
export const agyReply = (text: string) => ({
  scenario: "slow" as const,
  delayMs: 10,
  events: [
    {
      event: "result",
      result: {
        conversation_id: "c1",
        status: "SUCCESS",
        response: text,
        num_turns: 1,
        usage: { input_tokens: 1, output_tokens: 1 },
        denied_actions: [],
      },
    },
  ],
});

export interface DoctorHarness {
  fakes: FakesContext;
  home: TempHome;
  env: Record<string, string>;
  /** Runs `dispatch <args>`; `opts.cwd` defaults to the temp HOME. */
  run(
    args: string[],
    opts?: {
      cwd?: string;
      env?: Record<string, string>;
      doctor?: DoctorExtras;
      decorate?: boolean;
    },
  ): Promise<{ code: number; out: string; err: string }>;
  /** Runs `doctor --json ...` and parses the report. */
  report(
    args?: string[],
    opts?: { cwd?: string; env?: Record<string, string>; doctor?: DoctorExtras },
  ): Promise<{ code: number; report: DoctorReport; err: string }>;
  /** Writes `~/.dispatch/config.yaml`. */
  config(yaml: string): void;
  cleanup(): void;
}

/** Looks a line up by id (throws when absent). */
export function lineOf(report: DoctorReport, id: string): DoctorLine {
  const l = report.checks.find((c) => c.id === id);
  if (!l)
    throw new Error(`no doctor line ${id}; have ${report.checks.map((c) => c.id).join(", ")}`);
  return l;
}

/** Creates the harness. Scenarios default to a `--help` answer per CLI plus whatever the test adds. */
export function doctorHarness(
  scenarios: FakeScenarioMap = {},
  opts: { launcher?: boolean } = {},
): DoctorHarness {
  const fakes = createFakes({
    claude: [helpScenario("claude")],
    codex: [helpScenario("codex")],
    agy: [helpScenario("agy")],
    ...scenarios,
  });
  const home = tempHome();
  const env = { ...fakes.env, ...home.env };
  mkdirSync(home.dispatchHome, { recursive: true });
  if (opts.launcher !== false) {
    const cli = join(home.home, "install", "cli.mjs");
    mkdirSync(dirname(cli), { recursive: true });
    writeFileSync(cli, "");
    writeFileSync(join(dirname(cli), "hook.mjs"), "");
    // Windows: `dispatch.cmd`, executable by its extension (chmod changes nothing there).
    const launcher = join(home.dispatchHome, "bin", launcherFileName());
    mkdirSync(dirname(launcher), { recursive: true });
    writeFileSync(launcher, renderLauncherScript({ nodePath: process.execPath, cliPath: cli }));
    if (process.platform !== "win32") chmodSync(launcher, 0o755);
  }
  // A registry without the claude-code checks, so tests see only the lines they care about.
  const registry = new HostRegistry();
  const run: DoctorHarness["run"] = async (args, o = {}) => {
    let out = "";
    let err = "";
    const io = {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        err += t;
      },
      ...(o.decorate ? { decorate: { out: true, err: true } } : {}),
    };
    const allEnv = { ...env, ...o.env };
    const program = buildProgram(
      io,
      {},
      {},
      {
        cwd: o.cwd ?? home.home,
        env: allEnv,
        doctor: { registry, interactive: false, signals: null, ...o.doctor },
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env: allEnv });
    return { code, out, err };
  };
  return {
    fakes,
    home,
    env,
    run,
    async report(args = [], o) {
      const r = await run(["doctor", "--json", ...args], o);
      return { code: r.code, report: JSON.parse(r.out) as DoctorReport, err: r.err };
    },
    config(yaml) {
      writeFileSync(join(home.dispatchHome, "config.yaml"), yaml);
    },
    cleanup() {
      fakes.dispose();
      home.cleanup();
    },
  };
}

/** Global config that enables Antigravity (consumer login with the ToS acknowledged). */
export const ENABLE_AGY =
  "version: 1\nproviders:\n  antigravity: { enabled: true, tos_acknowledged: true }\n";
