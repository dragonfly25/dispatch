/**
 * Doctor checks for the Codex integration. They only read files: no quota, no host file written,
 * and hook trust (`[hooks.state]` in `config.toml`) is never read or written by Dispatch: the
 * SessionStart heartbeat tells whether the approved hooks fire.
 */
import { accessSync, constants, existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { launcherFileName, type OsPlatform } from "../../platform/os.js";
import { type ResolveFs, resolveBinary } from "../../platform/resolve.js";
import { readTextOrNull, sha256 } from "../_framework/fsutil.js";
import type {
  DoctorCheck,
  DoctorContext,
  DoctorResult,
  ManifestEntry,
} from "../_framework/index.js";
import { readManifest } from "../_framework/index.js";
import { readHeartbeat } from "./hook.js";
import {
  CODEX_WINDOWS_NO_RULES,
  codexHomeDir,
  codexPaths,
  codexRulesSupported,
} from "./integration.js";

/** Injectable dependencies of the checks. */
export interface CodexDoctorDeps {
  fs?: ResolveFs;
  now?: () => Date;
  /** Default `process.platform`. */
  platform?: OsPlatform;
}

const platformOf = (deps: CodexDoctorDeps): OsPlatform => deps.platform ?? process.platform;

/** A heartbeat older than this many days is reported as stale. */
export const HEARTBEAT_MAX_AGE_DAYS = 7;

const SETUP_FIX = "dispatch setup";
const REFRESH_FIX = "dispatch setup --refresh";
const APPROVE_FIX = "open codex, run /hooks, approve the two Dispatch hooks";

const NOT_FOUND: DoctorResult = { status: "ok", message: "Codex not found; nothing to check" };

/** Codex is considered absent when neither its home nor its binary exists. */
function absent(ctx: DoctorContext, deps: CodexDoctorDeps): boolean {
  const platform = platformOf(deps);
  if (existsSync(codexHomeDir(ctx.env, ctx.home, platform))) return false;
  const opts = { env: ctx.env, platform, ...(deps.fs ? { fs: deps.fs } : {}) };
  return resolveBinary("codex", opts) === null;
}

/** The manifest entries setup recorded for the Codex files. */
function codexEntries(ctx: DoctorContext, deps: CodexDoctorDeps): ManifestEntry[] {
  const p = codexPaths(ctx.env, ctx.home, platformOf(deps));
  const files = new Set([p.skill, p.rules, p.hooks]);
  return readManifest(ctx.dispatchHome).entries.filter((e) => files.has(e.file));
}

function containsString(value: unknown, needle: string): boolean {
  if (typeof value === "string") return value === needle;
  if (Array.isArray(value)) return value.some((v) => containsString(v, needle));
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((v) => containsString(v, needle));
  }
  return false;
}

/** Recorded files that are missing or changed since setup (hook entries: no longer present). */
function brokenEntries(entries: readonly ManifestEntry[]): string[] {
  const broken: string[] = [];
  for (const e of entries) {
    const text = readTextOrNull(e.file);
    if (e.kind === "json-entry") {
      const doc: unknown = text === null ? null : parseJsonc(text);
      if (!containsString(doc, e.signature)) broken.push(`${e.file} (hook entry)`);
    } else if (sha256(text ?? "") !== e.sha256) {
      broken.push(e.file);
    }
  }
  return broken;
}

/** `codex.files`: skill, rules file and both hook entries exist as setup wrote them. */
function filesCheck(deps: CodexDoctorDeps): DoctorCheck {
  return {
    id: "codex.files",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      const entries = codexEntries(ctx, deps);
      if (entries.length === 0) {
        return {
          status: "warn",
          message: "the Dispatch skill, hooks and rules are not installed for Codex",
          fix: SETUP_FIX,
        };
      }
      const p = codexPaths(ctx.env, ctx.home, platformOf(deps));
      const recorded = new Set(entries.map((e) => e.file));
      const expected = codexRulesSupported(platformOf(deps))
        ? [p.skill, p.rules, p.hooks]
        : [p.skill, p.hooks];
      const unrecorded = expected.filter((f) => !recorded.has(f));
      const hooks = entries.filter((e) => e.kind === "json-entry").length;
      const broken = [...unrecorded, ...brokenEntries(entries)];
      if (hooks < 2 && !unrecorded.includes(p.hooks)) broken.push(`${p.hooks} (hook entry)`);
      if (broken.length > 0) {
        return {
          status: "warn",
          message: `missing or edited since setup: ${broken.join(", ")}`,
          fix: REFRESH_FIX,
        };
      }
      return { status: "ok", message: "the Codex skill, hooks and rules are as setup wrote them" };
    },
  };
}

/** The launcher path named in the rules file (first element of `pattern`), or null. */
export function rulesLauncher(rules: string): string | null {
  const m = /pattern\s*=\s*\[\s*("(?:[^"\\]|\\.)*")/.exec(rules);
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as string;
  } catch {
    return null;
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `codex.rules-launcher`: the launcher the rule allows still exists and is the current one. */
function rulesLauncherCheck(deps: CodexDoctorDeps): DoctorCheck {
  return {
    id: "codex.rules-launcher",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      if (!codexRulesSupported(platformOf(deps))) {
        return { status: "warn", message: CODEX_WINDOWS_NO_RULES };
      }
      const file = codexPaths(ctx.env, ctx.home, platformOf(deps)).rules;
      const text = readTextOrNull(file);
      if (text === null) {
        return { status: "warn", message: `${file} does not exist`, fix: SETUP_FIX };
      }
      const launcher = rulesLauncher(text);
      if (launcher === null) {
        return { status: "warn", message: `${file} names no launcher`, fix: REFRESH_FIX };
      }
      if (!executable(launcher)) {
        return {
          status: "warn",
          message: `the rule allows ${launcher}, which no longer exists or is not executable`,
          fix: REFRESH_FIX,
        };
      }
      const current = join(ctx.dispatchHome, "bin", launcherFileName(platformOf(deps)));
      if (launcher !== current) {
        return {
          status: "warn",
          message: `the rule allows ${launcher}, but the launcher is ${current}`,
          fix: REFRESH_FIX,
        };
      }
      return { status: "ok", message: `the Codex rule allows ${launcher}` };
    },
  };
}

/**
 * `codex.hooks-trusted`: a Codex session ran the Dispatch SessionStart hook recently and after
 * the last setup (hooks need approval in `/hooks`, again after each change).
 */
function hooksTrustedCheck(deps: CodexDoctorDeps): DoctorCheck {
  return {
    id: "codex.hooks-trusted",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      if (!codexEntries(ctx, deps).some((e) => e.kind === "json-entry")) {
        return { status: "warn", message: "the Dispatch hooks are not installed", fix: SETUP_FIX };
      }
      const beat = readHeartbeat(ctx.dispatchHome);
      const at = beat === null ? Number.NaN : Date.parse(beat.at);
      if (Number.isNaN(at)) {
        return {
          status: "warn",
          message: "no Codex session has run the Dispatch hooks yet (they need your approval)",
          fix: APPROVE_FIX,
        };
      }
      const now = (deps.now?.() ?? new Date()).getTime();
      const days = (now - at) / 86_400_000;
      const setupAt = Date.parse(readManifest(ctx.dispatchHome).updatedAt);
      if (at < setupAt) {
        return {
          status: "warn",
          message: "the Dispatch hooks have not fired since the last setup (approve them again)",
          fix: APPROVE_FIX,
        };
      }
      if (days > HEARTBEAT_MAX_AGE_DAYS) {
        return {
          status: "warn",
          message: `the Dispatch hooks last fired ${Math.floor(days)} days ago (${beat?.at})`,
          fix: APPROVE_FIX,
        };
      }
      const model = beat?.model ? `, model ${beat.model}` : "";
      return { status: "ok", message: `the Dispatch hooks fired at ${beat?.at}${model}` };
    },
  };
}

/** The Codex doctor checks. */
export function codexDoctorChecks(deps: CodexDoctorDeps = {}): DoctorCheck[] {
  return [filesCheck(deps), rulesLauncherCheck(deps), hooksTrustedCheck(deps)];
}
