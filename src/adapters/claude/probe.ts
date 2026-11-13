import { realpathSync } from "node:fs";
import path from "node:path";
import type { AdapterDeps, ProbeResult, ProviderInstance } from "../../core/contracts.js";
import { envGet, isWindows, type OsPlatform } from "../../platform/os.js";
import { probeEnv } from "../platform.js";

const PROBE_TIMEOUT_MS = 15_000;
const FLAG = /(?:^|[\s,[(])(--[A-Za-z][A-Za-z0-9-]*)/g;

/** Parses `2.1.301 (Claude Code)` (or any text holding a semver) into `2.1.301`. */
export function parseClaudeVersion(text: string): string | null {
  return /\b(\d+\.\d+\.\d+)\b/.exec(text)?.[1] ?? null;
}

/** Long flags (`--safe-mode`, `--disallowedTools`, ...) mentioned in `--help` output, sorted. */
export function parseHelpFlags(text: string): string[] {
  const flags = new Set<string>();
  for (const m of text.matchAll(FLAG)) if (m[1]) flags.add(m[1]);
  return [...flags].sort();
}

function cmp(a: number[], b: number[]): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Minimal semver range check for space-separated comparator sets such as `>=2.1.301 <2.2`
 * (operators `>=`, `>`, `<=`, `<`, `=`; missing parts count as 0). Unparseable input → false.
 */
export function satisfiesRange(version: string, range: string): boolean {
  const v = /^(\d+)\.(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number);
  if (!v) return false;
  const parts = range.trim().split(/\s+/);
  return parts.every((part) => {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(part);
    if (!m) return false;
    const c = cmp(v, (m[2] ?? "").split(".").map(Number));
    switch (m[1]) {
      case ">=":
        return c >= 0;
      case ">":
        return c > 0;
      case "<=":
        return c <= 0;
      case "<":
        return c < 0;
      default:
        return c === 0;
    }
  });
}

/**
 * Environment of the probe commands: `PATH` is the binary's directory plus the system dirs
 * (POSIX `/usr/bin:/bin`; Windows `%SystemRoot%\\System32` and `%SystemRoot%`, plus the Windows
 * base variables a process needs to start). Nothing else is inherited.
 */
export function claudeProbeEnv(
  binaryPath: string,
  configDir: string | undefined,
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: OsPlatform = process.platform,
): Record<string, string> {
  let env: Record<string, string>;
  if (isWindows(platform)) {
    const root = envGet(source, "SYSTEMROOT", platform) ?? "C:\\Windows";
    env = probeEnv(source, [], platform);
    env.PATH = [path.win32.dirname(binaryPath), path.win32.join(root, "System32"), root].join(";");
  } else {
    env = { PATH: `${path.posix.dirname(binaryPath)}:/usr/bin:/bin` };
  }
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

async function capture(
  deps: AdapterDeps,
  binary: string,
  argv: string[],
  env: Record<string, string>,
): Promise<string | null> {
  const lines: string[] = [];
  try {
    const res = await deps.spawner.spawn({
      binary,
      argv,
      env,
      cwd: path.dirname(binary),
      stdin: "",
      timeoutMs: PROBE_TIMEOUT_MS,
      onLine: (stream, line) => {
        if (stream === "stdout") lines.push(line);
      },
    });
    return res.exitCode === 0 ? lines.join("\n") : null;
  } catch {
    return null;
  }
}

/**
 * Probes an installed claude without spending quota: `--version` and `--help` only. `loggedIn` is
 * always null (there is no quota-free login check; `doctor` uses other signals). A `--help` that
 * lacks `--safe-mode` leaves it out of `flags`, which makes `buildInvocation` refuse to run.
 */
export async function probeClaude(
  instance: ProviderInstance,
  deps: AdapterDeps,
  cliRange: string,
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: OsPlatform = process.platform,
): Promise<ProbeResult> {
  const binaryPath = await deps.resolveBinary("claude", instance);
  const empty: ProbeResult = {
    binaryPath,
    realpath: null,
    version: null,
    flags: [],
    features: [],
    loggedIn: null,
    outsideCliRange: false,
  };
  if (!binaryPath) return empty;
  let realpath: string | null;
  try {
    realpath = realpathSync(binaryPath);
  } catch {
    realpath = null;
  }
  const env = claudeProbeEnv(binaryPath, instance.configDir, source, platform);
  const versionText = await capture(deps, binaryPath, ["--version"], env);
  const helpText = await capture(deps, binaryPath, ["--help"], env);
  const version = versionText ? parseClaudeVersion(versionText) : null;
  return {
    ...empty,
    realpath,
    version,
    flags: helpText ? parseHelpFlags(helpText) : [],
    outsideCliRange: version === null || !satisfiesRange(version, cliRange),
  };
}
