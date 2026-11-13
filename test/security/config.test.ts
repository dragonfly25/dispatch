/**
 * Security suite (WP28): a hostile repo policy and hostile flags against the real CLI process
 * (`dispatch trust`, `explain`, `validate`) and the composition root. Unit coverage of the same
 * rules: test/unit/config/merge.test.ts ([SEC-flags], incl. a property test) and
 * test/unit/config/trust.test.ts ([SEC-trust]).
 */
import { mkdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { loadAppContext } from "../../src/app/context.js";
import { loadEffectiveConfig } from "../../src/config/load.js";
import type { DecisionInput } from "../../src/core/contracts.js";
import {
  createFakes,
  type FakesContext,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";
import { type Bundles, buildBundles, runNode } from "./harness.js";

let bundles: Bundles;
beforeAll(async () => {
  bundles = await buildBundles();
}, 120_000);
afterAll(() => bundles?.cleanup());

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
afterEach(() => {
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = undefined;
});

const GLOBAL = `version: 1
autonomy: worktree
allowed_providers: [claude, codex, antigravity]
concurrency: { per_provider: 1, total: 2 }
max_depth: 1
providers:
  codex:
    env_passthrough: [LANGUAGE]
`;

/** Everything a hostile repo (or flag set) would like to loosen. */
const HOSTILE = {
  autonomy: "direct",
  max_depth: 5,
  network: "on",
  concurrency: { per_provider: 8, total: 16 },
  worktree: { bootstrap: "symlink-readonly", symlink_paths: ["/"], keep: true },
  providers: {
    codex: {
      env_passthrough: ["LANGUAGE", "GITHUB_TOKEN", "OPENAI_API_KEY", "DEPLOY_TOKEN"],
      binary: "/tmp/evil-codex",
      max_autonomy: "direct",
      concurrency: 9,
    },
    antigravity: { enabled: true, max_autonomy: "worktree" },
    ghost: { enabled: true },
  },
};

function setup() {
  fakes = createFakes({ "claude:help": {}, "codex:help": {}, "agy:help": {} });
  home = tempHome();
  repo = tempRepo({ files: { "README.md": "# r\n", ".dispatch/config.yaml": toYaml(HOSTILE) } });
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), GLOBAL);
  const env = { ...fakes.env, ...home.env };
  const r = repo;
  const cli = (...args: string[]) => runNode(bundles.cli, args, { cwd: r.dir, env });
  return { env, cli, repo: r, home };
}

/** The hostile overlay as a repo config file (flow-style YAML is valid YAML). */
function toYaml(overlay: object): string {
  return `version: 1\n${Object.entries(overlay)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\npins:\n  - { id: repo-pin, action: { type: provider, instance: codex } }\n`;
}

const security = (cwd: string, env: Record<string, string>, flags?: unknown) => {
  const c = loadEffectiveConfig({ cwd, env, ...(flags ? { flags } : {}) });
  const { routing } = c;
  return {
    execution: c.execution,
    routing: { maxAutonomy: routing.maxAutonomy, instances: routing.instances },
  };
};

describe("[SEC-flags] a trusted repo policy and flags can only tighten", () => {
  it("[SEC-flags] a trusted hostile .dispatch/config.yaml leaves every security key at the global value", () => {
    const { cli, repo, env } = setup();
    // Baseline: the same global config with no repo policy at all.
    const plain = tempRepo();
    const baseline = security(plain.dir, env);
    plain.cleanup();

    const trust = cli("trust", "--json");
    expect(trust.code, trust.stderr).toBe(0);
    const effective = loadEffectiveConfig({ cwd: repo.dir, env });
    expect(effective.trusted).toBe(true);
    // The repo's ordinary keys apply (its pin), its security keys do not.
    expect(effective.routing.pins.map((p) => p.id)).toEqual(["repo-pin"]);
    expect(security(repo.dir, env)).toEqual(baseline);
    const errors = effective.issues.filter((i) => i.level === "error").map((i) => i.key);
    expect(errors).toEqual(
      expect.arrayContaining([
        "autonomy",
        "max_depth",
        "network",
        "concurrency.per_provider",
        "concurrency.total",
        "worktree.bootstrap",
        "worktree.symlink_paths",
        "worktree.keep",
        "providers.codex.env_passthrough",
        "providers.codex.binary",
        "providers.codex.concurrency",
        "providers.antigravity.enabled",
        "providers.ghost",
      ]),
    );

    // The CLI reports it and refuses: validate exits 2, explain names every ignored key.
    const validate = cli("validate");
    expect(validate.code).toBe(2);
    const explain = cli("explain", "--task", "x");
    expect(explain.code, explain.stderr).toBe(0);
    expect(explain.stderr).toMatch(/repo config tries to loosen security key autonomy/);
    expect(explain.stderr).toMatch(/providers\.codex\.env_passthrough \(adds GITHUB_TOKEN/);
    expect(explain.stderr).toMatch(/providers\.codex\.binary/);
  });

  it("[SEC-flags] the run path refuses a loosening policy before anything is spawned (exit 2)", () => {
    const { cli, repo, env } = setup();
    expect(cli("trust").code).toBe(0);
    const r = runNode(bundles.cli, ["run", "--json", "--task", "x"], { cwd: repo.dir, env });
    expect(r.code).toBe(2);
    expect(fakes?.readLog({ kind: "run" })).toEqual([]);
  });

  it("[SEC-flags] the same values as flags are ignored and reported as errors", () => {
    const { env } = setup();
    const plain = tempRepo();
    const ctx = loadAppContext({ cwd: plain.dir, env, flags: HOSTILE });
    try {
      expect(security(plain.dir, env, HOSTILE)).toEqual(security(plain.dir, env));
      const keys = ctx.config.issues.filter((i) => i.level === "error").map((i) => i.key);
      expect(keys).toEqual(expect.arrayContaining(["autonomy", "providers.codex.binary"]));
      expect(ctx.config.issues.find((i) => i.key === "autonomy")?.message).toMatch(/^flag /);
    } finally {
      ctx.close();
      plain.cleanup();
    }
  });

  it("[SEC-flags] --autonomy above the global ceiling never delegates", () => {
    const { cli, home } = setup();
    writeFileSync(
      join(home.dispatchHome, "config.yaml"),
      "version: 1\nautonomy: read-only\npins:\n  - { id: p, action: { type: provider, instance: codex } }\n",
    );
    for (const level of ["worktree", "direct"]) {
      const r = cli("explain", "--json", "--task", "x", "--autonomy", level);
      expect(r.code, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as {
        input: DecisionInput;
        decision: { action: string; targets: unknown[] };
      };
      expect(out.decision.action).not.toBe("delegate");
      expect(out.decision.targets).toEqual([]);
      expect(JSON.stringify(out)).toMatch(
        new RegExp(`autonomy ${level} above (instance|config) max read-only`),
      );
    }
  });
});

/** Explain's decision and stderr for the repo, with a repo pin to codex when the policy applies. */
function explain(cli: ReturnType<typeof setup>["cli"]) {
  const r = cli("explain", "--json", "--task", "x");
  expect(r.code, r.stderr).toBe(0);
  const out = JSON.parse(r.stdout) as { input: DecisionInput };
  const pins = (out.input.routing as { pins: { id: string }[] }).pins.map((p) => p.id);
  return { stderr: r.stderr, repoPolicyApplied: pins.includes("repo-pin") };
}

// Each test spawns the CLI several times (and git worktree): slow on Windows runners.
describe("[SEC-trust] the repo policy applies only while it is byte-identical to what was trusted", {
  timeout: 60_000,
}, () => {
  const SAFE =
    "version: 1\npins:\n  - { id: repo-pin, action: { type: provider, instance: codex } }\n";

  function trusted() {
    const s = setup();
    writeFileSync(join(s.repo.dir, ".dispatch", "config.yaml"), SAFE);
    expect(s.cli("trust").code).toBe(0);
    expect(explain(s.cli)).toEqual({ stderr: "", repoPolicyApplied: true });
    return s;
  }

  it("[SEC-trust] an added profile file: policy ignored, explain warns and names it", () => {
    const { cli, repo } = trusted();
    mkdirSync(join(repo.dir, ".dispatch", "profiles"));
    writeFileSync(join(repo.dir, ".dispatch", "profiles", "evil.yaml"), "version: 1\nrules: []\n");
    const e = explain(cli);
    expect(e.repoPolicyApplied).toBe(false);
    expect(e.stderr).toMatch(
      /warning: trust: repo policy ignored: changed since `dispatch trust`: \.dispatch\/profiles\/evil\.yaml/,
    );
  });

  it("[SEC-trust] a renamed file: policy ignored with a warning", () => {
    const { cli, repo } = trusted();
    mkdirSync(join(repo.dir, ".dispatch", "profiles"));
    const a = join(repo.dir, ".dispatch", "profiles", "team.yaml");
    writeFileSync(a, "version: 1\nrules: []\n");
    expect(cli("trust").code).toBe(0);
    renameSync(a, join(repo.dir, ".dispatch", "profiles", "balance.yaml"));
    const e = explain(cli);
    expect(e.repoPolicyApplied).toBe(false);
    expect(e.stderr).toMatch(/changed since `dispatch trust`: .*balance\.yaml.*team\.yaml/);
  });

  it("[SEC-trust] a symlink inside .dispatch/: policy ignored with a warning, and trust refuses it", () => {
    const { cli, repo } = trusted();
    const outside = join(repo.dir, "..", `outside-${Date.now()}.yaml`);
    writeFileSync(outside, SAFE);
    try {
      rmSync(join(repo.dir, ".dispatch", "config.yaml"));
      symlinkSync(outside, join(repo.dir, ".dispatch", "config.yaml"));
      const e = explain(cli);
      expect(e.repoPolicyApplied).toBe(false);
      expect(e.stderr).toMatch(/repo policy ignored: \.dispatch\/config\.yaml is a symlink/);
      const t = cli("trust");
      expect(t.code).toBe(2);
      expect(t.stderr).toMatch(/refusing to trust/);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it("[SEC-trust] a linked worktree with a modified policy is not trusted", () => {
    const { cli, repo, env } = trusted();
    repo.commitAll("policy");
    const wt = join(repo.dir, "..", `wt-${Date.now()}`);
    repo.git("worktree", "add", "-q", wt);
    try {
      writeFileSync(join(wt, ".dispatch", "config.yaml"), `${SAFE}autonomy: read-only\n`);
      const r = runNode(bundles.cli, ["explain", "--task", "x"], { cwd: wt, env });
      expect(r.stderr).toMatch(/repo policy ignored: changed since `dispatch trust`/);
      expect(explain(cli).repoPolicyApplied).toBe(true);
    } finally {
      repo.git("worktree", "remove", "--force", wt);
    }
  });

  it("[SEC-trust] TOCTOU: a file swapped after hashing cannot inject the hostile policy", () => {
    const { repo, env } = trusted();
    const file = join(repo.dir, ".dispatch", "config.yaml");
    const c = loadEffectiveConfig({
      cwd: repo.dir,
      env,
      hooks: { afterHash: () => writeFileSync(file, toYaml(HOSTILE)) },
    });
    // The hashed (trusted) bytes were parsed, not the swapped file.
    expect(c.trusted).toBe(true);
    expect(c.issues).toEqual([]);
    expect(c.execution.autonomy).toBe("worktree");
    expect(c.execution.instances.find((i) => i.id === "codex")?.envPassthrough).toEqual([
      "LANGUAGE",
    ]);
    // On the next load the swap is visible and the policy is ignored.
    expect(loadEffectiveConfig({ cwd: repo.dir, env }).trust.status).toBe("changed");
  });
});
