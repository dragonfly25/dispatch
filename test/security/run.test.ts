/**
 * Security suite (WP28), end to end: the real composition (config loader → composition root →
 * runner → adapters → process supervisor → patch pipeline → state store) runs as its own `node`
 * process against fake CLIs, a temp HOME and a temp repo. Unit-level coverage of the same
 * mechanisms lives next to each module (see docs/security.md, "Where it is tested").
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type RunResult, RunResultSchema } from "../../src/core/contracts.js";
import {
  createFakes,
  FAKE_LEAKS,
  type FakeScenarioMap,
  type FakesContext,
  snapshotTree,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";
import { type Bundles, buildBundles, type NodeRun, runNode } from "./harness.js";

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

/** A pin sending every task to `instance`. */
/** `<cli> --help` answers with the fake's built-in flag list, so the real probes pass. */
const HELP: FakeScenarioMap = { "claude:help": {}, "codex:help": {}, "agy:help": {} };

const pinTo = (instance: string) =>
  `pins:\n  - id: sec-pin\n    action: { type: provider, instance: ${instance} }\n`;

interface Setup {
  scenarios: FakeScenarioMap;
  /** Global config body after `version: 1` (default: pin to codex). */
  global?: string;
  env?: Record<string, string>;
  /** Commit a `.dispatch/` folder so run dirs live in the repo (like an installed repo). */
  installed?: boolean;
}

function setup(o: Setup) {
  fakes = createFakes({ ...HELP, ...o.scenarios });
  home = tempHome();
  repo = tempRepo({
    files: {
      "math.js": "function add(a, b) {\n  return a + b;\n}\n",
      ...(o.installed ? { ".dispatch/.gitignore": "state/\n" } : {}),
    },
  });
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(
    join(home.dispatchHome, "config.yaml"),
    `version: 1\n${o.global ?? pinTo("codex")}`,
  );
  const env = { ...fakes.env, ...home.env, ...o.env };
  const h = home;
  const r = repo;
  const f = fakes;
  const run = (args: string[] = [], trace?: string): NodeRun & { result?: RunResult } => {
    const out = runNode(bundles.cli, ["run", "--json", "--task", "add sub to math.js", ...args], {
      cwd: r.dir,
      env,
      ...(trace ? { trace } : {}),
    });
    let result: RunResult | undefined;
    try {
      result = RunResultSchema.parse(JSON.parse(out.stdout));
    } catch {
      result = undefined;
    }
    return { ...out, ...(result ? { result } : {}) };
  };
  return { env, run, home: h, repo: r, fakes: f };
}

/** Every regular file below `dir` (recursively), absolute paths. */
function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((rel) => join(dir, rel))
    .filter((p) => statSync(p).isFile());
}

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("[SEC-patch] escape attempts through `dispatch run --json`", () => {
  it("[SEC-patch] escape_writes: forbidden paths are rejected, the user tree and .git/hooks are untouched", () => {
    const { run, repo } = setup({
      scenarios: { codex: [{ scenario: "escape_writes", pinnedPath: "notes.txt" }] },
    });
    const before = snapshotTree(repo.dir);
    const hooksBefore = snapshotTree(join(repo.dir, ".git", "hooks"));
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const res = r.result as RunResult;
    expect(res.status).toBe("completed");
    const patch = res.patch;
    expect(patch?.rejectedPaths).toEqual(
      expect.arrayContaining([".dispatch/config.yaml", ".claude/settings.json"]),
    );
    const diff = readFileSync(patch?.path ?? "", "utf8");
    expect(diff).toContain("b/notes.txt");
    for (const bad of [".dispatch/", ".claude/", ".git/", "outside.txt", "abs.txt", "pre-commit"]) {
      expect(diff).not.toContain(bad);
    }
    expect(snapshotTree(join(repo.dir, ".git", "hooks"))).toEqual(hooksBefore);
    expect(snapshotTree(repo.dir)).toEqual(before);
    expect(repo.git("status", "--porcelain")).toBe("");
  });

  it("[SEC-patch] symlink: links out of the worktree never reach the patch", () => {
    const { run, repo } = setup({
      scenarios: {
        codex: [
          {
            scenario: "symlink",
            links: { link: "/etc/passwd", link2: "../..", "math.js": "/etc/hosts" },
          },
        ],
      },
    });
    const before = snapshotTree(repo.dir);
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const res = r.result as RunResult;
    expect(res.status).toBe("completed");
    // Every change is rejected: no patch file, but the result still names what was dropped.
    expect(res.patch).toMatchObject({ diffstat: "", applies: false });
    expect(res.patch?.rejectedPaths.sort()).toEqual(["link", "link2", "math.js"]);
    expect(existsSync(res.patch?.path ?? "")).toBe(false);
    expect(snapshotTree(repo.dir)).toEqual(before);
  });
});

const CANARY = "canary-SEC-env-0123456789";
const PARENT_CANARIES: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-api03-CANARYparentenv0123456789abcdef",
  OPENAI_API_KEY: "sk-proj-CANARYparentenv0123456789abcdef",
  GITHUB_TOKEN: "ghp_CANARYparentenv0123456789abcdefghij",
  CANARY_SECRET: CANARY,
  NODE_OPTIONS: "--require /nonexistent/CANARY-node-options.js",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "cli",
  CODEX_THREAD_ID: "CANARY-codex-thread-id",
};

describe("[SEC-env] child environment", () => {
  it("[SEC-env] the child sees no parent secret or host marker, and DISPATCH_DEPTH=1", () => {
    // NODE_OPTIONS would also load into Dispatch itself; it is set only on the child-facing check.
    const { NODE_OPTIONS: _n, ...parent } = PARENT_CANARIES;
    const { run, fakes } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
      env: { ...parent },
    });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const child = fakes.readLog({ cli: "codex", kind: "run" })[0];
    expect(child).toBeDefined();
    const env = child?.env ?? {};
    for (const name of Object.keys(PARENT_CANARIES)) expect(env[name]).toBeUndefined();
    const values = Object.values(env).join("\n");
    for (const v of Object.values(parent)) if (v.length > 3) expect(values).not.toContain(v);
    expect(env.DISPATCH_DEPTH).toBe("1");
    expect(env.DISPATCH_RUN_ID).toBe(r.result?.runId);
    // Probes get an allow-listed env too.
    for (const probe of fakes.readLog({ kind: "subcommand" })) {
      for (const name of Object.keys(PARENT_CANARIES)) expect(probe.env[name]).toBeUndefined();
    }
  });

  it("[SEC-env] NODE_OPTIONS in the parent never reaches the child", () => {
    const { run, fakes } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
      // A harmless value Node accepts in the Dispatch process itself.
      env: { NODE_OPTIONS: "--max-old-space-size=4096" },
    });
    expect(run().code).toBe(0);
    expect(fakes.readLog({ cli: "codex", kind: "run" })[0]?.env.NODE_OPTIONS).toBeUndefined();
  });
});

describe("[SEC-recursion] nested dispatch", () => {
  it("[SEC-recursion] a child calling dispatch again is refused (exit 3); the outer run completes", () => {
    const { run, fakes, home } = setup({ scenarios: {} });
    const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
    const inner = `${q(process.execPath)} --disable-warning=ExperimentalWarning ${q(bundles.cli)} run --json --task inner`;
    fakes.setScenarios({ ...HELP, codex: [{ scenario: "recurse", command: inner }] });
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    expect(r.result?.status).toBe("completed");
    const rec = fakes.readLog({ cli: "codex", kind: "run" })[0]?.recurse;
    expect(rec?.exitCode).toBe(3);
    const innerResult = JSON.parse(rec?.stdout ?? "{}") as RunResult;
    expect(innerResult.status).toBe("rejected");
    expect(innerResult.summary).toMatch(/recursion refused: DISPATCH_DEPTH=1/);
    // The inner process decided nothing and spawned nothing.
    expect(innerResult.decisions).toEqual([]);
    expect(fakes.readLog({ cli: "codex", kind: "run" })).toHaveLength(1);
    expect(existsSync(home.dispatchHome)).toBe(true);
  });
});

/** Credential files of the three CLIs, with canary contents, in the temp HOME. */
function plantCredentials(h: TempHome): { paths: string[]; values: string[] } {
  const files: Record<string, string> = {
    ".claude/.credentials.json": `{"claudeAiOauth":{"accessToken":"sk-ant-oat01-CANARYcredfile0123456789"}}`,
    ".codex/auth.json": `{"tokens":{"access_token":"CANARY-codex-auth-token-0123456789"}}`,
    ".gemini/oauth_creds.json": `{"access_token":"CANARY-gemini-oauth-token-0123456789"}`,
  };
  const paths: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const p = join(h.home, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, text, { mode: 0o600 });
    paths.push(p);
  }
  return {
    paths,
    values: [
      "CANARYcredfile0123456789",
      "CANARY-codex-auth-token-0123456789",
      "CANARY-gemini-oauth-token-0123456789",
    ],
  };
}

describe("[SEC-redact][AC7] no credential copied, logged or read", () => {
  // claude is never a delegation target on native Windows (by design).
  it.each(process.platform === "win32" ? (["codex"] as const) : (["codex", "claude"] as const))(
    "[AC7][SEC-redact] %s leak_secret: zero canary hits in state, run dir and stdout; credential files never opened",
    (cli) => {
      const { run, home, repo } = setup({
        installed: true,
        global: pinTo(cli),
        scenarios: { [cli]: [{ scenario: "leak_secret", secret: CANARY }] },
        env: { CANARY_SECRET: CANARY },
      });
      const creds = plantCredentials(home);
      const trace = join(home.home, "fs-trace.jsonl");
      const r = run([], trace);
      expect(r.code, r.stderr).toBe(0);
      expect(r.result?.status).toBe("completed");

      const canaries = [CANARY, ...Object.values(FAKE_LEAKS), ...creds.values];
      // stdout (the RunResult JSON) and stderr.
      for (const c of canaries) {
        expect(r.stdout).not.toContain(c);
        expect(r.stderr).not.toContain(c);
      }
      // Raw bytes of every file Dispatch keeps: the SQLite db with its -wal/-shm, runs, caches,
      // and the run dir inside the repo (events log, attempt dirs, codex's -o output file).
      const kept = [
        ...filesUnder(home.dispatchHome),
        ...filesUnder(join(repo.dir, ".dispatch", "state")),
      ];
      expect(kept.some((p) => p.endsWith("dispatch.db"))).toBe(true);
      expect(kept.some((p) => p.endsWith("events.jsonl"))).toBe(true);
      for (const p of kept) {
        const bytes = readFileSync(p);
        for (const c of canaries) {
          expect(bytes.includes(Buffer.from(c)), `${c} found in ${p}`).toBe(false);
        }
      }
      // The Dispatch process never touched a credential file (children are not traced).
      const touched = readFileSync(trace, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { path: string }).path);
      expect(touched.length).toBeGreaterThan(0);
      for (const cred of creds.paths) expect(touched).not.toContain(cred);
      const credDirs = [".claude", ".codex", ".gemini"].map((d) => join(home.home, d));
      expect(touched.filter((p) => credDirs.some((d) => p.startsWith(`${d}${sep}`)))).toEqual([]);
      for (const cred of creds.paths) expect(existsSync(cred)).toBe(true);
    },
    60_000,
  );
});

describe("[SEC-agy-ro] Antigravity stays read-only even when opted in", () => {
  const AGY_ON =
    "providers:\n  antigravity:\n    enabled: true\n    tos_acknowledged: true\n" +
    "pins:\n  - id: to-agy\n    action: { type: fallback, instances: [antigravity, codex], strategy: ordered }\n";

  it("[SEC-agy-ro] a worktree task is never routed to agy, even when a rule names it first", () => {
    const { run, fakes } = setup({
      global: AGY_ON,
      scenarios: {
        agy: [{ scenario: "success_edit", file: "math.js", content: "agy\n" }],
        codex: [{ scenario: "success_edit", file: "math.js", content: "codex\n" }],
      },
    });
    const r = run(["--autonomy", "worktree"]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.result?.externalAgent?.instance).toBe("codex");
    expect(r.result?.decisions[0]?.targets.map((t) => t.instance)).toEqual(["codex"]);
    expect(fakes.readLog({ cli: "agy", kind: "run" })).toEqual([]);
  });

  // agy is never a delegation target on native Windows (by design).
  it.skipIf(process.platform === "win32")(
    "[SEC-agy-ro] a read-only task may go to agy, without --dangerously-skip-permissions",
    () => {
      const { run, fakes } = setup({
        global: AGY_ON,
        // The fake ignores the sandbox and edits anyway: a read-only run still yields no patch.
        scenarios: { agy: [{ scenario: "success_edit", file: "math.js", content: "agy\n" }] },
      });
      const r = run(["--autonomy", "read-only"]);
      expect(r.code, r.stderr).toBe(0);
      expect(r.result).toMatchObject({
        status: "completed",
        externalAgent: { instance: "antigravity" },
      });
      const runs = fakes.readLog({ cli: "agy", kind: "run" });
      expect(runs).toHaveLength(1);
      for (const inv of fakes.readLog({ cli: "agy" })) {
        expect(inv.argv).not.toContain("--dangerously-skip-permissions");
        expect(inv.argv.join(" ")).not.toMatch(/dangerously|yolo/i);
      }
      expect(r.result?.patch ?? null).toBeNull();
    },
  );

  it("[SEC-agy-ro] a disabled agy (the default) is never spawned, not even for quota", () => {
    const { run, fakes } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
    });
    expect(run().code).toBe(0);
    expect(fakes.readLog({ cli: "agy" })).toEqual([]);
  });
});

describe("[SEC-codex-trust] codex never persists trust into the user's config", () => {
  // Golden argv with the projects=untrusted guard: test/unit/adapters/codex.test.ts
  // ("always carries every side-effect guard").
  it("[SEC-codex-trust] a codex run leaves $HOME/.codex/config.toml byte-identical", () => {
    const { run, home, fakes, repo } = setup({
      scenarios: { codex: [{ scenario: "success_edit", file: "math.js", content: "x\n" }] },
    });
    const cfg = join(home.home, ".codex", "config.toml");
    mkdirSync(join(home.home, ".codex"), { recursive: true });
    writeFileSync(cfg, '# user config\nmodel = "gpt-6-sol"\n');
    const before = sha(cfg);
    expect(run().code).toBe(0);
    expect(sha(cfg)).toBe(before);
    const argv = fakes.readLog({ cli: "codex", kind: "run" })[0]?.argv.join(" ") ?? "";
    expect(argv).toContain("--ignore-user-config");
    expect(argv).toMatch(/projects=\{.*trust_level="untrusted"/);
    expect(argv).toContain(JSON.stringify(repo.dir));
  });
});
