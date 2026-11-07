import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { assertNoRealCli, FAKE_CLI_JS, FAKE_CLIS, FAKES_BIN, type FakeCli } from "./guard.js";

export { FAKE_CLIS, type FakeCli } from "./guard.js";

/** Strings that `leak_secret` prints; redaction tests assert none of them survive. */
export const FAKE_LEAKS = {
  anthropic: "sk-ant-api03-FAKE0123456789abcdefghijklmnopqrstuvwxyz",
  github: "ghp_FAKE0123456789abcdefghijklmnopqrstuv",
  bearer: "Authorization: Bearer FAKEtoken0123456789abcdefghijklmnop",
} as const;

// ---------------------------------------------------------------- scenario types

/** Common optional overrides: `exitCode` replaces the scenario's natural exit code. */
interface Base {
  exitCode?: number;
  /** Fixture used instead of the CLI's default success fixture (e.g. "codex/0.167.0/edit_workspace_write"). */
  fixture?: string;
  /** How long the fake waits for stdin EOF before proceeding (default 1000). */
  stdinTimeoutMs?: number;
}

/** A run scenario (the `claude`/`codex`/`agy` array entries; picked by call index, last repeats). */
export type FakeScenario =
  | (Base & { scenario: "replay"; fixture: string; delayMs?: number })
  | (Base & {
      scenario: "success_edit";
      file?: string;
      content?: string;
      files?: Record<string, string>;
    })
  | (Base & { scenario: "slow"; delayMs?: number; events?: unknown[] })
  | (Base & { scenario: "quota_exhausted"; version?: string })
  | (Base & { scenario: "malformed" })
  | (Base & { scenario: "crash"; lines?: number; signal?: string })
  | (Base & {
      scenario: "hang_ignore_term";
      maxLifetimeMs?: number;
      grandchildDetached?: boolean;
      grandchildHoldsStdout?: boolean;
    })
  | (Base & { scenario: "recurse"; command?: string; timeoutMs?: number })
  | (Base & { scenario: "escape_writes"; pinnedPath?: string })
  | (Base & { scenario: "symlink"; links?: Record<string, string> })
  | (Base & { scenario: "leak_secret"; secret?: string })
  | (Base & { scenario: "fail"; stdout?: string; stderr?: string });

export type AppServerVariant =
  | "ok"
  | "changed_format"
  | "always_zero"
  | "garbage"
  | "hang"
  | "rpc_error";

/** Config of a non-scenario subcommand: stdout/stderr/exitCode override the built-in default. */
export interface FakeSubConfig {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  delayMs?: number;
  /** `codex login status`: false -> exit 1. */
  loggedIn?: boolean;
  /** `agy -p=/usage` variants (default "fixture") or the `codex app-server` variants (default "ok"). */
  variant?: "fixture" | "changed_format" | "unauthenticated" | AppServerVariant;
  /** `agy /usage` (fixture variant): value for every bucket's remaining_fraction. */
  remainingFraction?: number;
  resetTime?: string;
  // codex app-server
  primaryUsed?: number;
  secondaryUsed?: number;
  planType?: string;
  ordinaryUsageAllowed?: boolean;
  rateLimitReachedType?: string | null;
  /** Epoch seconds. */
  primaryResetsAt?: number;
  secondaryResetsAt?: number;
  /** Interleave unsolicited notifications (default true). */
  notifications?: boolean;
  /** Add `jsonrpc: "2.0"` to every outgoing message (default false, like the real server). */
  jsonrpc?: boolean;
  /** hang variant: "initialize" hangs before answering initialize (default: hangs on the read). */
  hangAt?: "initialize";
  errorCode?: number;
  errorMessage?: string;
  maxLifetimeMs?: number;
}

/** Keys of subcommand configs: `<cli>:<sub>`. Each has its own call counter. */
export type FakeSubKey =
  | "claude:version"
  | "claude:plugin"
  | "codex:version"
  | "codex:login"
  | "codex:features"
  | "codex:models"
  | "codex:app-server"
  | "agy:version"
  | "agy:models"
  | "agy:usage";

/** Contents of the FAKE_SCENARIO file. */
export type FakeScenarioMap = { [C in FakeCli]?: FakeScenario[] } & {
  [K in FakeSubKey]?: FakeSubConfig | FakeSubConfig[];
};

// ---------------------------------------------------------------- log types

/** One fake invocation, merged from its start/update/end log records. */
export interface FakeInvocation {
  invocationId: string;
  cli: FakeCli;
  /** "run" for scenario-driven calls, "subcommand" for --version, plugin, app-server, ... */
  kind: "run" | "subcommand";
  /** Subcommand key ("version", "login", "app-server", ...) or null for runs. */
  key: string | null;
  scenario: string | null;
  callIndex: number;
  /** [cli, ...args], like a process argv without the interpreter. */
  argv: string[];
  args: string[];
  cwd: string;
  /** Full environment the fake received, minus FAKE_* variables. */
  env: Record<string, string>;
  pid: number;
  ppid: number;
  pgid: number | null;
  stdin?: string;
  stdinBytes?: number;
  startedAt: string;
  /** Absent while the process is still running or after SIGKILL. */
  endedAt?: string;
  exitCode?: number;
  signalReceived?: string | null;
  grandchildPid?: number;
  sigtermCount?: number;
  recurse?: {
    command: string;
    exitCode: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    error: string | null;
  };
  escape?: { label: string; path: string; ok: boolean; error?: string }[];
  symlink?: { name: string; target: string; ok: boolean; error?: string }[];
  /** codex app-server: every JSON-RPC message the fake received. */
  rpcReceived?: Record<string, unknown>[];
}

// ---------------------------------------------------------------- context

export interface FakesOptions {
  /** Extra env merged into `env` (before PATH is set). */
  env?: Record<string, string>;
  /** Start `env` from process.env instead of the minimal {LANG, TMPDIR}. Default false. */
  inheritEnv?: boolean;
}

export interface FakesContext {
  /** Environment for the code under test: PATH has the fake bin dir first. No HOME is set. */
  readonly env: Record<string, string>;
  /** Per-run directory of symlinks to test/fakes/bin/* plus the `.fake-env` config. */
  readonly binDir: string;
  /** FAKE_STATE_DIR: call counters and the `abs.txt` target of escape_writes. */
  readonly stateDir: string;
  readonly logPath: string;
  readonly scenarioPath: string;
  /** Merged invocation records in start order; optionally filtered. */
  readLog(filter?: { cli?: FakeCli; kind?: "run" | "subcommand"; key?: string }): FakeInvocation[];
  /** Replaces the scenario file; call counters keep counting. */
  setScenarios(scenarios: FakeScenarioMap): void;
  /** Removes the temp directories. Idempotent. */
  dispose(): void;
}

const created = new Set<string>();
process.on("exit", () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

const shq = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Creates fakes for manual lifecycle control (beforeEach/afterEach); prefer `withFakes`.
 * Asserts via `assertNoRealCli` that no real CLI is reachable through the returned env.
 */
export function createFakes(
  scenarios: FakeScenarioMap = {},
  opts: FakesOptions = {},
): FakesContext {
  const root = mkdtempSync(join(tmpdir(), "dispatch-fakes-"));
  created.add(root);
  const binDir = join(root, "bin");
  const stateDir = join(root, "state");
  const logPath = join(root, "fake.log");
  const scenarioPath = join(root, "scenarios.json");
  mkdirSync(binDir);
  mkdirSync(stateDir);
  writeFileSync(logPath, "");
  for (const cli of FAKE_CLIS) symlinkSync(join(FAKES_BIN, cli), join(binDir, cli));
  const exported: Record<string, string> = {
    FAKE_SCENARIO: scenarioPath,
    FAKE_STATE_DIR: stateDir,
    FAKE_LOG: logPath,
    FAKE_NODE: process.execPath,
    FAKE_CLI_JS,
  };
  const envFile = join(binDir, ".fake-env");
  const lines = Object.entries(exported).map(([k, v]) => `${k}=${shq(v)}; export ${k}`);
  writeFileSync(envFile, `${lines.join("\n")}\n`);
  chmodSync(envFile, 0o644);

  const basePath = process.env.PATH ?? "/usr/bin:/bin";
  const base: Record<string, string> = opts.inheritEnv
    ? Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
      )
    : { LANG: "C.UTF-8", ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) };
  const env = { ...base, ...opts.env, PATH: `${binDir}${delimiter}${basePath}` };
  assertNoRealCli(env);

  const ctx: FakesContext = {
    env,
    binDir,
    stateDir,
    logPath,
    scenarioPath,
    readLog(filter = {}) {
      const byId = new Map<string, FakeInvocation>();
      for (const line of readFileSync(logPath, "utf8").split("\n")) {
        if (!line) continue;
        const record = JSON.parse(line) as Record<string, unknown> & { invocationId: string };
        const { phase: _phase, ...rest } = record;
        const prev = byId.get(record.invocationId) ?? ({} as FakeInvocation);
        byId.set(record.invocationId, Object.assign(prev, rest));
      }
      return [...byId.values()].filter(
        (e) =>
          (!filter.cli || e.cli === filter.cli) &&
          (!filter.kind || e.kind === filter.kind) &&
          (!filter.key || e.key === filter.key),
      );
    },
    setScenarios(next) {
      writeFileSync(scenarioPath, JSON.stringify(next, null, 2));
    },
    dispose() {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true });
      created.delete(root);
    },
  };
  ctx.setScenarios(scenarios);
  return ctx;
}

/**
 * Runs `fn` with fake `claude`/`codex`/`agy` first on PATH, then removes the temp state.
 *
 * ```ts
 * await withFakes({ claude: [{ scenario: "quota_exhausted" }] }, async ({ env, readLog }) => {
 *   await runDispatch({ env });
 *   expect(readLog({ cli: "claude" })[0]?.exitCode).toBe(1);
 * });
 * ```
 */
export async function withFakes<T>(
  scenarios: FakeScenarioMap,
  fn: (ctx: FakesContext) => T | Promise<T>,
  opts: FakesOptions = {},
): Promise<T> {
  const ctx = createFakes(scenarios, opts);
  try {
    return await fn(ctx);
  } finally {
    ctx.dispose();
  }
}
