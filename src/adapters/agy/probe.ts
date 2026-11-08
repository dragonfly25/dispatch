import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type {
  AdapterCapabilities,
  AdapterDeps,
  ProbeResult,
  ProviderInstance,
} from "../../core/contracts.js";
import { satisfiesRange } from "./version.js";

const PASS_ENV = ["PATH", "HOME", "USER", "LANG", "TMPDIR", "SHELL"];
const AUTH_ERROR = /not logged in|log ?in|authenticat|unauthori[sz]ed|credential|sign ?in/i;

/** Allow-listed env for probe commands (no `ANTIGRAVITY_*`, no secrets); `TERM=dumb`. */
function probeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = { TERM: "dumb" };
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined && (PASS_ENV.includes(k) || k.startsWith("LC_"))) env[k] = v;
  }
  return env;
}

/** Lines captured from one probe command. */
export interface Captured {
  lines: string[];
  stderr: string[];
  exitCode: number | null;
}

async function capture(
  deps: AdapterDeps,
  binary: string,
  argv: string[],
  timeoutMs: number,
): Promise<Captured> {
  const lines: string[] = [];
  const stderr: string[] = [];
  try {
    const r = await deps.spawner.spawn({
      binary,
      argv,
      env: probeEnv(process.env),
      cwd: tmpdir(),
      timeoutMs,
      onLine: (stream, line) => (stream === "stdout" ? lines : stderr).push(line),
    });
    return { lines, stderr, exitCode: r.exitCode };
  } catch {
    return { lines, stderr, exitCode: null };
  }
}

/** Parses the text of `agy --version` ("1.5.2"); null when no version is present. */
export function parseAgyVersion(lines: readonly string[]): string | null {
  for (const line of lines) {
    const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

/** Collects the distinct `--long-flag` tokens of `agy --help`. */
export function parseAgyFlags(lines: readonly string[]): string[] {
  const flags = new Set<string>();
  for (const line of lines) {
    for (const m of line.matchAll(/(?<![\w-])(--[a-z][a-z0-9-]*)/g)) if (m[1]) flags.add(m[1]);
  }
  return [...flags].sort();
}

/**
 * Login state from the quota-free `agy -p=/usage --output-format json`: `status: SUCCESS` means
 * logged in, an auth-looking `AGY_ERROR` means logged out, anything else is unknown (null).
 */
export function parseAgyLogin(c: Captured): boolean | null {
  for (const line of [...c.lines].reverse()) {
    try {
      const j: unknown = JSON.parse(line);
      if (typeof j === "object" && j !== null && (j as { status?: unknown }).status === "SUCCESS") {
        return true;
      }
    } catch {
      // not the JSON line
    }
  }
  const errors = c.stderr.filter((l) => l.includes("AGY_ERROR"));
  if (errors.some((l) => AUTH_ERROR.test(l))) return false;
  return null;
}

/**
 * Probes the installed `agy`: path, realpath, `--version`, `--help` flags and login state
 * (via the quota-free `/usage` command). agy auto-updates, so a version outside `caps.cliRange`
 * is reported through `outsideCliRange` (also when the version cannot be read).
 */
export async function probeAgy(
  instance: ProviderInstance,
  deps: AdapterDeps,
  caps: AdapterCapabilities,
): Promise<ProbeResult> {
  const binaryPath = await deps.resolveBinary("agy", instance);
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
  let realpath = binaryPath;
  try {
    realpath = realpathSync(binaryPath);
  } catch {
    // keep the unresolved path
  }
  const version = parseAgyVersion((await capture(deps, binaryPath, ["--version"], 15_000)).lines);
  // agy 1.5.3 prints its whole `--help` on stderr, so flags are read from both streams.
  const help = await capture(deps, binaryPath, ["--help"], 15_000);
  const flags = parseAgyFlags([...help.lines, ...help.stderr]);
  const usage = await capture(deps, binaryPath, ["-p=/usage", "--output-format", "json"], 30_000);
  return {
    binaryPath,
    realpath,
    version,
    flags,
    features: [],
    loggedIn: parseAgyLogin(usage),
    outsideCliRange: version === null || !satisfiesRange(version, caps.cliRange),
  };
}
