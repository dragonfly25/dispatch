import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { AdapterDeps, ProbeResult, ProviderInstance } from "../../core/contracts.js";

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
      cwd: dirname(binary),
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
  const env: Record<string, string> = { PATH: `${dirname(binaryPath)}:/usr/bin:/bin` };
  if (instance.configDir) env.CLAUDE_CONFIG_DIR = instance.configDir;
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
