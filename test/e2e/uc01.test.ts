/**
 * [UC1] First setup on an existing repo (spec §11 UC1). Verifica: no pre-existing file is modified,
 * the repo diff shows only `.dispatch/` (deviation 3: host integration lives at user scope, so the
 * "marked entry in settings.json" is the Claude plugin registered in the user's config), `doctor`
 * is green, `status` lists the three providers.
 *
 * Lower-level proofs: test/unit/install/repo.test.ts, test/unit/hosts/claude-code.test.ts,
 * test/unit/cli-setup.test.ts, test/unit/setup-wizard.test.ts, test/unit/doctor.test.ts. The
 * wizard's interactive prompts need a terminal; here its non-interactive answers (flags, file) run.
 * Real accounts: docs/manual-tests/UC1.md.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createWorld,
  parseJson,
  snapshotTree,
  THREE_PROVIDERS,
  useBundles,
  useClaudePluginShim,
} from "./harness.js";

useBundles();

/** Files a developer already has in a Claude Code repo. */
const EXISTING = {
  "src/a.ts": "export const a = 1;\n",
  "CLAUDE.md": "# Project rules\nBe kind.\n",
  ".gitignore": "node_modules/\n",
  ".claude/settings.json": '{\n  "permissions": { "allow": ["Bash(ls:*)"] }\n}\n',
  ".claude/agents/reviewer.md": "---\nname: reviewer\n---\nReview code.\n",
};

const USER_SETTINGS = '{\n  "model": "opus",\n  "permissions": { "allow": [] }\n}\n';

/** A live-test reply: the agents create DISPATCH_OK / answer ok. */
const LIVE = {
  claude: [{ scenario: "success_edit" as const, file: "DISPATCH_OK", content: "ok\n" }],
  codex: [{ scenario: "success_edit" as const, file: "DISPATCH_OK", content: "ok\n" }],
  agy: [
    {
      scenario: "slow" as const,
      delayMs: 10,
      events: [
        {
          event: "result",
          result: {
            conversation_id: "c1",
            status: "SUCCESS",
            response: "ok",
            num_turns: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
            denied_actions: [],
          },
        },
      ],
    },
  ],
};

function claudeHome(w: ReturnType<typeof createWorld>): string {
  const dir = join(w.home.home, ".claude");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), USER_SETTINGS);
  return dir;
}

describe("[UC1] first setup on an existing repo", () => {
  it("[UC1] setup + install: the repo diff is only .dispatch/, existing files are byte-identical", () => {
    const w = createWorld({ files: EXISTING, global: THREE_PROVIDERS });
    useClaudePluginShim(w);
    claudeHome(w);
    const before = snapshotTree(w.repo.dir);

    const setup = w.dispatch(["setup", "--yes"]);
    expect(setup.code, setup.stderr).toBe(0);
    expect(setup.stdout).toContain("Hosts detected: claude-code");
    expect(setup.stdout).toMatch(/Setup done: \d+ applied/);
    // The host integration is a user-scope plugin registered through the Claude CLI.
    const plugin = w.fakes
      .readLog({ cli: "claude", key: "plugin" })
      .map((c) => c.args.slice(0, 3).join(" "));
    expect(plugin).toEqual(["plugin marketplace add", "plugin install dispatch@dispatch-local"]);
    const settings = JSON.parse(
      readFileSync(join(w.home.home, ".claude", "settings.json"), "utf8"),
    );
    expect(settings.enabledPlugins).toEqual({ "dispatch@dispatch-local": true });
    expect(settings.model).toBe("opus");

    const install = w.dispatch(["install", "--yes"]);
    expect(install.code, install.stderr).toBe(0);
    expect(install.stdout).toContain("Installed: 10 file(s) in .dispatch/ (trusted)");

    // Verifica: git diff shows only .dispatch/ (new, untracked); nothing pre-existing changed.
    expect(w.repo.git("status", "--porcelain")).toBe("?? .dispatch/");
    expect(w.repo.git("diff", "HEAD")).toBe("");
    const after = snapshotTree(w.repo.dir);
    for (const [path, entry] of Object.entries(before)) {
      expect(after[path], path).toEqual(entry);
    }
    const added = Object.keys(after).filter((p) => !(p in before));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p === ".dispatch" || p.startsWith(".dispatch/"))).toBe(true);
    // The repo's own .gitignore and Claude files are untouched; the sub-agent is not in the repo.
    expect(readFileSync(join(w.repo.dir, ".gitignore"), "utf8")).toBe("node_modules/\n");
    expect(readFileSync(join(w.repo.dir, ".claude", "settings.json"), "utf8")).toBe(
      EXISTING[".claude/settings.json"],
    );
    expect(after[".claude/agents/dispatch.md"]).toBeUndefined();
  });

  it("[UC1] doctor passes (no failures) and status shows the three providers with their quota", () => {
    const w = createWorld({ files: EXISTING, global: THREE_PROVIDERS, scenarios: LIVE });
    useClaudePluginShim(w);
    claudeHome(w);
    expect(w.dispatch(["setup", "--yes"]).code).toBe(0);
    expect(w.dispatch(["install", "--yes"]).code).toBe(0);

    const doctor = w.dispatch(["doctor", "--json"]);
    expect(doctor.code, doctor.stdout + doctor.stderr).toBe(0);
    const report = parseJson<{ checks: { id: string; status: string }[] }>(doctor);
    const failing = report.checks.filter((c) => c.status === "fail");
    expect(failing).toEqual([]);
    const ids = report.checks.map((c) => c.id);
    for (const id of ["claude.binary", "codex.binary", "antigravity.binary", "repo.trust"]) {
      expect(ids).toContain(id);
    }
    expect(report.checks.find((c) => c.id === "claude-code.plugin")?.status).toBe("ok");

    // Three test tasks, one per provider, each completes (doctor --live, from a plain terminal).
    const live = w.dispatch(["doctor", "--live", "--yes", "--json"]);
    expect(live.code, live.stdout + live.stderr).toBe(0);
    const liveReport = parseJson<{ checks: { id: string; status: string }[] }>(live);
    for (const id of ["live.claude", "live.codex", "live.antigravity"]) {
      expect(liveReport.checks.find((c) => c.id === id)?.status, id).toBe("ok");
    }

    const status = w.dispatch(["status", "--json"]);
    expect(status.code).toBe(0);
    const s = parseJson<{ instances: { id: string; enabled: boolean; windows: unknown[] }[] }>(
      status,
    );
    expect(s.instances.map((i) => i.id)).toEqual(["claude", "codex", "antigravity"]);
    expect(s.instances.every((i) => i.enabled)).toBe(true);
    const text = w.dispatch(["status"]).stdout;
    expect(text).toMatch(/^codex .*\n\s+5h +\d+% remaining/m);
    expect(text).toMatch(/^antigravity .*\n\s+weekly:\S+ +\d+% remaining/m);
  });

  it("[UC1] install alone runs the host setup first when the user has no global setup yet", () => {
    const w = createWorld({ files: EXISTING, global: null });
    useClaudePluginShim(w);
    claudeHome(w);
    const r = w.dispatch(["install", "--yes"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toContain("running `dispatch setup` first");
    expect(r.stdout).toContain("Hosts detected: claude-code");
    expect(w.repo.git("status", "--porcelain")).toBe("?? .dispatch/");
  });

  it("[UC1] without --yes and without a terminal nothing is written (exit 2)", () => {
    const w = createWorld({ files: EXISTING, global: null });
    claudeHome(w);
    const before = snapshotTree(w.repo.dir);
    const r = w.dispatch(["install"]);
    expect(r.code).toBe(2);
    expect(w.fakes.readLog({ cli: "claude", key: "plugin" })).toEqual([]);
    expect(snapshotTree(w.repo.dir)).toEqual(before);
  });

  it("[UC1] the setup wizard answers (host, plans, strategy, autonomy) are written to a commented ~/.dispatch/config.yaml", () => {
    const w = createWorld({ files: EXISTING, global: null });
    useClaudePluginShim(w);
    claudeHome(w);
    const setup = w.dispatch([
      "setup",
      "--non-interactive",
      "--yes",
      "--host",
      "claude-code",
      "--plan",
      "claude=max5x",
      "--plan",
      "codex=plus",
      "--profile",
      "preserve",
      "--autonomy",
      "worktree",
      "--enable-antigravity",
      "--accept-agy-terms",
    ]);
    expect(setup.code, setup.stderr).toBe(0);
    const file = join(w.home.dispatchHome, "config.yaml");
    const config = readFileSync(file, "utf8");
    expect(config).toMatch(/^version: 1/m);
    expect(config).toMatch(/^profile: preserve$/m);
    expect(config).toMatch(/^autonomy: worktree$/m);
    expect(config).toMatch(/plan: max5x/);
    expect(config).toMatch(/plan: plus/);
    expect(config).toMatch(/tos_acknowledged: true/);
    expect(config).toMatch(/^\s*#/m); // commented, not a bare dump
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The answers are what the rest of Dispatch sees.
    const status = parseJson<{ profile: string; instances: { id: string; enabled: boolean }[] }>(
      w.dispatch(["status", "--json"]),
    );
    expect(status.profile).toBe("preserve");
    expect(status.instances.map((i) => i.id)).toEqual(["claude", "codex", "antigravity"]);
    expect(status.instances.every((i) => i.enabled)).toBe(true);
    // A second setup never overwrites the user's file.
    const again = w.dispatch(["setup", "--non-interactive", "--yes", "--profile", "balance"]);
    expect(again.code, again.stderr).toBe(0);
    expect(readFileSync(file, "utf8")).toBe(config);
    // `install` in the repo then only adds .dispatch/ and reuses the answers.
    expect(w.dispatch(["install", "--yes"]).code).toBe(0);
    expect(w.repo.git("status", "--porcelain")).toBe("?? .dispatch/");
    expect(readFileSync(file, "utf8")).toContain("profile: preserve");
  });

  it("[UC1] an answers file feeds the same questions; a bad answer exits 2 and writes nothing", () => {
    const w = createWorld({ files: EXISTING, global: null });
    useClaudePluginShim(w);
    claudeHome(w);
    const answers = join(w.home.home, "answers.yaml");
    writeFileSync(answers, "main_host: none\nprofile: specialize\nautonomy: read-only\n");
    const ok = w.dispatch(["setup", "--non-interactive", "--yes", "--answers", answers]);
    expect(ok.code, ok.stderr).toBe(0);
    const config = readFileSync(join(w.home.dispatchHome, "config.yaml"), "utf8");
    expect(config).toMatch(/^profile: specialize$/m);
    expect(config).toMatch(/^autonomy: read-only$/m);

    const fresh = createWorld({ files: EXISTING, global: null });
    const bad = fresh.dispatch(["setup", "--non-interactive", "--yes", "--autonomy", "yolo"]);
    expect(bad.code).toBe(2);
    expect(existsSync(join(fresh.home.dispatchHome, "config.yaml"))).toBe(false);
  });
});
