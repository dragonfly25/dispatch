/**
 * Claude Code host integration (plan §2 "Host integration"): a user-scope plugin installed from a
 * local marketplace that Dispatch renders into `~/.dispatch/hosts/claude-code/`.
 *
 * The plugin holds the `dispatch` sub-agent, a SessionStart hook that injects the policy and a
 * PreToolUse hook on the `Agent` tool (hard mode, see `./hook.ts`). Claude Code reads a directory
 * marketplace plugin from that folder ("Read from" in `claude plugin list`), not from its
 * per-version cache copy, so `setup --refresh` re-rendering the files reaches every new session
 * without a reinstall. There is no auto-allow: `doctor` prints the permission rules for the user
 * to add (see `./doctor.ts`). Setup runs two `claude plugin …` commands and records enough
 * to undo them exactly, including the leftovers the CLI keeps after uninstall
 * (docs/spikes/hosts-prototype.md §1).
 */
import { existsSync } from "node:fs";
import { join, normalize, posix, win32 } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../core/contracts.js";
import { envGet, isWindows, type OsPlatform } from "../../platform/os.js";
import { type ResolveFs, resolveBinary } from "../../platform/resolve.js";
import { assetOps, hostAssetDir, hostPresent, templateValues } from "../_framework/index.js";
import { CLAUDE_WAIT_TIMEOUT_SEC, hookHandlers } from "./hook.js";

/** Name of the local marketplace (`name` in `assets/hosts/claude-code/marketplace.json`). */
export const MARKETPLACE = "dispatch-local";
/** Name of the plugin inside it. */
export const PLUGIN = "dispatch";
/** Claude's plugin id, `<plugin>@<marketplace>`. */
export const PLUGIN_ID = `${PLUGIN}@${MARKETPLACE}`;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The Claude Code config directory: `$CLAUDE_CONFIG_DIR` when absolute, else `<home>/.claude`
 * (`%USERPROFILE%\.claude` on Windows, where the variable name is case-insensitive).
 */
export function claudeConfigDir(
  env: Env,
  home: string,
  platform: OsPlatform = process.platform,
): string {
  const dir = envGet(env, "CLAUDE_CONFIG_DIR", platform);
  const absolute = isWindows(platform) ? win32.isAbsolute : posix.isAbsolute;
  return dir && absolute(dir) ? dir : join(home, ".claude");
}

/** Which Claude Code instance a process belongs to (UC12: `claude-alt` has its own config dir). */
export interface ClaudeInstance {
  configDir: string;
  /** True for the default `~/.claude` instance. */
  isDefault: boolean;
}

/**
 * The instance selected by the environment (`CLAUDE_CONFIG_DIR`); the default one when unset.
 * The comparison normalizes separators, so `C:/Users/u/.claude` is the default instance on Windows.
 */
export function claudeInstanceOf(env: Env, home: string): ClaudeInstance {
  const configDir = claudeConfigDir(env, home);
  return { configDir, isDefault: normalize(configDir) === join(home, ".claude") };
}

/** Version from `CLAUDE_CODE_VERSION`, else a `x.y.z` path segment of `CLAUDE_CODE_EXECPATH`. */
function selfVersion(env: Env): string | null {
  const direct = env.CLAUDE_CODE_VERSION;
  if (direct && /^\d+\.\d+\.\d+/.test(direct)) return direct;
  const m = /(?:^|[/\\@-])(\d+\.\d+\.\d+)(?:[/\\.-]|$)/.exec(env.CLAUDE_CODE_EXECPATH ?? "");
  return m?.[1] ?? null;
}

/** Injectable dependencies; the defaults are the real process environment and filesystem. */
export interface ClaudeHostDeps {
  env?: () => Env;
  fs?: ResolveFs;
  /** Default `process.platform`. */
  platform?: OsPlatform;
}

/** Builds the integration; tests pass an environment and a filesystem view. */
export function createClaudeCodeIntegration(deps: ClaudeHostDeps = {}): HostIntegration {
  const env = (): Env => (deps.env ? deps.env() : process.env);
  const platform = deps.platform ?? process.platform;

  /** Absolute path of the `claude` binary, or null. Never taken from a Dispatch child's env. */
  const binary = (): string | null =>
    resolveBinary("claude", { env: env(), platform, ...(deps.fs ? { fs: deps.fs } : {}) })?.path ??
    null;

  const host: HostIntegration = {
    id: "claude-code",
    // The frozen contract has no value for the `updatedInput` rewrite (it is neither "none" nor
    // "deny_redirect"); the PreToolUse matcher lives in the plugin's hooks.json.
    subagentStrategy: "none",
    subagentMatcher: null,
    waitTimeoutSec: CLAUDE_WAIT_TIMEOUT_SEC,
    hookHandlers,

    detectSelf(e) {
      if (e.CLAUDECODE !== "1" && !e.CLAUDE_CODE_ENTRYPOINT) return null;
      return { host: "claude-code", version: selfVersion(e) };
    },

    async detect(ctx) {
      const e = env();
      return (
        existsSync(claudeConfigDir(e, ctx.home, platform)) ||
        hostPresent({
          home: ctx.home,
          binary: "claude",
          dir: ".claude",
          env: e,
          platform,
          ...(deps.fs ? { fs: deps.fs } : {}),
        })
      );
    },

    plan(ctx: HostPlanContext): EditOp[] {
      // The plugin can only be installed through the CLI; without it there is nothing to plan.
      const claude = binary();
      if (claude === null) return [];
      // Claude Code's Bash tool is Git Bash on Windows, so the model's calls use bash quoting.
      const values = templateValues(ctx, host, { platform, shell: "bash" });
      const dir = hostAssetDir(ctx, "claude-code");
      const plugin = join(dir, "plugins", PLUGIN);
      const config = claudeConfigDir(env(), ctx.home, platform);
      const settings = join(config, "settings.json");
      const plugins = join(config, "plugins");
      const cli = (signature: string, spec: unknown, trustGrant: string | null): EditOp => ({
        file: claude,
        kind: "cli-command",
        signature,
        content: JSON.stringify(spec),
        trustGrant,
      });
      return [
        ...assetOps(values, [
          {
            template: "claude-code/marketplace.json",
            dest: join(dir, ".claude-plugin", "marketplace.json"),
          },
          {
            template: "claude-code/plugin.json",
            dest: join(plugin, ".claude-plugin", "plugin.json"),
          },
          {
            template: "claude-code/agents/dispatch.md",
            dest: join(plugin, "agents", "dispatch.md"),
          },
          {
            // Windows: exec form (`command` + `args`), so no shell parses the paths.
            template: isWindows(platform)
              ? "claude-code/hooks/hooks.windows.json"
              : "claude-code/hooks/hooks.json",
            dest: join(plugin, "hooks", "hooks.json"),
          },
        ]),
        cli(
          "claude-marketplace",
          {
            argv: ["plugin", "marketplace", "add", dir, "--scope", "user"],
            undo: ["plugin", "marketplace", "remove", MARKETPLACE],
            snapshot: { jsonKeys: [{ file: settings, keys: ["extraKnownMarketplaces"] }] },
          },
          null,
        ),
        cli(
          "claude-plugin",
          {
            argv: ["plugin", "install", PLUGIN_ID, "-s", "user", "--json", "-y"],
            undo: ["plugin", "uninstall", PLUGIN_ID, "-s", "user"],
            snapshot: {
              jsonKeys: [{ file: settings, keys: ["enabledPlugins"] }],
              // What `plugin uninstall` leaves behind (children before parents; only paths that
              // did not exist before setup are removed).
              leftovers: [
                {
                  path: join(plugins, "installed_plugins.json"),
                  match: { version: 2, plugins: {} },
                },
                { path: join(plugins, "cache", MARKETPLACE), recursive: true },
                { path: join(plugins, "data") },
                { path: join(plugins, "cache") },
                { path: plugins },
              ],
            },
          },
          "installs the Dispatch plugin (a sub-agent, a SessionStart hook, and a PreToolUse hook that redirects general-purpose and eligible custom sub-agents to Dispatch in trusted repos, reading but never changing your agent files) for every Claude Code session of this user",
        ),
      ];
    },
  };
  return host;
}

/** The built-in Claude Code integration (real environment and filesystem). */
export const claudeCodeIntegration: HostIntegration = createClaudeCodeIntegration();
