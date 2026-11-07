/**
 * Doctor checks for the Claude Code integration. They read state and run `claude plugin list`
 * only: no quota, and no host file is ever written (the permission rules are printed for the user
 * to add, never added by Dispatch).
 */
import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { readHookCache } from "../../hook/cache.js";
import { type ResolveFs, resolveBinary } from "../../platform/resolve.js";
import { createCommandRunner } from "../../runner/command.js";
import type {
  CommandRunner,
  DoctorCheck,
  DoctorContext,
  DoctorResult,
} from "../_framework/index.js";
import { CLAUDE_AGENT_MATCHER, interceptList } from "./hook.js";
import { claudeConfigDir, MARKETPLACE, PLUGIN_ID } from "./integration.js";

/** Injectable dependencies of the checks. */
export interface ClaudeDoctorDeps {
  /** Runs `claude plugin list --json`; defaults to a real command runner in HOME. */
  runner?: (home: string) => CommandRunner;
  fs?: ResolveFs;
}

const SETUP_FIX = "dispatch setup";
const REFRESH_FIX = "dispatch setup --refresh";

/** The permission rules the user adds so the `dispatch` sub-agent runs without prompts. */
export function permissionRules(launcher: string): string[] {
  return [`Bash(${launcher} run:*)`, `Bash(${launcher} wait:*)`];
}

function binaryOf(ctx: DoctorContext, deps: ClaudeDoctorDeps): string | null {
  return (
    resolveBinary("claude", { env: ctx.env, ...(deps.fs ? { fs: deps.fs } : {}) })?.path ?? null
  );
}

/** Claude Code is considered absent when neither its config dir nor its binary exists. */
function absent(ctx: DoctorContext, deps: ClaudeDoctorDeps): boolean {
  return !existsSync(claudeConfigDir(ctx.env, ctx.home)) && binaryOf(ctx, deps) === null;
}

const NOT_FOUND: DoctorResult = {
  status: "ok",
  message: "Claude Code not found; nothing to check",
};

function listEntries(stdout: string): Record<string, unknown>[] | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout);
  } catch {
    return null;
  }
  const list = Array.isArray(v)
    ? v
    : v !== null && typeof v === "object"
      ? ((v as { plugins?: unknown }).plugins ?? (v as { installed?: unknown }).installed)
      : undefined;
  if (!Array.isArray(list)) return null;
  return list.filter((e): e is Record<string, unknown> => e !== null && typeof e === "object");
}

function isDispatchPlugin(e: Record<string, unknown>): boolean {
  if (e.id === PLUGIN_ID || e.source === PLUGIN_ID) return true;
  return e.name === "dispatch" && (e.marketplace === undefined || e.marketplace === MARKETPLACE);
}

/** `claude-code.plugin`: the Dispatch plugin is installed (and enabled) in Claude Code. */
function pluginCheck(deps: ClaudeDoctorDeps): DoctorCheck {
  return {
    id: "claude-code.plugin",
    async run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      const claude = binaryOf(ctx, deps);
      if (claude === null) {
        return {
          status: "warn",
          message: "the claude binary was not found, so the plugin cannot be checked",
          fix: "put `claude` on PATH, then run `dispatch doctor` again",
        };
      }
      const runner = deps.runner?.(ctx.home) ?? createCommandRunner({ cwd: ctx.home });
      let res: Awaited<ReturnType<CommandRunner["run"]>>;
      try {
        res = await runner.run(claude, ["plugin", "list", "--json"]);
      } catch (err) {
        return {
          status: "warn",
          message: `could not run \`claude plugin list\`: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      const entries = res.code === 0 ? listEntries(res.stdout) : null;
      if (entries === null) {
        return {
          status: "warn",
          message: `\`claude plugin list --json\` gave no usable answer (exit ${res.code})`,
        };
      }
      const found = entries.find(isDispatchPlugin);
      if (!found) {
        return {
          status: "warn",
          message: `the Dispatch plugin (${PLUGIN_ID}) is not installed in Claude Code`,
          fix: SETUP_FIX,
        };
      }
      if (found.enabled === false) {
        return {
          status: "warn",
          message: `the Dispatch plugin is installed but disabled`,
          fix: `claude plugin enable ${PLUGIN_ID}`,
        };
      }
      return { status: "ok", message: `plugin ${PLUGIN_ID} is installed` };
    },
  };
}

/** Parses `'…'` shell words as rendered by `renderHookCommand` (an embedded quote is `'\''`). */
function unquote(word: string): string {
  return word.slice(1, -1).replaceAll(`'\\''`, "'");
}

const QUOTED = String.raw`('(?:[^']|'\\'')*')`;
const HOOK_GUARD = new RegExp(String.raw`\[ -x ${QUOTED} \] && \[ -f ${QUOTED} \]`);

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Paths the rendered files point at that no longer exist (stale after a node upgrade, say). */
function missingPaths(dispatchHome: string, hooksFile: string): string[] {
  const missing: string[] = [];
  const hooks = JSON.parse(readFileSync(hooksFile, "utf8")) as {
    hooks?: { SessionStart?: { hooks?: { command?: string }[] }[] };
  };
  const command = hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command ?? "";
  const guard = HOOK_GUARD.exec(command);
  if (guard?.[1] && guard[2]) {
    const [node, hook] = [unquote(guard[1]), unquote(guard[2])];
    if (!executable(node)) missing.push(node);
    if (!existsSync(hook)) missing.push(hook);
  }
  const launcher = join(dispatchHome, "bin", "dispatch");
  if (!existsSync(launcher)) return [...missing, launcher];
  const exec = /^exec "([^"]+)" .*"([^"]+)" "\$@"$/m.exec(readFileSync(launcher, "utf8"));
  if (exec?.[1] && !executable(exec[1])) missing.push(exec[1]);
  if (exec?.[2] && !existsSync(exec[2])) missing.push(exec[2]);
  return missing;
}

/** `claude-code.files`: the marketplace dir exists and the node, hook and cli paths it names too. */
function filesCheck(deps: ClaudeDoctorDeps): DoctorCheck {
  return {
    id: "claude-code.files",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      const dir = join(ctx.dispatchHome, "hosts", "claude-code");
      const hooksFile = join(dir, "plugins", "dispatch", "hooks", "hooks.json");
      const needed = [join(dir, ".claude-plugin", "marketplace.json"), hooksFile];
      const gone = needed.filter((f) => !existsSync(f));
      if (gone.length > 0) {
        return {
          status: "warn",
          message: `the plugin files are missing: ${gone.join(", ")}`,
          fix: SETUP_FIX,
        };
      }
      let missing: string[];
      try {
        missing = missingPaths(ctx.dispatchHome, hooksFile);
      } catch (err) {
        return {
          status: "warn",
          message: `could not read the plugin files: ${err instanceof Error ? err.message : String(err)}`,
          fix: REFRESH_FIX,
        };
      }
      if (missing.length > 0) {
        return {
          status: "warn",
          message: `the plugin or launcher points at paths that no longer exist: ${missing.join(", ")}`,
          fix: REFRESH_FIX,
        };
      }
      return { status: "ok", message: `plugin files in ${dir} are intact` };
    },
  };
}

function allowRules(settingsFile: string): string[] | null {
  try {
    const v: unknown = parseJsonc(readFileSync(settingsFile, "utf8"));
    const allow = (v as { permissions?: { allow?: unknown } } | null)?.permissions?.allow;
    return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return null;
  }
}

/**
 * `claude-code.permission-rule`: prints the rules for `permissions.allow` and warns while they
 * are missing. Dispatch never edits Claude's permissions.
 */
function permissionCheck(deps: ClaudeDoctorDeps): DoctorCheck {
  return {
    id: "claude-code.permission-rule",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      const settings = join(claudeConfigDir(ctx.env, ctx.home), "settings.json");
      const rules = permissionRules(join(ctx.dispatchHome, "bin", "dispatch"));
      const have = allowRules(settings) ?? [];
      if (rules.every((r) => have.includes(r))) {
        return { status: "ok", message: "the Dispatch permission rules are in permissions.allow" };
      }
      return {
        status: "warn",
        message:
          "without these rules Claude Code asks before every `dispatch run` and `dispatch wait` " +
          `of the sub-agent. Dispatch never edits your permissions; add to permissions.allow in ${settings}:\n` +
          rules.map((r) => `  ${r}`).join("\n"),
        fix: `add ${rules.join(" and ")} to permissions.allow in ${settings}`,
      };
    },
  };
}

/** True when the rendered hooks.json has the Dispatch PreToolUse entry on the Agent tool. */
function hasAgentHook(hooksFile: string): boolean {
  const v = JSON.parse(readFileSync(hooksFile, "utf8")) as {
    hooks?: { PreToolUse?: { matcher?: unknown; hooks?: { command?: unknown }[] }[] };
  };
  return (v.hooks?.PreToolUse ?? []).some(
    (e) =>
      e.matcher === CLAUDE_AGENT_MATCHER &&
      (e.hooks ?? []).some(
        (x) => typeof x.command === "string" && x.command.endsWith(" claude-code PreToolUse"),
      ),
  );
}

/**
 * `claude-code.hard-mode` (UC2): the plugin has the PreToolUse hook, and whether hard mode is on
 * (`hosts.claude-code.hard`) and which sub-agent types it redirects, as the hook cache says.
 */
function hardModeCheck(deps: ClaudeDoctorDeps): DoctorCheck {
  return {
    id: "claude-code.hard-mode",
    run(ctx) {
      if (absent(ctx, deps)) return NOT_FOUND;
      const hooksFile = join(
        ctx.dispatchHome,
        "hosts",
        "claude-code",
        "plugins",
        "dispatch",
        "hooks",
        "hooks.json",
      );
      if (!existsSync(hooksFile)) {
        return { status: "warn", message: "the plugin hooks are not installed", fix: SETUP_FIX };
      }
      let hooked: boolean;
      try {
        hooked = hasAgentHook(hooksFile);
      } catch {
        hooked = false;
      }
      if (!hooked) {
        return {
          status: "warn",
          message:
            "the plugin has no PreToolUse hook on the Agent tool (installed before hard mode), so sub-agents are never redirected",
          fix: REFRESH_FIX,
        };
      }
      const cache = readHookCache(ctx.dispatchHome);
      if (cache === null || cache.policy.claudeHard === undefined) {
        return {
          status: "warn",
          message: "the hook cache does not say whether Claude hard mode is on",
          fix: REFRESH_FIX,
        };
      }
      if (!cache.policy.claudeHard) {
        return {
          status: "ok",
          message:
            "hard mode is off (hosts.claude-code.hard: false): only the SessionStart policy context",
        };
      }
      const list = interceptList(cache);
      const types = list.includes("*") ? "every sub-agent type" : list.join(", ");
      const idle =
        cache.policy.hardInterception === true
          ? ""
          : "; the active policy delegates nothing, so nothing is redirected now";
      return {
        status: "ok",
        message: `hard mode is on: Agent calls of ${types} are redirected to dispatch:dispatch in trusted repos${idle}`,
      };
    },
  };
}

/** The Claude Code doctor checks. */
export function claudeDoctorChecks(deps: ClaudeDoctorDeps = {}): DoctorCheck[] {
  return [pluginCheck(deps), filesCheck(deps), permissionCheck(deps), hardModeCheck(deps)];
}
