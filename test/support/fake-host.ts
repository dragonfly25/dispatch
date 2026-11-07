/**
 * Test-only host integrations for the setup framework (WP17). They mirror what WP22 (Claude Code)
 * and WP27 (Codex) will plan, using the real templates in `assets/hosts/`, but run against a temp
 * HOME and a fake `claude` {@link CommandRunner} only.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EditOp, HostIntegration, HostPlanContext } from "../../src/core/contracts.js";
import type { CommandRunner } from "../../src/hosts/_framework/index.js";
import {
  assetOps,
  hostAssetDir,
  renderHostAsset,
  templateValues,
} from "../../src/hosts/_framework/index.js";

/** Trust grant text the fake Codex host attaches to its rules file. */
export const CODEX_RULES_GRANT =
  "lets the Dispatch launcher's run/wait/cancel/status run outside the Codex sandbox";

interface FakeHostOptions {
  present: boolean | ((ctx: HostPlanContext) => boolean);
}

function base(
  id: HostIntegration["id"],
  opts: FakeHostOptions,
): Omit<HostIntegration, "plan" | "waitTimeoutSec"> {
  return {
    id,
    subagentStrategy: id === "codex" ? "deny_redirect" : "none",
    subagentMatcher: id === "codex" ? "spawn_agent|collaborationspawn_agent|Agent" : null,
    detectSelf: () => null,
    detect: async (ctx) => (typeof opts.present === "function" ? opts.present(ctx) : opts.present),
    hookHandlers: {},
  };
}

/** A Codex-like host: skill + rules file (trust grant) + two json-entries in hooks.json. */
export function fakeCodexHost(opts: FakeHostOptions = { present: true }): HostIntegration {
  const host: HostIntegration = {
    ...base("codex", opts),
    waitTimeoutSec: 280,
    plan(ctx) {
      const v = templateValues(ctx, host);
      const frag = JSON.parse(renderHostAsset("codex/hooks.fragment.json", v)) as {
        hooks: Record<string, { hooks: { command: string }[] }[]>;
      };
      const hooksFile = join(ctx.home, ".codex", "hooks.json");
      const entries = Object.entries(frag.hooks).map(
        ([event, groups]): EditOp => ({
          file: hooksFile,
          kind: "json-entry",
          signature: groups[0]?.hooks[0]?.command ?? "",
          content: JSON.stringify({ path: ["hooks", event], mode: "append", value: groups[0] }),
          trustGrant: null,
        }),
      );
      return [
        ...assetOps(v, [
          {
            template: "codex/skills/dispatch/SKILL.md",
            dest: join(ctx.home, ".agents", "skills", "dispatch", "SKILL.md"),
          },
          {
            template: "codex/dispatch.rules.tmpl",
            dest: join(ctx.home, ".codex", "rules", "dispatch.rules"),
            kind: "rules-file",
            trustGrant: CODEX_RULES_GRANT,
          },
        ]),
        ...entries,
      ];
    },
  };
  return host;
}

/** A Claude-like host: marketplace in `~/.dispatch/hosts/claude-code` + two `claude plugin` calls. */
export function fakeClaudeHost(opts: FakeHostOptions = { present: true }): HostIntegration {
  const host: HostIntegration = {
    ...base("claude-code", opts),
    waitTimeoutSec: 100,
    plan(ctx) {
      const v = templateValues(ctx, host);
      const dir = hostAssetDir(ctx, "claude-code");
      const plugin = join(dir, "plugins", "dispatch");
      const claude = join(ctx.home, ".claude");
      const settings = join(claude, "settings.json");
      return [
        ...assetOps(v, [
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
          { template: "claude-code/hooks/hooks.json", dest: join(plugin, "hooks", "hooks.json") },
        ]),
        {
          file: "claude",
          kind: "cli-command",
          signature: "claude-marketplace",
          content: JSON.stringify({
            argv: ["plugin", "marketplace", "add", dir, "--scope", "user"],
            undo: ["plugin", "marketplace", "remove", "dispatch-local"],
            snapshot: { jsonKeys: [{ file: settings, keys: ["extraKnownMarketplaces"] }] },
          }),
          trustGrant: null,
        },
        {
          file: "claude",
          kind: "cli-command",
          signature: "claude-plugin",
          content: JSON.stringify({
            argv: ["plugin", "install", "dispatch@dispatch-local", "-s", "user"],
            undo: ["plugin", "uninstall", "dispatch@dispatch-local", "-s", "user"],
            snapshot: {
              jsonKeys: [{ file: settings, keys: ["enabledPlugins"] }],
              leftovers: [
                {
                  path: join(claude, "plugins", "installed_plugins.json"),
                  match: { version: 2, plugins: {} },
                },
                { path: join(claude, "plugins", "cache", "dispatch-local"), recursive: true },
                { path: join(claude, "plugins", "data") },
                { path: join(claude, "plugins", "cache") },
                { path: join(claude, "plugins") },
              ],
            },
          }),
          trustGrant:
            "installs the Dispatch plugin (agent + SessionStart hook) for every Claude Code session",
        },
      ];
    },
  };
  return host;
}

/**
 * A fake `claude plugin …` that edits `<home>/.claude` the way claude 2.1.301 did in the WP8 spike:
 * uninstall leaves empty `enabledPlugins` / `extraKnownMarketplaces` objects, an
 * `installed_plugins.json`, an orphaned cache dir and an empty `plugins/data/`.
 */
export function fakeClaudeRunner(home: string): CommandRunner & { calls: string[][] } {
  const claude = join(home, ".claude");
  const settings = join(claude, "settings.json");
  const plugins = join(claude, "plugins");
  const read = (): Record<string, Record<string, unknown>> =>
    existsSync(settings) ? JSON.parse(readFileSync(settings, "utf8")) : {};
  const write = (obj: unknown) => {
    mkdirSync(claude, { recursive: true });
    writeFileSync(settings, `${JSON.stringify(obj, null, 2)}\n`);
  };
  const writeJson = (path: string, obj: unknown) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(obj));
  };
  const calls: string[][] = [];
  return {
    calls,
    async run(binary, argv) {
      calls.push([binary, ...argv]);
      const s = read();
      const cmd = argv.slice(0, 3).join(" ");
      if (cmd.startsWith("plugin marketplace add")) {
        s.extraKnownMarketplaces = {
          ...s.extraKnownMarketplaces,
          "dispatch-local": { source: { source: "directory", path: argv[3] } },
        };
      } else if (cmd.startsWith("plugin marketplace remove")) {
        delete s.extraKnownMarketplaces?.["dispatch-local"];
      } else if (cmd.startsWith("plugin install")) {
        s.enabledPlugins = { ...s.enabledPlugins, "dispatch@dispatch-local": true };
        writeJson(join(plugins, "installed_plugins.json"), { version: 2, plugins: { d: 1 } });
        writeJson(join(plugins, "cache", "dispatch-local", "dispatch", "0.0.0", "plugin.json"), {});
      } else if (cmd.startsWith("plugin uninstall")) {
        delete s.enabledPlugins?.["dispatch@dispatch-local"];
        writeJson(join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });
        writeFileSync(join(plugins, "cache", "dispatch-local", ".orphaned_at"), "1");
        rmSync(join(plugins, "data"), { recursive: true, force: true });
        mkdirSync(join(plugins, "data"));
      } else {
        return { code: 1, stdout: "", stderr: `unknown: ${argv.join(" ")}` };
      }
      write(s);
      return { code: 0, stdout: "{}", stderr: "" };
    },
  };
}
