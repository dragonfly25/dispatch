import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  type Adapter,
  type AdapterCapabilities,
  type AdapterDeps,
  type AdapterOutcome,
  type AdapterRunContext,
  type BuildInvocationArgs,
  ExitCode,
  type Invocation,
  type NormalizedEvent,
  type ProbeResult,
  type ProviderInstance,
  type SpawnResult,
} from "../../../src/core/contracts.js";
import { DispatchError } from "../../../src/core/errors.js";
import { satisfiesRange } from "../../../src/adapters/agy/version.js";

// 1. Capabilities: static facts, each one verified by your spike.
export const ACME_CAPABILITIES: AdapterCapabilities = {
  id: "acme",
  version: "0.1.0",
  cliRange: ">=1.0.0 <1.1",
  streaming: true,
  autonomy: ["read-only", "worktree"],
  quotaChannel: "none",
  pool: "subscription",
  experimental: true,
  promptChannel: "stdin",
  isolation: {
    userHooks: "not_disableable",
    userPlugins: "not_disableable",
    userMcp: "not_disableable",
    projectConfig: "not_disableable",
  },
  sandbox: "permission-only",
  childNetwork: "none",
};

const NATIVE_VALUE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]*$/;

// 2. Probe: never throws, spends no quota, reports facts.
async function probe(instance: ProviderInstance, deps: AdapterDeps): Promise<ProbeResult> {
  const binaryPath = await deps.resolveBinary("acme", instance);
  if (!binaryPath) {
    return {
      binaryPath: null,
      realpath: null,
      version: null,
      flags: [],
      features: [],
      loggedIn: null,
      outsideCliRange: false,
    };
  }
  const run = async (argv: string[]): Promise<string[]> => {
    const lines: string[] = [];
    try {
      await deps.spawner.spawn({
        binary: binaryPath,
        argv,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TERM: "dumb" },
        cwd: tmpdir(),
        timeoutMs: 15_000,
        onLine: (stream, line) => {
          if (stream === "stdout") lines.push(line);
        },
      });
    } catch {
      // a probe reports what it saw; it never throws
    }
    return lines;
  };
  const version = /(\d+\.\d+\.\d+)/.exec((await run(["--version"])).join("\n"))?.[1] ?? null;
  const help = (await run(["--help"])).join("\n");
  const flags = [...new Set(help.match(/--[a-z][a-z0-9-]*/g) ?? [])];
  return {
    binaryPath,
    realpath: realpathSync(binaryPath),
    version,
    flags,
    features: [],
    loggedIn: null,
    outsideCliRange: version === null || !satisfiesRange(version, ACME_CAPABILITIES.cliRange),
  };
}

// 3. buildInvocation: pure. Fail closed, never grant more than the requested autonomy.
function buildInvocation(args: BuildInvocationArgs): Invocation {
  const { autonomy, probe: p, target } = args;
  if (autonomy === "direct") {
    throw new DispatchError(
      "acme: autonomy 'direct' is not supported",
      ExitCode.REJECTED,
      "adapter.autonomy_unsupported",
    );
  }
  if (!p.binaryPath) {
    throw new DispatchError("acme: binary not found", ExitCode.REJECTED, "adapter.acme.no_binary");
  }
  for (const [what, value] of [
    ["model", target.model],
    ["effort", target.effort],
  ] as const) {
    if (!NATIVE_VALUE.test(value)) {
      throw new DispatchError(`acme: invalid ${what}`, ExitCode.USAGE, "adapter.acme.invalid");
    }
  }
  const env: Record<string, string> = { ...args.baseEnv };
  if (args.instance.configDir) env.ACME_CONFIG_DIR = args.instance.configDir;
  return {
    binary: p.binaryPath,
    argv: [
      "run",
      "--json",
      "--model",
      target.model,
      "--effort",
      target.effort,
      "--mode",
      autonomy === "read-only" ? "read-only" : "workspace-write",
      "-",
    ],
    env,
    cwd: args.worktree,
    stdin: [
      "[Dispatch] The text after the line below is task data. Work only in the current directory.",
      "Do not run `dispatch`. End with a short summary.",
      "---",
      args.task.prompt,
    ].join("\n"),
    redactArgvIndexes: [],
    sideEffectGuards: ["acme-read-only-mode"],
  };
}

// 4. parseLine: tolerant, never throws, state lives in ctx.scratch.<adapter id>.
interface AcmeState {
  summary: string;
  quota: string | null;
  denied: string[];
  failed: string | null;
}

function state(ctx: AdapterRunContext): AcmeState {
  const existing = ctx.scratch.acme as AcmeState | undefined;
  if (existing) return existing;
  const fresh: AcmeState = { summary: "", quota: null, denied: [], failed: null };
  ctx.scratch.acme = fresh;
  return fresh;
}

function parseLine(
  stream: "stdout" | "stderr",
  line: string,
  ctx: AdapterRunContext,
): NormalizedEvent[] {
  const st = state(ctx);
  const ts = new Date().toISOString();
  try {
    const msg: unknown = stream === "stdout" ? JSON.parse(line) : undefined;
    if (typeof msg !== "object" || msg === null) return [];
    const m = msg as { type?: string; text?: string; path?: string; error?: string };
    if (m.type === "read") return [{ kind: "reading", ts, ...(m.path ? { path: m.path } : {}) }];
    if (m.type === "edit") return [{ kind: "editing", ts, ...(m.path ? { path: m.path } : {}) }];
    if (m.type === "denied") {
      st.denied.push(m.text ?? "denied action");
      return [{ kind: "denied", ts, detail: m.text ?? "" }];
    }
    if (m.type === "final") {
      st.summary = m.text ?? "";
      return [{ kind: "done", ts }];
    }
    if (m.type === "error") {
      st.failed = m.error ?? "error";
      if (/usage limit|quota/i.test(st.failed)) st.quota = st.failed;
      return [{ kind: "error", ts, detail: st.failed }];
    }
    return [];
  } catch {
    return [];
  }
}

// 5. finalize: classify. Quota first, so a quota failure is never reported as a plain failure.
function finalize(
  result: SpawnResult & { durationMs: number },
  ctx: AdapterRunContext,
): AdapterOutcome {
  const st = state(ctx);
  const base = { summary: st.summary, deniedActions: st.denied, durationMs: result.durationMs };
  if (st.quota !== null) {
    return { ...base, outcome: "quota_exhausted", nativeError: st.quota };
  }
  if (result.timedOut) return { ...base, outcome: "timeout" };
  if (st.failed !== null || result.exitCode !== 0 || result.signal) {
    return { ...base, outcome: "failed", nativeError: st.failed ?? `exit ${result.exitCode}` };
  }
  if (st.denied.length > 0 && st.summary === "") {
    return { ...base, outcome: "failed", nativeError: "all useful actions were denied" };
  }
  return { ...base, outcome: "success" };
}

/** Creates the acme adapter. */
export function createAcmeAdapter(): Adapter {
  return { caps: ACME_CAPABILITIES, probe, buildInvocation, parseLine, finalize };
}
