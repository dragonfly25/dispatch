/**
 * Per-provider-instance doctor checks. Nothing here spends quota: probes run `--version`,
 * `--help`, `codex features list`, `codex login status`, `agy -p=/usage`, `codex debug models` and
 * `agy models`. A disabled instance is listed and never started.
 */
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUIRED_FLAGS as AGY_REQUIRED_FLAGS } from "../adapters/agy/invocation.js";
import { CLAUDE_REQUIRED_FLAGS } from "../adapters/claude/invocation.js";
import { REQUIRED_DISABLED_FEATURES } from "../adapters/codex/invocation.js";
import { createAdapter } from "../app/adapters.js";
import type { AppContext } from "../app/context.js";
import type { ExecutionInstance } from "../config/load.js";
import type {
  Adapter,
  AdapterCapabilities,
  ProbeResult,
  QuotaSnapshot,
  Spawner,
} from "../core/contracts.js";
import { mcpCapableAdapters } from "../mcp/forward.js";
import { type ResolvedBinary, type ResolveFs, resolveBinary } from "../platform/resolve.js";
import type { ReaderHealth } from "../quota/provider.js";
import { ClaudeUsageReader } from "../quota/readers/claude-usage.js";
import { type DoctorLine, type DoctorStatus, mkLine } from "./types.js";

/** Name of each adapter's executable. */
const BINARY_NAME: Record<string, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
};

/** Flags (and, for codex, features) each adapter's invocation depends on. */
const REQUIRED: Record<string, { flags: readonly string[]; features?: readonly string[] }> = {
  claude: { flags: CLAUDE_REQUIRED_FLAGS },
  codex: {
    flags: [
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--strict-config",
      "-o",
      "-C",
      "-m",
      "-s",
    ],
    features: REQUIRED_DISABLED_FEATURES,
  },
  antigravity: { flags: AGY_REQUIRED_FLAGS },
};

/** Collaborators of the instance checks. */
export interface InstanceCheckDeps {
  spawner: Spawner;
  /** Test seam for binary resolution. */
  resolveFs?: ResolveFs | undefined;
  /** CLI versions with recorded fixtures per adapter id (`assets/fixture-versions.json`); null if unreadable. */
  fixtureVersions: Readonly<Record<string, readonly string[]>> | null;
}

/** What checking one instance produced; `probe` and `adapter` seed the live test. */
export interface InstanceReport {
  instance: ExecutionInstance;
  lines: DoctorLine[];
  adapter: Adapter | null;
  /** Set when the binary was found and probed. */
  probe: ProbeResult | null;
  binary: ResolvedBinary | null;
}

/** Reads `assets/fixture-versions.json`; null when it is missing or malformed. */
export function loadFixtureVersions(assetsDir: string): Record<string, string[]> | null {
  try {
    const v: unknown = JSON.parse(readFileSync(join(assetsDir, "fixture-versions.json"), "utf8"));
    if (v === null || typeof v !== "object") return null;
    const out: Record<string, string[]> = {};
    for (const [k, list] of Object.entries(v)) {
      if (!Array.isArray(list) || !list.every((x) => typeof x === "string")) return null;
      out[k] = list;
    }
    return out;
  } catch {
    return null;
  }
}

type Extra = Parameters<typeof mkLine>[4];
type Add = (status: DoctorStatus, id: string, message: string, extra?: Extra) => void;

const line = (
  inst: ExecutionInstance,
  status: DoctorStatus,
  id: string,
  message: string,
  extra?: Extra,
): DoctorLine => mkLine(status, inst.id, `${inst.id}.${id}`, message, extra);

/** Checks one instance. Never throws. */
export async function checkInstance(
  ctx: AppContext,
  inst: ExecutionInstance,
  deps: InstanceCheckDeps,
): Promise<InstanceReport> {
  const report: InstanceReport = {
    instance: inst,
    lines: [],
    adapter: null,
    probe: null,
    binary: null,
  };
  const add: Add = (...a) => {
    report.lines.push(line(inst, ...a));
  };

  if (!inst.enabled) {
    add(
      "ok",
      "enabled",
      "disabled: nothing was started (enable it in ~/.dispatch/config.yaml to use it)",
    );
    return report;
  }
  const adapter = createAdapter(inst.adapter, inst.pool);
  if (!adapter) {
    add("warn", "adapter", `no built-in adapter "${inst.adapter}"; this instance cannot run tasks`);
    return report;
  }
  report.adapter = adapter;
  const caps = adapter.caps;
  const name = BINARY_NAME[inst.adapter] ?? inst.adapter;

  try {
    report.binary = resolveBinary(name, {
      configured: inst.binary,
      env: ctx.env,
      ...(deps.resolveFs ? { fs: deps.resolveFs } : {}),
    });
  } catch (err) {
    add("fail", "binary", (err as Error).message, {
      fix: `fix providers.${inst.id}.binary in ~/.dispatch/config.yaml`,
    });
    return report;
  }
  const bin = report.binary;
  if (!bin) {
    add("fail", "binary", `${name} was not found on PATH or in the usual install directories`, {
      fix: `install ${name} and put it on PATH, or set providers.${inst.id}.binary in ~/.dispatch/config.yaml`,
    });
    return report;
  }
  add(
    "ok",
    "binary",
    `${bin.path}${bin.realpath === bin.path ? "" : ` -> ${bin.realpath}`} (${bin.source})`,
    {
      data: { path: bin.path, realpath: bin.realpath, source: bin.source },
    },
  );

  let probe: ProbeResult;
  try {
    probe = await adapter.probe(inst, {
      spawner: deps.spawner,
      clock: ctx.clock,
      resolveBinary: async () => bin.path,
    });
  } catch (err) {
    add("fail", "probe", `probing ${name} failed: ${(err as Error).message}`);
    return report;
  }
  report.probe = probe;

  versionLine(add, caps, probe);
  flagsLine(add, inst, probe);
  loginLine(add, inst, probe);
  const models = await modelsLine(ctx, inst, bin.path, deps.spawner);
  if (models) add(...models);
  isolationLine(add, caps);
  poolLines(add, inst, caps);
  fixturesLine(add, caps, probe, deps);
  return report;
}

function versionLine(add: Add, caps: AdapterCapabilities, probe: ProbeResult): void {
  if (probe.version === null) {
    add("warn", "version", "could not read the CLI version", {
      fix: "run the CLI by hand to see why `--version` fails",
    });
  } else if (probe.outsideCliRange) {
    add(
      "warn",
      "version",
      `${probe.version} is outside the tested range ${caps.cliRange}; runs are still allowed but unverified`,
      {
        fix: "update Dispatch, or pin the CLI to a tested version",
        data: { version: probe.version, cliRange: caps.cliRange },
      },
    );
  } else {
    add("ok", "version", `${probe.version} (tested range ${caps.cliRange})`, {
      data: { version: probe.version, cliRange: caps.cliRange },
    });
  }
}

function flagsLine(add: Add, inst: ExecutionInstance, probe: ProbeResult): void {
  const req = REQUIRED[inst.adapter];
  if (!req) return;
  const missingFlags = req.flags.filter((f) => !probe.flags.includes(f));
  const missingFeatures = (req.features ?? []).filter((f) => !probe.features.includes(f));
  if (probe.flags.length === 0) {
    // claude refuses to run without --safe-mode in the list; the others tolerate an unreadable help.
    add(
      inst.adapter === "claude" ? "fail" : "warn",
      "flags",
      "`--help` listed no flags, so the required flags cannot be verified",
      {
        fix: "run the CLI by hand with --help; update it if it changed",
      },
    );
  } else if (missingFlags.length > 0 || missingFeatures.length > 0) {
    const what = [...missingFlags, ...missingFeatures.map((f) => `feature ${f}`)].join(", ");
    add(
      "fail",
      "flags",
      `the installed CLI lacks ${what}; Dispatch refuses to run it (isolation cannot be enforced)`,
      {
        fix: "update the CLI to a version Dispatch supports",
      },
    );
  } else {
    add(
      "ok",
      "flags",
      `all ${req.flags.length} required flags${req.features ? " and isolation features" : ""} are present`,
    );
  }
}

function loginLine(add: Add, inst: ExecutionInstance, probe: ProbeResult): void {
  if (inst.adapter === "claude") {
    add(
      "warn",
      "login",
      "login state is unknown: Claude Code has no quota-free login check, so verify with `claude` interactively",
      {
        fix: "run `claude` once interactively (a passing `doctor --live` also proves the login)",
      },
    );
  } else if (probe.loggedIn === true) {
    add("ok", "login", "logged in");
  } else if (probe.loggedIn === false) {
    add("fail", "login", "not logged in", {
      fix: inst.adapter === "codex" ? "codex login" : "run `agy` interactively and sign in",
    });
  } else {
    add("warn", "login", "could not determine the login state", {
      fix: "run the CLI by hand to check",
    });
  }
}

const SPAWN_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"];

/** Runs a quota-free listing command and returns its stdout lines, or null on any failure. */
async function listing(
  ctx: AppContext,
  inst: ExecutionInstance,
  binary: string,
  argv: string[],
  spawner: Spawner,
): Promise<string[] | null> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const k of SPAWN_ENV_KEYS) {
    const v = ctx.env[k];
    if (v !== undefined) env[k] = v;
  }
  if (inst.configDir && inst.adapter === "codex") env.CODEX_HOME = inst.configDir;
  const lines: string[] = [];
  try {
    const res = await spawner.spawn({
      binary,
      argv,
      env,
      cwd: tmpdir(),
      stdin: "",
      timeoutMs: 20_000,
      onLine: (stream, l) => {
        if (stream === "stdout") lines.push(l);
      },
    });
    return res.exitCode === 0 && !res.timedOut ? lines : null;
  } catch {
    return null;
  }
}

/** codex/agy only: every model of the tier table is offered by the installed CLI. */
async function modelsLine(
  ctx: AppContext,
  inst: ExecutionInstance,
  binary: string,
  spawner: Spawner,
): Promise<Parameters<Add> | null> {
  if (inst.adapter !== "codex" && inst.adapter !== "antigravity") return null;
  const argv = inst.adapter === "codex" ? ["debug", "models"] : ["models"];
  const out = await listing(ctx, inst, binary, argv, spawner);
  let offered: string[] | null = null;
  if (out) {
    if (inst.adapter === "antigravity") {
      offered = out.map((l) => l.trim().split(/\s+/)[0] ?? "").filter(Boolean);
    } else {
      try {
        const j = JSON.parse(out.join("\n")) as { models?: { slug?: unknown }[] };
        offered = (j.models ?? []).flatMap((m) => (typeof m.slug === "string" ? [m.slug] : []));
      } catch {
        offered = null;
      }
    }
  }
  if (offered === null) {
    return [
      "warn",
      "models",
      `could not list the models of the installed CLI (\`${argv.join(" ")}\`)`,
      {},
    ];
  }
  const tiers = ctx.config.routing.models[inst.adapter]?.tiers ?? {};
  const missing = Object.entries(tiers).filter(([, t]) => !offered.includes(t.model));
  if (missing.length > 0) {
    return [
      "warn",
      "models",
      `tier model(s) not offered by the installed CLI: ${missing.map(([tier, t]) => `${tier}=${t.model}`).join(", ")}`,
      { fix: `edit the ${inst.adapter} model table in your mappings (see \`${argv.join(" ")}\`)` },
    ];
  }
  return [
    "ok",
    "models",
    `all ${Object.keys(tiers).length} tier models are offered (${offered.length} listed)`,
    {},
  ];
}

function isolationLine(add: Add, caps: AdapterCapabilities): void {
  const iso = caps.isolation;
  const open = [
    iso.userHooks === "not_disableable" ? "user hooks" : null,
    iso.userPlugins === "not_disableable" ? "user plugins" : null,
    iso.userMcp === "not_disableable" ? "user MCP servers" : null,
    iso.projectConfig === "not_disableable" ? "project config (.agents/)" : null,
  ].filter((x): x is string => x !== null);
  if (open.length > 0) {
    add(
      "warn",
      "isolation",
      `${open.join(", ")} cannot be disabled in the child; DISPATCH_DEPTH keeps Dispatch's own hooks inert and the patch filter rejects .agents/. Enforcement is ${caps.sandbox === "os" ? "OS-level" : "permission-based only"}.`,
    );
  } else {
    const plugins = iso.userPlugins === "builtin_only" ? " (built-in plugins only)" : "";
    const mcp = mcpCapableAdapters().includes(caps.id)
      ? "MCP servers (only the MCP servers the agent needs, when forwarding is on)"
      : "MCP servers (forwarded MCP servers are not supported)";
    add(
      "ok",
      "isolation",
      `user hooks, plugins${plugins}, ${mcp} and project config are disabled in the child; sandbox: ${caps.sandbox}`,
    );
  }
}

function poolLines(add: Add, inst: ExecutionInstance, caps: AdapterCapabilities): void {
  const pool = `pool: ${inst.pool}${inst.plan ? `, plan ${inst.plan}` : ""}`;
  if (inst.adapter === "antigravity" && inst.pool !== "api_credit") {
    add(
      "warn",
      "pool",
      `${pool}. Terms: Google's FAQ says wrapping agy in third-party apps is not supported under consumer plans and can lead to account suspension. Experimental, read-only, opt-in (tos_acknowledged).`,
      {
        fix: "use an API-credit login, or accept the risk knowingly",
      },
    );
  } else if (inst.adapter === "claude") {
    add(
      "ok",
      "pool",
      `${pool}. Note: Dispatch drives \`claude -p\` non-interactively with your login; Anthropic's rules for automated use of subscription plans apply (see the README billing disclosure).`,
    );
  } else {
    add("ok", "pool", `${pool}${caps.experimental ? " (experimental adapter)" : ""}`);
  }
}

function fixturesLine(
  add: Add,
  caps: AdapterCapabilities,
  probe: ProbeResult,
  deps: InstanceCheckDeps,
): void {
  if (probe.version === null) return;
  const covered = deps.fixtureVersions?.[caps.id];
  if (!covered) {
    add("warn", "fixtures", "the list of versions with recorded fixtures is unavailable");
  } else if (covered.includes(probe.version)) {
    add("ok", "fixtures", `parsers are verified against recorded ${probe.version} output`);
  } else {
    add(
      "warn",
      "fixtures",
      `no recorded fixtures for ${probe.version} (verified: ${covered.join(", ")}); output formats may have drifted`,
      {
        fix: "run the live smoke test (`dispatch doctor --live`) and report the version",
      },
    );
  }
}

const pct = (v: number | null) => (v === null ? "?" : `${Math.round(v)}%`);

/**
 * `<id>.quota`: reader health from a fresh read (UC11). A broken channel is a failure of that
 * channel only; routing continues on estimates.
 */
export function quotaLine(
  ctx: AppContext,
  inst: ExecutionInstance,
  snapshot: QuotaSnapshot | null,
  health: readonly ReaderHealth[],
): DoctorLine {
  const readers = ctx.readers.forAdapter(inst.adapter);
  if (readers.length === 0) {
    return line(inst, "ok", "quota", "no quota reader for this adapter; routing uses estimates");
  }
  if (ctx.config.execution.quota.readers[inst.id]?.enabled === false) {
    return line(inst, "ok", "quota", "quota reader disabled in the config; routing uses estimates");
  }
  const failed = health.filter((h) => !h.ok);
  if (failed.length > 0) {
    const why = failed
      .map((h) => `${h.readerId}${h.channel ? ` [${h.channel}]` : ""}: ${h.error}`)
      .join("; ");
    return line(
      inst,
      "fail",
      "quota",
      `quota channel is broken (${why}). Routing continues on estimates and \`status\` shows this instance as stale.`,
      {
        fix: `update Dispatch if the provider changed its format; set quota.readers.${inst.id}.enabled: false to silence it`,
        data: { health: failed },
      },
    );
  }
  const windows = snapshot?.instances[inst.id]?.windows ?? [];
  const ran = new Set(health.map((h) => h.readerId));
  const names = readers
    .filter((r) => ran.size === 0 || ran.has(r.id))
    .map((r) =>
      r instanceof ClaudeUsageReader
        ? `${r.id} (LLM fallback ${r.llmFallback ? "on" : "off"}${r.zoneAssumed ? ", resets read in the local zone" : ""})`
        : r.id,
    );
  const summary = windows
    .filter((w) => w.usedPct !== null)
    .map((w) => `${w.kind} ${pct(w.usedPct)} used (${w.reliability})`)
    .join(", ");
  return line(
    inst,
    "ok",
    "quota",
    `${names.join(", ")} healthy${summary ? `: ${summary}` : " (no readings yet)"}`,
  );
}
