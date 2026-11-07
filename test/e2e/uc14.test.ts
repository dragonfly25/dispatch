/**
 * [UC14] Uninstall (spec §11 UC14) and [AC2] (install + uninstall leave the repo identical).
 * Verifica: `git diff` is clean against the pre-install state, and the host files are
 * byte-identical (setup + `uninstall --global`, plan §8).
 *
 * The flow: user files in HOME and in the repo -> `setup` -> `install` -> a delegated run (so state
 * exists) -> `uninstall` -> `uninstall --global`. The Claude CLI is the plugin shim, which leaves
 * the same residue the real `claude plugin uninstall` leaves; Dispatch must clean it up.
 *
 * Lower-level proofs: test/unit/install/repo.test.ts ([UC14]), cli-setup.test.ts ([UC14]),
 * hosts/claude-code.test.ts, hosts/edits.test.ts, docs-guides.test.ts.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotTree, treeHash } from "../support/index.js";
import {
  createWorld,
  EDIT_CODEX,
  THREE_PROVIDERS,
  useBundles,
  useClaudePluginShim,
  type World,
} from "./harness.js";

useBundles();

// Pretty-printed like Claude Code writes it, so its own rewrites round-trip byte for byte.
const CLAUDE_SETTINGS = `${JSON.stringify(
  { model: "opus", permissions: { allow: ["Bash(ls:*)"] }, env: {} },
  null,
  2,
)}\n`;
const CODEX_HOOKS = '{\n  // my own hook\n  "hooks": {}\n}\n';
const CODEX_CONFIG =
  '# user config\nmodel = "gpt-6-sol"\n\n[projects."/tmp/x"]\ntrust_level = "trusted"\n';

/** HOME as a developer has it: Claude Code and Codex configured, nothing of Dispatch. */
function userHome(w: World): void {
  const claude = join(w.home.home, ".claude");
  const codex = join(w.home.home, ".codex");
  mkdirSync(claude, { recursive: true });
  mkdirSync(join(codex, "rules"), { recursive: true });
  writeFileSync(join(claude, "settings.json"), CLAUDE_SETTINGS);
  writeFileSync(join(claude, "CLAUDE.md"), "# my global rules\n");
  writeFileSync(join(codex, "hooks.json"), CODEX_HOOKS);
  writeFileSync(join(codex, "config.toml"), CODEX_CONFIG);
  writeFileSync(join(codex, "rules", "default.rules"), "# mine\n");
}

describe("[UC14] uninstall", () => {
  it("[UC14][AC2] install + setup then uninstall + uninstall --global: repo and host files are as before", () => {
    const w = createWorld({
      global: null,
      scenarios: EDIT_CODEX,
      files: { "src/a.ts": "export const a = 1;\n", ".gitignore": "node_modules/\n" },
      env: { CLAUDECODE: "1" },
    });
    useClaudePluginShim(w);
    userHome(w);
    // Everything the user had, before Dispatch (the repo with its .git, and the whole HOME).
    const repoHash = treeHash(w.repo.dir);
    const repoFiles = snapshotTree(w.repo.dir);
    const homeBefore = snapshotTree(w.home.home);

    // Install: setup (user scope) and the repo part; then use it once so state exists.
    const setup = w.dispatch(["setup", "--yes"]);
    expect(setup.code, setup.stderr).toBe(0);
    const install = w.dispatch(["install", "--yes"]);
    expect(install.code, install.stderr).toBe(0);
    expect(w.repo.git("status", "--porcelain")).toBe("?? .dispatch/");
    const settingsDuring = JSON.parse(
      readFileSync(join(w.home.home, ".claude", "settings.json"), "utf8"),
    );
    expect(settingsDuring.enabledPlugins).toEqual({ "dispatch@dispatch-local": true });
    const run = w.run(["--path", "math.js"]);
    expect(run.result?.status).toBe("completed");
    expect(existsSync(join(w.repo.dir, ".dispatch", "state"))).toBe(true);

    // Uninstall the repo part: `git diff` is clean against the pre-install state.
    const un = w.dispatch(["uninstall", "--yes"]);
    expect(un.code, un.stderr).toBe(0);
    expect(w.repo.git("status", "--porcelain")).toBe("");
    expect(w.repo.git("diff", "HEAD")).toBe("");
    expect(existsSync(join(w.repo.dir, ".dispatch"))).toBe(false);
    expect(snapshotTree(w.repo.dir)).toEqual(repoFiles);
    expect(treeHash(w.repo.dir)).toBe(repoHash);
    // The host integration (user scope) is still there until the global uninstall.
    expect(existsSync(join(w.home.dispatchHome, "hosts", "claude-code"))).toBe(true);

    // Uninstall the user part: host files are byte-identical, ~/.dispatch is gone.
    const global = w.dispatch(["uninstall", "--global"]);
    expect(global.code, global.stderr).toBe(0);
    expect(global.stdout).toContain("Removed");
    expect(existsSync(w.home.dispatchHome)).toBe(false);
    expect(readFileSync(join(w.home.home, ".claude", "settings.json"), "utf8")).toBe(
      CLAUDE_SETTINGS,
    );
    expect(readFileSync(join(w.home.home, ".codex", "hooks.json"), "utf8")).toBe(CODEX_HOOKS);
    expect(readFileSync(join(w.home.home, ".codex", "config.toml"), "utf8")).toBe(CODEX_CONFIG);
    expect(snapshotTree(w.home.home)).toEqual(homeBefore);
    // The Claude plugin was really removed through the Claude CLI.
    const calls = w.fakes
      .readLog({ cli: "claude", key: "plugin" })
      .map((c) => c.args.slice(0, 3).join(" "));
    expect(calls).toContain("plugin uninstall dispatch@dispatch-local");
    expect(calls).toContain("plugin marketplace remove");
    // And the repo is still exactly as it was.
    expect(treeHash(w.repo.dir)).toBe(repoHash);
    expect(w.repo.git("worktree", "list").split("\n")).toHaveLength(1);
  });

  it("[UC14] uninstall --global --keep-home keeps ~/.dispatch (config and state) and removes the host edits", () => {
    const w = createWorld({ global: THREE_PROVIDERS });
    useClaudePluginShim(w);
    userHome(w);
    const homeBefore = snapshotTree(w.home.home, { exclude: [".dispatch"] });
    expect(w.dispatch(["setup", "--yes"]).code).toBe(0);
    const r = w.dispatch(["uninstall", "--global", "--keep-home"]);
    expect(r.code, r.stderr).toBe(0);
    expect(existsSync(join(w.home.dispatchHome, "config.yaml"))).toBe(true);
    expect(snapshotTree(w.home.home, { exclude: [".dispatch"] })).toEqual(homeBefore);
  });

  it("[UC14] a file edited since install is kept with a warning, unless --force", () => {
    const install = (w: World): string => {
      expect(w.dispatch(["install", "--yes", "--skip-setup"]).code).toBe(0);
      const config = join(w.repo.dir, ".dispatch", "config.yaml");
      writeFileSync(config, `${readFileSync(config, "utf8")}\n# my note\n`);
      return config;
    };
    const kept = createWorld({ global: THREE_PROVIDERS });
    const config = install(kept);
    const r = kept.dispatch(["uninstall", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain(".dispatch/config.yaml (edited since install)");
    expect(r.stdout).toContain("warning: kept .dispatch/config.yaml: it was edited since install");
    expect(readFileSync(config, "utf8")).toContain("# my note");

    const forced = createWorld({ global: THREE_PROVIDERS });
    install(forced);
    const f = forced.dispatch(["uninstall", "--yes", "--force"]);
    expect(f.code, f.stderr).toBe(0);
    expect(existsSync(join(forced.repo.dir, ".dispatch"))).toBe(false);
    expect(forced.repo.git("status", "--porcelain")).toBe("");
  });
});
