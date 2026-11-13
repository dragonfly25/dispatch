/**
 * Harness of the acceptance suite (WP29): every use case drives the BUILT `dispatch` CLI (and hook
 * entry) as separate `node` processes against fake CLIs, a temp HOME / DISPATCH_HOME and real temp
 * git repos. Lower-level proofs of the same behaviour live next to each module; each `ucNN.test.ts`
 * names them in its header and adds the end-to-end check of the spec's "Verifica".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { type RunResult, RunResultSchema } from "../../src/core/contracts.js";
import { isWindows } from "../../src/platform/os.js";
import { toSpawnCommand } from "../../src/platform/spawnable.js";
import { type Bundles, buildBundles, type NodeRun, runNode } from "../security/harness.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";
import { writeNodeShim } from "../support/shims.js";

export type { NodeRun } from "../security/harness.js";
export { snapshotTree } from "../support/index.js";

/** `<cli> --help` answers with a flag list, so the real flag probes (and `doctor`) pass. */
export const HELP: FakeScenarioMap = {
  "claude:help": {},
  "codex:help": {},
  "agy:help": {},
};

/** The agent's edit most tests expect: `math.js` gets this content. */
export const EDIT_CODEX: FakeScenarioMap = {
  codex: [{ scenario: "success_edit", file: "math.js", content: "changed by codex\n" }],
};

/** Initial content of `math.js` in the fixture repo. */
export const MATH_JS = "function add(a, b) {\n  return a + b;\n}\n";

/** Global config enabling the three providers (antigravity is opt-in and read-only). */
/**
 * Fake `claude -p /usage` answering "not logged in": Claude quota stays unknown, so routing
 * prefers the instances with a known quota (as before the claude-usage reader existed).
 */
export const CLAUDE_QUOTA_UNREAD: FakeScenarioMap = {
  "claude:usage": { variant: "unauthenticated" },
};

export const THREE_PROVIDERS = `providers:
  claude: { plan: max }
  codex: { plan: plus }
  antigravity: { enabled: true, tos_acknowledged: true }
`;

let bundles: Bundles | undefined;

/** Registers the per-file build of the CLI and hook bundles; returns an accessor. */
export function useBundles(): () => Bundles {
  // Each test starts several node processes; the default 5 s is too tight on a busy CI runner.
  vi.setConfig({ testTimeout: 90_000 });
  beforeAll(async () => {
    bundles = await buildBundles();
  }, 120_000);
  afterAll(() => bundles?.cleanup());
  return () => {
    if (!bundles) throw new Error("bundles are not built yet");
    return bundles;
  };
}

export interface WorldOptions {
  scenarios?: FakeScenarioMap;
  /** Body of `~/.dispatch/config.yaml` after `version: 1`; `null` = no global config at all. */
  global?: string | null;
  /** Extra files of the fixture repo (math.js is always there). */
  files?: Record<string, string>;
  /** Extra environment (e.g. CLAUDECODE=1) for every dispatch process. */
  env?: Record<string, string>;
  /** Commit the repo (default true). */
  commit?: boolean;
}

/** Result of {@link World.run}: the process outcome plus the parsed RunResult when stdout has one. */
export type RunOutcome = NodeRun & { result?: RunResult };

export interface World {
  fakes: FakesContext;
  home: TempHome;
  repo: TempRepo;
  /** Environment of every dispatch process: fake CLIs first on PATH, temp HOME. */
  env: Record<string, string>;
  /** Runs `dispatch <args>` in the repo (or `opts.cwd`). */
  dispatch(
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; input?: string },
  ): NodeRun;
  /**
   * Runs any executable (e.g. the installed launcher) with the world's environment. A Windows
   * `.cmd` npm shim is unwrapped to `node <script>` the way Dispatch spawns it (never via cmd.exe).
   */
  exec(
    file: string,
    args: string[],
    opts?: { cwd?: string; env?: Record<string, string>; input?: string },
  ): NodeRun;
  /** `dispatch run --json --task ...`; parses the RunResult. */
  run(args?: string[], opts?: { task?: string; env?: Record<string, string> }): RunOutcome;
  /** Writes `~/.dispatch/config.yaml`. */
  writeGlobal(body: string): void;
  /** Writes a file below `~/.dispatch/` (e.g. `profiles/team.yaml`). */
  writeDispatchFile(rel: string, content: string): void;
  dispose(): void;
}

const worlds: World[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A fake-CLI world with a temp HOME and a temp repo; disposed after each test. */
export function createWorld(o: WorldOptions = {}): World {
  const b = bundles;
  if (!b) throw new Error("call useBundles() in the test file");
  const fakes = createFakes({ ...HELP, ...(o.scenarios ?? {}) });
  const home = tempHome();
  const repo = tempRepo({
    files: { "math.js": MATH_JS, ...(o.files ?? {}) },
    commit: o.commit ?? true,
  });
  const env = { ...fakes.env, ...home.env, ...(o.env ?? {}) };
  const writeGlobal = (body: string): void => {
    mkdirSync(home.dispatchHome, { recursive: true });
    writeFileSync(join(home.dispatchHome, "config.yaml"), `version: 1\n${body}`);
  };
  if (o.global !== null) writeGlobal(o.global ?? "");
  const dispatch: World["dispatch"] = (args, opts = {}) =>
    runNode(b.cli, args, {
      cwd: opts.cwd ?? repo.dir,
      env: { ...env, ...(opts.env ?? {}) },
      ...(opts.input === undefined ? {} : { input: opts.input }),
    });
  const world: World = {
    fakes,
    home,
    repo,
    env,
    dispatch,
    exec(file, args, opts = {}) {
      const cmd = /\.(cmd|bat)$/i.test(file)
        ? toSpawnCommand(file, args)
        : { command: file, args: [...args] };
      const r = spawnSync(cmd.command, cmd.args, {
        cwd: opts.cwd ?? repo.dir,
        env: { ...env, ...(opts.env ?? {}) },
        encoding: "utf8",
        input: opts.input ?? "",
        timeout: 120_000,
      });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    run(args = [], opts = {}) {
      const out = dispatch(
        ["run", "--json", "--task", opts.task ?? "add sub to math.js", ...args],
        opts.env ? { env: opts.env } : {},
      );
      const parsed = RunResultSchema.safeParse(safeJson(out.stdout));
      return { ...out, ...(parsed.success ? { result: parsed.data } : {}) };
    },
    writeGlobal,
    writeDispatchFile(rel, content) {
      const file = join(home.dispatchHome, rel);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    dispose() {
      fakes.dispose();
      home.cleanup();
      repo.cleanup();
    },
  };
  worlds.push(world);
  return world;
}

const SHIM = join(import.meta.dirname, "claude-plugin-shim.mjs");

/**
 * Puts a `claude` in front of the fake that also performs the `claude plugin ...` edits of
 * `<HOME>/.claude` (see claude-plugin-shim.mjs); everything else is still the fake CLI.
 */
export function useClaudePluginShim(world: World): void {
  const dir = join(world.fakes.stateDir, "..", "shim-bin");
  mkdirSync(dir, { recursive: true });
  // On Windows the fake is reached through its `.mjs` entry (a `.cmd` cannot be spawned directly).
  const real = join(world.fakes.binDir, isWindows() ? "claude.mjs" : "claude");
  writeNodeShim(dir, "claude", SHIM, { FAKE_REAL_CLAUDE: real });
  world.env.PATH = `${dir}${delimiter}${world.env.PATH ?? ""}`;
}

/** Parses stdout as JSON (throws with the raw text when it is not). */
export function parseJson<T = unknown>(out: NodeRun): T {
  try {
    return JSON.parse(out.stdout) as T;
  } catch {
    throw new Error(
      `stdout is not JSON (exit ${out.code}):\n${out.stdout}\n--- stderr:\n${out.stderr}`,
    );
  }
}
