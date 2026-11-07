import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEffectiveConfig } from "../../../src/config/load.js";
import { trustRepo } from "../../../src/config/trust.js";
import { RoutingConfigSchema } from "../../../src/core/routing.js";
import { sandbox, writeFiles } from "./helpers.js";

const NOW = new Date("2026-11-07T10:00:00.000Z");

function trustedRepo(files: Record<string, string>, global = "version: 1\n") {
  const sb = sandbox();
  sb.global(global);
  const repo = sb.repo("repo", files);
  trustRepo({ cwd: repo, env: sb.env, now: NOW });
  return {
    sb,
    repo,
    load: (flags?: unknown) => loadEffectiveConfig({ cwd: repo, env: sb.env, flags }),
  };
}

describe("loadEffectiveConfig: defaults", () => {
  it("[AC3] [UC6] produces a valid RoutingConfig with built-in defaults (unspecified → balanced)", () => {
    const sb = sandbox();
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(() => RoutingConfigSchema.parse(cfg.routing)).not.toThrow();
    const r = cfg.routing;
    expect(r.unspecifiedModel).toBe("balanced");
    expect(r.tiers).toEqual(["fast", "balanced", "max"]);
    expect(r.efforts).toEqual(["low", "medium", "high"]);
    expect(r.activeProfile).toBe("balance");
    expect(r.activePreset).toBe("mirror");
    expect(Object.keys(r.profiles).sort()).toEqual(["balance", "off", "preserve", "specialize"]);
    expect(Object.keys(r.presets).sort()).toEqual(["custom", "economy", "mirror"]);
    expect(r.presets.economy?.effortShift).toBe(-1);
    expect(Object.keys(r.models).sort()).toEqual(["antigravity", "claude", "codex"]);
    expect(r.models.claude?.tiers.max?.relativeCost).toBe(10);
    expect(r.profiles.specialize?.rules[0]?.match).toEqual({ taskType: ["test"] });
    expect(r.instances.find((i) => i.id === "antigravity")).toMatchObject({
      enabled: false,
      maxAutonomy: "read-only",
    });
    expect(r.maxAutonomy).toBe("worktree");
    expect(r.provenance.unspecifiedModel).toBe("default");
    expect(cfg.trusted).toBe(false);
    expect(cfg.trust.status).toBe("none");
    expect(cfg.issues).toEqual([]);
    expect(cfg.execution).toMatchObject({
      maxDepth: 1,
      network: "off",
      concurrency: { perProvider: 2, total: 4 },
      worktree: { bootstrap: "none", symlinkPaths: [], keep: false },
      timeouts: { defaultTaskMs: 600000 },
      quota: { cacheMinutes: 5, readers: {} },
      retentionDays: 30,
    });
  });

  it("reads retention_days from the global config", () => {
    const sb = sandbox();
    sb.global("version: 1\nretention_days: 7\n");
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(cfg.execution.retentionDays).toBe(7);
  });

  it("uses $DISPATCH_HOME over $HOME", () => {
    const sb = sandbox();
    writeFiles(sb.root, { "dh/config.yaml": "version: 1\nprofile: off\n" });
    const cfg = loadEffectiveConfig({
      cwd: sb.home,
      env: { ...sb.env, DISPATCH_HOME: join(sb.root, "dh") },
    });
    expect(cfg.routing.activeProfile).toBe("off");
    expect(cfg.provenance.profile).toBe("global");
  });

  it("[UC6] unspecified_model can be set to inherit; an unknown tier falls back to balanced", () => {
    const sb = sandbox();
    sb.global("version: 1\nunspecified_model: inherit\n");
    expect(loadEffectiveConfig({ cwd: sb.home, env: sb.env }).routing.unspecifiedModel).toBe(
      "inherit",
    );
    sb.global("version: 1\nunspecified_model: huge\n");
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(cfg.routing.unspecifiedModel).toBe("balanced");
    expect(cfg.issues[0]).toMatchObject({ level: "error", key: "unspecified_model" });
  });
});

describe("loadEffectiveConfig: global config", () => {
  it("[UC12] two instances of the same adapter, each with its own config dir", () => {
    const sb = sandbox();
    sb.global(`version: 1
providers:
  claude: { plan: max, config_dir: /x/claude }
  claude-alt:
    adapter: claude
    pool: api_credit
    config_dir: /x/claude-alt
    env_passthrough: [ANTHROPIC_BASE_URL]
    concurrency: 1
    max_autonomy: read-only
    effort_shift: -1
`);
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    const alt = cfg.routing.instances.find((i) => i.id === "claude-alt");
    expect(alt).toMatchObject({
      adapter: "claude",
      pool: "api_credit",
      enabled: true,
      maxAutonomy: "read-only",
      concurrency: 1,
      effortShift: -1,
    });
    const exec = cfg.execution.instances.filter((i) => i.adapter === "claude");
    expect(exec.map((i) => [i.id, i.configDir])).toEqual([
      ["claude", "/x/claude"],
      ["claude-alt", "/x/claude-alt"],
    ]);
    expect(exec[0]?.plan).toBe("max");
    expect(exec[1]?.envPassthrough).toEqual(["ANTHROPIC_BASE_URL"]);
    expect(cfg.routing.provenance.instances).toBe("global");
  });

  it("allowed_providers disables the other instances; autonomy caps every instance", () => {
    const sb = sandbox();
    sb.global("version: 1\nallowed_providers: [codex]\nautonomy: read-only\n");
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    const byId = Object.fromEntries(cfg.routing.instances.map((i) => [i.id, i]));
    expect(byId.claude?.enabled).toBe(false);
    expect(byId.codex).toMatchObject({ enabled: true, maxAutonomy: "read-only" });
  });

  it("throws a usage error on an invalid global file", () => {
    const sb = sandbox();
    sb.global("version: 1\nautonomy: yolo\n");
    expect(() => loadEffectiveConfig({ cwd: sb.home, env: sb.env })).toThrow(/autonomy/);
    sb.global("version: [\n");
    expect(() => loadEffectiveConfig({ cwd: sb.home, env: sb.env })).toThrow(/invalid YAML/);
    sb.global("version: 2\n");
    expect(() => loadEffectiveConfig({ cwd: sb.home, env: sb.env })).toThrow(/newer/);
  });

  it("loads user-wide profiles and mappings from the Dispatch home; bad ones are issues", () => {
    const sb = sandbox();
    sb.global("version: 1\nprofile: mine\nmappings: { preset: cheap }\n");
    writeFiles(sb.dispatchHome, {
      "profiles/mine.yaml": "version: 1\nrules: []\n",
      "profiles/broken.yaml": "version: 1\nrules: 3\n",
      "mappings/cheap.yaml":
        "version: 1\ndescription: Cheap\npreset: { effort_shift: -2, tier_by_task_type: { test: fast } }\n",
    });
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(cfg.routing.activeProfile).toBe("mine");
    expect(cfg.routing.presets.cheap).toEqual({
      description: "Cheap",
      effortShift: -2,
      tierByTaskType: { test: "fast" },
    });
    expect(cfg.routing.provenance).toMatchObject({ profiles: "global", presets: "global" });
    expect(cfg.issues.map((i) => i.key)).toEqual([join(sb.dispatchHome, "profiles/broken.yaml")]);
  });

  it("unknown profile, preset and shadow profiles are errors with safe fallbacks", () => {
    const sb = sandbox();
    sb.global(
      "version: 1\nprofile: nope\nmappings: { preset: nope }\nshadow_profiles: [off, nope]\n",
    );
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env });
    expect(cfg.routing.activeProfile).toBe("balance");
    expect(cfg.routing.activePreset).toBe("mirror");
    expect(cfg.routing.shadowProfiles).toEqual(["off"]);
    expect(cfg.provenance.profile).toBe("default");
    expect(cfg.issues.map((i) => i.key)).toEqual(["profile", "mappings.preset", "shadow_profiles"]);
  });
});

describe("loadEffectiveConfig: repo policy and flags", () => {
  const repoFiles = {
    ".dispatch/config.yaml": `version: 1
profile: team
autonomy: read-only
pins:
  - id: migrations-stay-home
    match: { paths: ["db/migrations/**"] }
    action: { type: host }
mappings:
  direct:
    - { from_model: "claude-opus-*", from_effort: high, instance: codex, model: gpt-6, effort: xhigh }
`,
    ".dispatch/profiles/team.yaml": `version: 1
description: Team profile
rules:
  - id: low-quota
    match: { min_remaining_pct: { codex: 30 }, reliability: [real], prior_outcome: [failed], tier: [fast], autonomy: [worktree] }
    action: { type: provider, instance: codex }
`,
    ".dispatch/mappings/models.yaml": `version: 1
models:
  codex:
    tiers: { fast: { model: tiny, effort: { low: minimal }, relative_cost: 1 } }
    reverse: []
`,
  };

  it("[UC5] applies a trusted repo: pins, direct mappings, profile, models, tightened autonomy", () => {
    const { load } = trustedRepo(repoFiles);
    const cfg = load();
    expect(cfg.trusted).toBe(true);
    expect(cfg.issues).toEqual([]);
    const r = cfg.routing;
    expect(r.pins).toEqual([
      {
        id: "migrations-stay-home",
        match: { paths: ["db/migrations/**"] },
        action: { type: "host" },
      },
    ]);
    expect(r.directMappings).toEqual([
      {
        fromModel: "claude-opus-*",
        fromEffort: "high",
        instance: "codex",
        model: "gpt-6",
        effort: "xhigh",
      },
    ]);
    expect(r.activeProfile).toBe("team");
    expect(r.profiles.team?.rules[0]?.match).toEqual({
      minRemainingPct: { codex: 30 },
      reliability: ["real"],
      priorOutcome: ["failed"],
      tier: ["fast"],
      autonomy: ["worktree"],
    });
    expect(r.models.codex?.tiers).toEqual({
      fast: { model: "tiny", effort: { low: "minimal" }, relativeCost: 1 },
    });
    expect(r.maxAutonomy).toBe("read-only");
    expect(r.instances.every((i) => i.maxAutonomy === "read-only")).toBe(true);
    expect(r.provenance).toMatchObject({
      pins: "repo",
      directMappings: "repo",
      activeProfile: "repo",
      profiles: "repo",
      models: "repo",
      maxAutonomy: "repo",
    });
  });

  it("flags override ordinary keys and may only tighten security keys", () => {
    const { load } = trustedRepo(repoFiles);
    const cfg = load({ profile: "off", autonomy: "direct", max_depth: 0 });
    expect(cfg.routing.activeProfile).toBe("off");
    expect(cfg.routing.maxAutonomy).toBe("read-only");
    expect(cfg.execution.maxDepth).toBe(0);
    expect(cfg.provenance).toMatchObject({ profile: "flag", autonomy: "repo", max_depth: "flag" });
    expect(cfg.issues).toEqual([
      expect.objectContaining({
        level: "error",
        key: "autonomy",
        message: expect.stringMatching(/^flag/),
      }),
    ]);
  });

  it("invalid flags are reported and ignored", () => {
    const sb = sandbox();
    const cfg = loadEffectiveConfig({ cwd: sb.home, env: sb.env, flags: { autonomy: "yolo" } });
    expect(cfg.routing.maxAutonomy).toBe("worktree");
    expect(cfg.issues[0]).toMatchObject({ level: "error", key: "flags" });
  });

  it("an untrusted repo policy is ignored with a warning", () => {
    const sb = sandbox();
    const repo = sb.repo("repo", repoFiles);
    const cfg = loadEffectiveConfig({ cwd: repo, env: sb.env });
    expect(cfg.trusted).toBe(false);
    expect(cfg.trust.status).toBe("untrusted");
    expect(cfg.trust.repoId).toBe(join(repo, ".git"));
    expect(cfg.routing.pins).toEqual([]);
    expect(cfg.issues).toEqual([
      expect.objectContaining({
        level: "warning",
        key: "trust",
        message: expect.stringMatching(/dispatch trust/),
      }),
    ]);
  });

  it("a changed or symlinked policy is ignored and the issue names the cause", () => {
    const { sb, repo, load } = trustedRepo(repoFiles);
    writeFiles(repo, { ".dispatch/profiles/team.yaml": "version: 1\nrules: []\n" });
    const changed = load();
    expect(changed.trusted).toBe(false);
    expect(changed.routing.activeProfile).toBe("balance");
    expect(changed.issues[0]?.message).toContain(".dispatch/profiles/team.yaml");
    expect(changed.trust.changed).toEqual([".dispatch/profiles/team.yaml"]);

    const other = sb.repo("other", { ".dispatch/config.yaml": "version: 1\n" });
    symlinkSync("/etc/hosts", join(other, ".dispatch/link"));
    const cfg = loadEffectiveConfig({ cwd: other, env: sb.env });
    expect(cfg.trust.status).toBe("symlink");
    expect(cfg.issues[0]?.message).toMatch(/\.dispatch\/link is a symlink/);
  });

  it("invalid trusted repo files become issues; the rest of the policy still applies", () => {
    const { load } = trustedRepo({
      ".dispatch/config.yaml": "version: 1\nproviders: { codex: { pool: api_credit } }\n",
      ".dispatch/profiles/ok.yaml": "version: 1\nrules: []\n",
      ".dispatch/mappings/bad.yaml": "version: 7\n",
    });
    const cfg = load();
    expect(cfg.trusted).toBe(true);
    expect(cfg.issues.map((i) => i.key)).toEqual([
      ".dispatch/config.yaml",
      ".dispatch/mappings/bad.yaml",
    ]);
    expect(cfg.routing.profiles.ok).toEqual({ rules: [] });
  });
});
