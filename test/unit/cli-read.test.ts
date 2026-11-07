import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { harness, PIN_CONFIG } from "./cli-read.helpers.js";
import { writeFiles } from "./config/helpers.js";

const TEAM_PROFILE =
  "version: 1\ndescription: team rules\nrules:\n  - id: all-host\n    action: { type: host }\n";

describe("validate", () => {
  it("[UC5] a clean configuration exits 0", async () => {
    const h = harness();
    h.sb.global(PIN_CONFIG);
    const r = await h.run(["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("Configuration OK: 0 errors, 0 warnings");
  });

  it("warnings alone exit 0", async () => {
    const h = harness();
    h.sb.global(
      "version: 1\npins:\n  - { id: a, action: { type: host } }\n  - { id: b, match: { paths: [x] }, action: { type: host } }\n",
    );
    const r = await h.run(["validate"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/warning\s+pins\[1\]: pin "b" is unreachable/);
    expect(r.out).toContain("0 errors, 1 warning");
  });

  it("any error exits 2 and is reported (text and JSON)", async () => {
    const h = harness();
    h.sb.global("version: 1\npins:\n  - { id: p, action: { type: provider, instance: ghost } }\n");
    const text = await h.run(["validate"]);
    expect(text.code).toBe(2);
    expect(text.out).toMatch(/error\s+pins\[0\]\.action\.instance: unknown instance "ghost"/);
    expect(text.out).toContain("Configuration invalid: 1 error");
    expect(text.err).toContain("validation failed with 1 error");

    const json = JSON.parse((await h.run(["validate", "--json"])).out);
    expect(json).toMatchObject({ ok: false, errors: 1, warnings: 0 });
    expect(json.issues[0]).toMatchObject({ level: "error", path: "pins[0].action.instance" });
  });

  it("[UC6] an unknown unspecified_model tier is an error from the loader", async () => {
    const h = harness();
    h.sb.global("version: 1\nunspecified_model: gigantic\n");
    const r = await h.run(["validate"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("unspecified_model");
  });

  it("a global config that cannot be parsed exits 2", async () => {
    const h = harness();
    h.sb.global("version: 1\nnonsense: true\n");
    const r = await h.run(["validate"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("config.yaml");
  });
});

describe("profiles", () => {
  it("lists the shipped profiles with the active one marked", async () => {
    const h = harness();
    const r = await h.run(["profiles"]);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(
      /^\* balance +default +2 rule\(s\) +\S*assets\/profiles\/balance\.yaml$/m,
    );
    expect(r.out).toMatch(/^ {2}preserve +default/m);
    expect(r.out).toContain("    Delegate to the instance with the most remaining quota.");
  });

  it("--json gives name, active, source, file, description and rules", async () => {
    const h = harness();
    writeFiles(h.sb.dispatchHome, { "profiles/team.yaml": TEAM_PROFILE });
    const j = JSON.parse((await h.run(["profiles", "--json"])).out);
    expect(j.active).toBe("balance");
    expect(j.profiles.map((p: { name: string }) => p.name)).toEqual([
      "balance",
      "off",
      "preserve",
      "specialize",
      "team",
    ]);
    const team = j.profiles.find((p: { name: string }) => p.name === "team");
    expect(team).toEqual({
      name: "team",
      active: false,
      source: "global",
      file: join(h.sb.dispatchHome, "profiles", "team.yaml"),
      description: "team rules",
      rules: 1,
    });
  });

  it("a trusted repo profile is listed with source repo", async () => {
    const h = harness();
    const repo = h.sb.repo("proj", { ".dispatch/profiles/mine.yaml": TEAM_PROFILE });
    await h.run(["trust"], { cwd: repo });
    const j = JSON.parse((await h.run(["profiles", "--json"], { cwd: repo })).out);
    expect(j.profiles.find((p: { name: string }) => p.name === "mine")).toMatchObject({
      source: "repo",
      file: join(repo, ".dispatch", "profiles", "mine.yaml"),
    });
  });
});

describe("use", () => {
  it("writes the global profile, keeping comments, and creating the file when absent", async () => {
    const h = harness();
    const created = await h.run(["use", "preserve"]);
    expect(created.code).toBe(0);
    expect(created.out).toContain("Active profile: balance -> preserve");
    const file = join(h.sb.dispatchHome, "config.yaml");
    expect(readFileSync(file, "utf8")).toBe("version: 1\nprofile: preserve\n");

    h.sb.global("# my settings\nversion: 1\nprofile: preserve # current\nautonomy: worktree\n");
    const r = await h.run(["use", "specialize", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({
      profile: "specialize",
      previous: "preserve",
      scope: "global",
      retrusted: false,
    });
    expect(readFileSync(file, "utf8")).toBe(
      "# my settings\nversion: 1\nprofile: specialize # current\nautonomy: worktree\n",
    );
    expect(JSON.parse((await h.run(["profiles", "--json"])).out).active).toBe("specialize");
  });

  it("rejects an unknown profile with exit 2 and leaves the config alone", async () => {
    const h = harness();
    const r = await h.run(["use", "nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('unknown profile "nope" (known: balance, off, preserve, specialize)');
    expect((await h.run(["profiles", "--json"])).out).toContain('"active": "balance"');
  });

  it("a trusted repo that sets profile is edited in place and re-trusted", async () => {
    const h = harness();
    const repo = h.sb.repo("proj", {
      ".dispatch/config.yaml": "# repo policy\nversion: 1\nprofile: balance # team default\n",
    });
    expect((await h.run(["trust"], { cwd: repo })).code).toBe(0);

    const r = await h.run(["use", "preserve"], { cwd: repo });
    expect(r.code).toBe(0);
    expect(r.out).toContain("repo config");
    expect(r.out).toContain("Repo policy re-trusted.");
    expect(readFileSync(join(repo, ".dispatch", "config.yaml"), "utf8")).toBe(
      "# repo policy\nversion: 1\nprofile: preserve # team default\n",
    );

    // Still trusted: the new profile applies and nothing warns.
    const after = await h.run(["profiles", "--json"], { cwd: repo });
    expect(JSON.parse(after.out).active).toBe("preserve");
    expect(after.err).toBe("");
    // The global config was not touched.
    expect(JSON.parse((await h.run(["profiles", "--json"])).out).active).toBe("balance");
  });

  it("a trusted repo that does not set profile leaves the repo alone and writes the global one", async () => {
    const h = harness();
    const repo = h.sb.repo("proj", {
      ".dispatch/config.yaml": "version: 1\nautonomy: read-only\n",
    });
    await h.run(["trust"], { cwd: repo });
    const r = JSON.parse((await h.run(["use", "off", "--json"], { cwd: repo })).out);
    expect(r).toMatchObject({ scope: "global", retrusted: false });
    expect(readFileSync(join(repo, ".dispatch", "config.yaml"), "utf8")).toBe(
      "version: 1\nautonomy: read-only\n",
    );
  });

  it("refuses to edit a global config that is not valid YAML", async () => {
    const h = harness();
    h.sb.global("profile: [oops\n");
    const r = await h.run(["use", "off"]);
    expect(r.code).toBe(2);
  });
});

describe("providers", () => {
  it("--json lists the instances with adapter facts", async () => {
    const h = harness();
    const j = JSON.parse((await h.run(["providers", "--json"])).out);
    expect(j.host).toBeNull();
    expect(j.providers.map((p: { id: string }) => p.id)).toEqual([
      "claude",
      "codex",
      "antigravity",
    ]);
    const [claude, , agy] = j.providers;
    expect(claude).toEqual({
      id: "claude",
      adapter: "claude",
      enabled: true,
      pool: "subscription",
      plan: null,
      configDir: null,
      maxAutonomy: "worktree",
      host: false,
      known: true,
      experimental: false,
      adapterVersion: expect.stringMatching(/^\d+\.\d+\.\d+$/),
      cliRange: expect.any(String),
    });
    expect(agy).toMatchObject({ enabled: false, experimental: true, maxAutonomy: "read-only" });
  });

  it("text output tags enabled/disabled, experimental and the host", async () => {
    const h = harness();
    const r = await h.run(["providers"], { env: { CLAUDECODE: "1" } });
    expect(r.out).toMatch(
      /^claude {2}adapter claude \S+ \(cli [^)]+\) {2}enabled, subscription, host$/m,
    );
    expect(r.out).toMatch(/^antigravity .*disabled, subscription, experimental$/m);
  });

  it("[UC12] a claude-alt instance is the host when CLAUDE_CONFIG_DIR matches its config_dir", async () => {
    const h = harness();
    h.sb.global(
      `version: 1\nproviders:\n  claude-alt:\n    adapter: claude\n    config_dir: ${join(h.sb.home, ".claude-alt")}\n    plan: max5x\n`,
    );
    const alt = JSON.parse(
      (
        await h.run(["providers", "--json"], {
          env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: join(h.sb.home, ".claude-alt") },
        })
      ).out,
    );
    expect(alt.host).toBe("claude-alt");
    expect(alt.providers.find((p: { id: string }) => p.id === "claude-alt")).toMatchObject({
      host: true,
      plan: "max5x",
      configDir: join(h.sb.home, ".claude-alt"),
    });

    const main = JSON.parse(
      (await h.run(["providers", "--json"], { env: { CLAUDECODE: "1" } })).out,
    );
    expect(main.host).toBe("claude");
    const other = JSON.parse(
      (
        await h.run(["providers", "--json"], {
          env: { CLAUDECODE: "1", CLAUDE_CONFIG_DIR: join(h.sb.home, ".claude") },
        })
      ).out,
    );
    expect(other.host).toBe("claude");
  });

  it("flags an adapter Dispatch does not ship", async () => {
    const h = harness();
    h.sb.global("version: 1\nproviders:\n  mystery:\n    adapter: mystery\n    config_dir: ~/m\n");
    const text = (await h.run(["providers"])).out;
    expect(text).toContain(
      "mystery  adapter mystery  enabled, subscription, unknown adapter  config_dir ~/m",
    );
    const j = JSON.parse((await h.run(["providers", "--json"])).out);
    expect(j.providers.at(-1)).toMatchObject({
      known: false,
      experimental: null,
      adapterVersion: null,
      cliRange: null,
    });
  });
});

describe("trust", () => {
  it("[SEC-trust] trust, then edit the config: explain warns that the policy is ignored", async () => {
    const h = harness();
    const repo = h.sb.repo("proj", { ".dispatch/config.yaml": "version: 1\nprofile: off\n" });
    const task = ["explain", "--task", "x"];

    // Untrusted: ignored, with a hint.
    const before = await h.run(task, { cwd: repo });
    expect(before.err).toContain("warning: trust: repo policy ignored: run `dispatch trust`");
    expect(before.out).toContain("profile balance,");

    const trusted = await h.run(["trust"], { cwd: repo });
    expect(trusted.code).toBe(0);
    expect(trusted.out).toMatch(
      /^Trusted .*\nhash [0-9a-f]{64}\n {2}[0-9a-f]{12} {2}\.dispatch\/config\.yaml\n$/,
    );
    const applied = await h.run(task, { cwd: repo });
    expect(applied.err).toBe("");
    expect(applied.out).toContain("profile off,");

    writeFiles(repo, { ".dispatch/config.yaml": "version: 1\nprofile: preserve\n" });
    const after = await h.run(task, { cwd: repo });
    expect(after.code).toBe(0);
    expect(after.err).toContain("changed since `dispatch trust`: .dispatch/config.yaml");
    expect(after.out).toContain("profile balance,");
  });

  it("--json prints the repo id, hash, time and one entry per file", async () => {
    const h = harness();
    const repo = h.sb.repo("proj", {
      ".dispatch/config.yaml": "version: 1\n",
      ".dispatch/profiles/a.yaml": TEAM_PROFILE,
    });
    const j = JSON.parse((await h.run(["trust", "--json"], { cwd: repo })).out);
    expect(j.repoId).toBe(join(repo, ".git"));
    expect(j.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(j.trustedAt).toBe("2026-11-07T10:00:00.000Z");
    expect(j.files.map((f: { path: string }) => f.path)).toEqual([
      ".dispatch/config.yaml",
      ".dispatch/profiles/a.yaml",
    ]);
  });

  it("exits 2 outside a repository or without policy files", async () => {
    const h = harness();
    const outside = await h.run(["trust"]);
    expect(outside.code).toBe(2);
    expect(outside.err).toContain("not inside a git repository");
    const empty = await h.run(["trust"], { cwd: h.sb.repo("empty") });
    expect(empty.code).toBe(2);
    expect(empty.err).toContain("no .dispatch/ policy files");
  });
});
