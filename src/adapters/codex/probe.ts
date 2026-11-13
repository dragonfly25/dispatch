import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import type { AdapterDeps, ProbeResult, ProviderInstance } from "../../core/contracts.js";
import type { OsPlatform } from "../../platform/os.js";
import { probeEnv } from "../platform.js";

/** Variables passed to probe commands (nothing else is inherited; Windows adds its base set). */
const PROBE_ENV_KEYS = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "TMPDIR", "SHELL"];
const PROBE_TIMEOUT_MS = 15_000;

interface Captured {
  exitCode: number | null;
  stdout: string;
}

/** Parses `codex-cli 0.167.0` (or any text holding a semver). */
export function parseCodexVersion(text: string): string | null {
  return /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text)?.[1] ?? null;
}

/** Long and short flags mentioned in `--help` output, deduplicated, in order of appearance. */
export function parseHelpFlags(text: string): string[] {
  const flags = new Set<string>();
  for (const m of text.matchAll(/(?:^|[\s,[(])(--[a-z][a-z0-9-]*|-[A-Za-z])(?=[\s,=<\])]|$)/gm)) {
    if (m[1]) flags.add(m[1]);
  }
  return [...flags];
}

/** First column of `codex features list` (`<name>  <stage>  <enabled>`). */
export function parseFeatureList(text: string): string[] {
  const names = new Set<string>();
  for (const line of text.split("\n")) {
    const first = line.trim().split(/\s+/)[0] ?? "";
    if (/^[a-z][a-z0-9_]*$/.test(first)) names.add(first);
  }
  return [...names];
}

/** True when `version` is inside `>=0.167.0 <0.168` (prereleases of 0.167.x count as outside). */
export function codexVersionInRange(version: string): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!m) return false;
  return Number(m[1]) === 0 && Number(m[2]) === 167 && m[4] === undefined;
}

/**
 * Probes an installed codex through the injected spawner: `--version`, `exec --help` (flags),
 * `features list` (feature names; buildInvocation fails closed on missing isolation features)
 * and `login status` (exit 0 = logged in, 1 = logged out). `CODEX_HOME` follows the instance.
 * On Windows the env lookup is case-insensitive and adds the Windows base variables.
 */
export async function probeCodex(
  instance: ProviderInstance,
  deps: AdapterDeps,
  baseEnv: Readonly<Record<string, string | undefined>> = process.env,
  platform: OsPlatform = process.platform,
): Promise<ProbeResult> {
  const binaryPath = await deps.resolveBinary("codex", instance);
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
  let realpath: string | null;
  try {
    realpath = realpathSync(binaryPath);
  } catch {
    realpath = null;
  }

  const env = probeEnv(baseEnv, PROBE_ENV_KEYS, platform);
  if (instance.configDir) env.CODEX_HOME = instance.configDir;

  const run = async (argv: string[]): Promise<Captured | null> => {
    const lines: string[] = [];
    try {
      const res = await deps.spawner.spawn({
        binary: binaryPath,
        argv,
        env,
        cwd: tmpdir(),
        stdin: "",
        timeoutMs: PROBE_TIMEOUT_MS,
        onLine: (stream, line) => {
          if (stream === "stdout") lines.push(line);
        },
      });
      if (res.timedOut) return null;
      return { exitCode: res.exitCode, stdout: lines.join("\n") };
    } catch {
      return null;
    }
  };

  const versionOut = await run(["--version"]);
  const version = versionOut?.exitCode === 0 ? parseCodexVersion(versionOut.stdout) : null;
  const help = await run(["exec", "--help"]);
  const flags = help?.exitCode === 0 ? parseHelpFlags(help.stdout) : [];
  const featuresOut = await run(["features", "list"]);
  const features = featuresOut?.exitCode === 0 ? parseFeatureList(featuresOut.stdout) : [];
  const login = await run(["login", "status"]);
  const loggedIn = login?.exitCode === 0 ? true : login?.exitCode === 1 ? false : null;

  return {
    binaryPath,
    realpath,
    version,
    flags,
    features,
    loggedIn,
    outsideCliRange: version !== null && !codexVersionInRange(version),
  };
}
