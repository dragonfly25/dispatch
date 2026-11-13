/**
 * Codex CLI host integration (plan §2 "Host integration", amendments "UC3"): user-scope files only.
 *
 * - `~/.agents/skills/dispatch/SKILL.md`: when and how to delegate (rule-compatible call form).
 * - Two entries in `<codex home>/hooks.json` (jsonc-parser, comments and user hooks survive):
 *   SessionStart (policy context + heartbeat) and PreToolUse on the native sub-agent spawn
 *   (`deny_redirect`, see `./hook.ts`). Codex runs them only after the user approves them in
 *   `/hooks`; Dispatch never writes that trust itself.
 * - `<codex home>/rules/dispatch.rules`: a trust grant that lets ONLY the absolute launcher's
 *   `run|wait|cancel|status` run outside the Codex sandbox (docs/spikes/codex.md Q2). Not on
 *   Windows: there the launcher is a batch file whose arguments cmd.exe re-parses, so a matched
 *   rule would run model-written text unsandboxed (docs/spikes/windows.md). Codex-hosted runs on
 *   Windows stay sandboxed and need the user's per-call approval to reach the network.
 *
 * `config.toml` and AGENTS.md are never touched.
 */
import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../core/contracts.js";
import { envGet, isWindows, type OsPlatform } from "../../platform/os.js";
import type { ResolveFs } from "../../platform/resolve.js";
import {
  assetOps,
  hostPresent,
  renderHostAsset,
  type TemplateValues,
  templateValues,
} from "../_framework/index.js";
import { CODEX_SPAWN_MATCHER, CODEX_WAIT_TIMEOUT_SEC, hookHandlers } from "./hook.js";

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Codex's home: `$CODEX_HOME` when absolute, else `<home>/.codex` (`%USERPROFILE%\.codex` on
 * Windows, where the variable name is case-insensitive).
 */
export function codexHomeDir(
  env: Env,
  home: string,
  platform: OsPlatform = process.platform,
): string {
  const dir = envGet(env, "CODEX_HOME", platform);
  const absolute = isWindows(platform) ? win32.isAbsolute : posix.isAbsolute;
  return dir && absolute(dir) ? dir : join(home, ".codex");
}

/** Where the Dispatch files live for a Codex home and a user HOME. */
export function codexPaths(env: Env, home: string, platform: OsPlatform = process.platform) {
  const codexHome = codexHomeDir(env, home, platform);
  return {
    codexHome,
    hooks: join(codexHome, "hooks.json"),
    rules: join(codexHome, "rules", "dispatch.rules"),
    skill: join(home, ".agents", "skills", "dispatch", "SKILL.md"),
  };
}

/** Trust grant of the rules file, shown verbatim by `setup`. */
export function rulesGrant(launcher: string): string {
  return (
    `lets ONLY \`${launcher} run|wait|cancel|status\` run outside the Codex sandbox ` +
    "(network access, writes under ~/.dispatch) in every Codex session of this user; " +
    "compound commands (&&, ;, pipes, $, redirects) stay sandboxed"
  );
}

/**
 * True when setup installs the Codex rules file on `platform`: never on Windows, where the
 * launcher is `dispatch.cmd` (see the module comment). Doctor and setup report the consequence.
 */
export function codexRulesSupported(platform: OsPlatform = process.platform): boolean {
  return !isWindows(platform);
}

/** What setup and doctor say on Windows instead of installing the rules file. */
export const CODEX_WINDOWS_NO_RULES =
  "no Codex rule is installed on Windows (the launcher is a batch file and cmd.exe would re-parse " +
  "the model's arguments outside the sandbox), so a Codex-hosted Dispatch run stays in the Codex " +
  "sandbox: approve running the Dispatch command outside the sandbox when Codex asks, or the run " +
  "has no network";

/** Trust grant of the hooks, including the manual `/hooks` approval step. */
export const HOOKS_GRANT =
  "adds two Dispatch hooks to every Codex session of this user: SessionStart (injects the " +
  "delegation policy in trusted repos) and PreToolUse on spawn_agent (in trusted repos whose " +
  "policy delegates, denies native sub-agent spawns and tells the model to use Dispatch instead; " +
  "turn it off with `hosts.codex.hard: false`). Codex runs them only after you approve them: " +
  "open codex, run /hooks, approve the two Dispatch hooks";

/** Version from `CODEX_VERSION` (exported by Codex to shell commands and hooks). */
function selfVersion(env: Env): string | null {
  const v = env.CODEX_VERSION;
  return v && /^\d+\.\d+\.\d+/.test(v) ? v : null;
}

/** The two hook groups of `assets/hosts/codex/hooks.fragment.json`, rendered. */
function hookGroups(values: TemplateValues): [string, { hooks: { command: string }[] }][] {
  const frag = JSON.parse(renderHostAsset("codex/hooks.fragment.json", values)) as {
    hooks: Record<string, { hooks: { command: string }[] }[]>;
  };
  return Object.entries(frag.hooks).flatMap(([event, groups]) =>
    groups.map((g): [string, { hooks: { command: string }[] }] => [event, g]),
  );
}

/** Injectable dependencies; the defaults are the real process environment and filesystem. */
export interface CodexHostDeps {
  env?: () => Env;
  fs?: ResolveFs;
  /** Default `process.platform`. */
  platform?: OsPlatform;
}

/** Builds the integration; tests pass an environment and a filesystem view. */
export function createCodexIntegration(deps: CodexHostDeps = {}): HostIntegration {
  const env = (): Env => (deps.env ? deps.env() : process.env);
  const platform = deps.platform ?? process.platform;

  const host: HostIntegration = {
    id: "codex",
    subagentStrategy: "deny_redirect",
    subagentMatcher: CODEX_SPAWN_MATCHER,
    waitTimeoutSec: CODEX_WAIT_TIMEOUT_SEC,
    hookHandlers,

    detectSelf(e) {
      if (!e.CODEX_THREAD_ID && !e.CODEX_VERSION) return null;
      return { host: "codex", version: selfVersion(e) };
    },

    async detect(ctx) {
      const e = env();
      return (
        existsSync(codexHomeDir(e, ctx.home, platform)) ||
        hostPresent({
          home: ctx.home,
          binary: "codex",
          dir: ".codex",
          env: e,
          platform,
          ...(deps.fs ? { fs: deps.fs } : {}),
        })
      );
    },

    plan(ctx: HostPlanContext): EditOp[] {
      // Codex runs model commands and hooks in PowerShell on Windows.
      const values = templateValues(ctx, host, { platform, shell: "powershell" });
      const paths = codexPaths(env(), ctx.home, platform);
      const windows = isWindows(platform);
      const hooks = hookGroups(values).map(
        ([event, group]): EditOp => ({
          file: paths.hooks,
          kind: "json-entry",
          // The hook command (absolute node + hook paths, host and event) identifies the entry.
          signature: group.hooks[0]?.command ?? `dispatch codex ${event}`,
          content: JSON.stringify({ path: ["hooks", event], mode: "append", value: group }),
          trustGrant: event === "PreToolUse" ? HOOKS_GRANT : null,
        }),
      );
      return [
        ...assetOps(values, [
          {
            template: windows
              ? "codex/skills/dispatch/SKILL.windows.md"
              : "codex/skills/dispatch/SKILL.md",
            dest: paths.skill,
          },
          ...(codexRulesSupported(platform)
            ? [
                {
                  template: "codex/dispatch.rules.tmpl",
                  dest: paths.rules,
                  kind: "rules-file" as const,
                  trustGrant: rulesGrant(ctx.launcherPath),
                },
              ]
            : []),
        ]),
        ...hooks,
      ];
    },
  };
  return host;
}

/** The built-in Codex integration (real environment and filesystem). */
export const codexIntegration: HostIntegration = createCodexIntegration();
