// Test double for `claude plugin ...` used by the acceptance suite (UC1, UC14).
//
// The fake `claude` in test/fakes only logs plugin subcommands. This shim, placed in front of it on
// PATH, also edits `<config dir>/settings.json` and `<config dir>/plugins/` the way claude 2.1.301
// did in the WP8 spike (docs/spikes/hosts-prototype.md): install enables the plugin and creates
// `installed_plugins.json` and a cache dir; uninstall leaves empty `enabledPlugins`/
// `extraKnownMarketplaces` objects, an `installed_plugins.json`, an orphaned cache and `plugins/data`.
// That is exactly the residue `uninstall --global` must clean up to leave host files byte-identical.
// Every other invocation is forwarded to the real fake CLI named by FAKE_REAL_CLAUDE.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);

if (argv[0] !== "plugin") {
  const real = process.env.FAKE_REAL_CLAUDE;
  const r = spawnSync(real, argv, { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

// The fake logs the call (FAKE_LOG) so tests can assert the plugin commands; its output is dropped.
spawnSync(process.env.FAKE_REAL_CLAUDE, argv, { stdio: "ignore" });

const configDir = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || homedir(), ".claude");
const settingsPath = join(configDir, "settings.json");
const plugins = join(configDir, "plugins");
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

const cmd = argv.slice(0, 3).join(" ");
if (cmd.startsWith("plugin marketplace add")) {
  settings.extraKnownMarketplaces = {
    ...settings.extraKnownMarketplaces,
    "dispatch-local": { source: { source: "directory", path: argv[3] } },
  };
} else if (cmd.startsWith("plugin marketplace remove")) {
  settings.extraKnownMarketplaces ??= {};
  delete settings.extraKnownMarketplaces["dispatch-local"];
} else if (cmd.startsWith("plugin install")) {
  settings.enabledPlugins = { ...settings.enabledPlugins, "dispatch@dispatch-local": true };
  writeJson(join(plugins, "installed_plugins.json"), { version: 2, plugins: { dispatch: 1 } });
  writeJson(join(plugins, "cache", "dispatch-local", "dispatch", "0.0.0", "plugin.json"), {});
} else if (cmd.startsWith("plugin uninstall")) {
  settings.enabledPlugins ??= {};
  delete settings.enabledPlugins["dispatch@dispatch-local"];
  writeJson(join(plugins, "installed_plugins.json"), { version: 2, plugins: {} });
  writeFileSync(join(plugins, "cache", "dispatch-local", ".orphaned_at"), "1");
  rmSync(join(plugins, "data"), { recursive: true, force: true });
  mkdirSync(join(plugins, "data"));
} else if (cmd.startsWith("plugin list")) {
  const on = Object.keys(settings.enabledPlugins ?? {}).filter(
    (id) => settings.enabledPlugins[id] === true,
  );
  process.stdout.write(`${JSON.stringify(on.map((id) => ({ id, enabled: true })))}\n`);
  process.exit(0);
} else {
  process.stderr.write(`claude-plugin-shim: unsupported: ${argv.join(" ")}\n`);
  process.exit(1);
}
mkdirSync(configDir, { recursive: true });
writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
process.stdout.write("{}\n");
