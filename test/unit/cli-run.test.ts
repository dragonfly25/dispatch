/** WP24: `dispatch run` (sync, --dry-run, --json, --provider) with fake CLIs on PATH. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exitCodeForResult, renderRunResult } from "../../src/cli/commands/run.js";
import { ExitRequest } from "../../src/cli/exit.js";
import { buildProgram, runCli } from "../../src/cli/program.js";
import { ExitCode, type RunResult, RunResultSchema } from "../../src/core/contracts.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { ProbeCache } from "../../src/runner/lifecycle.js";
import { probeResult } from "../fixtures/contracts.js";
import {
  createFakes,
  type FakeScenarioMap,
  type FakesContext,
  snapshotTree,
  type TempHome,
  type TempRepo,
  tempHome,
  tempRepo,
} from "../support/index.js";

let fakes: FakesContext | undefined;
let home: TempHome | undefined;
let repo: TempRepo | undefined;
afterEach(() => {
  fakes?.dispose();
  home?.cleanup();
  repo?.cleanup();
  fakes = home = repo = undefined;
});

const EDIT: FakeScenarioMap = {
  codex: [{ scenario: "success_edit", file: "math.js", content: "changed\n" }],
  claude: [{ scenario: "success_edit", file: "math.js", content: "claude edit\n" }],
};

interface Setup {
  scenarios?: FakeScenarioMap;
  /** Body of `~/.dispatch/config.yaml` (after `version: 1`). */
  config?: string;
}

function setup(o: Setup = {}) {
  fakes = createFakes(o.scenarios ?? EDIT);
  home = tempHome();
  repo = tempRepo({ files: { "math.js": "function add(a, b) {\n  return a + b;\n}\n" } });
  mkdirSync(home.dispatchHome, { recursive: true });
  writeFileSync(join(home.dispatchHome, "config.yaml"), `version: 1\n${o.config ?? ""}`);
  const base = { ...fakes.env, ...home.env };
  // The fake claude does not advertise --safe-mode, so the probes are seeded (as in WP19).
  const probes = new ProbeCache();
  for (const cli of ["claude", "codex"]) {
    probes.set(cli, cli, {
      ...probeResult,
      binaryPath: join(fakes.binDir, cli),
      flags: ["--safe-mode"],
      features: ["hooks", "plugins", "apps", "memories"],
    });
  }
  const run = async (args: string[], extraEnv: Record<string, string> = {}) => {
    const env = { ...base, ...extraEnv };
    let out = "";
    let err = "";
    const io = {
      out: (t: string) => {
        out += t;
      },
      err: (t: string) => {
        err += t;
      },
    };
    const program = buildProgram(
      io,
      {},
      {},
      {
        cwd: repo?.dir ?? "",
        env,
        quotaReaders: new QuotaReaderRegistry(),
        runner: { probes },
      },
    );
    const code = await runCli(args, io, program, { platform: process.platform, env });
    return { code, out, err };
  };
  return { run, fakes, home, repo };
}

const TASK = ["run", "--task", "add sub to math.js", "--path", "math.js"];

describe("dispatch run", () => {
  it("[UC10] --json without any host: schema v1 RunResult, self = null, exit 0", async () => {
    const { run, repo } = setup();
    const before = snapshotTree(repo.dir);
    const { code, out, err } = await run([...TASK, "--json"]);
    expect(err).toBe("");
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(RunResultSchema.safeParse(r).success).toBe(true);
    expect(r).toMatchObject({ schemaVersion: 1, status: "completed", outcome: "success" });
    expect(r.externalAgent?.marker).toBe("EXTERNAL_AGENT_OUTPUT");
    expect(r.decisions[0]?.action).toBe("delegate");
    expect(readFileSync(r.patch?.path ?? "", "utf8")).toContain("+changed");
    expect(snapshotTree(repo.dir)).toEqual(before);
    // The decision was recorded with the host unknown.
    const input = JSON.parse((await run(["explain", "--task", "x", "--json"])).out) as {
      input: { host: { self: string | null } };
    };
    expect(input.input.host.self).toBeNull();
  });

  it("[SEC-flags] a config error (unknown profile) stops the run with exit 2 before spawning", async () => {
    const { run, fakes } = setup({ config: "profile: nope\n" });
    const { code, err } = await run([...TASK, "--json"]);
    expect(code).toBe(2);
    expect(err).toMatch(/unknown profile "nope"/);
    expect(err).toMatch(/configuration has 1 error/);
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("[UC2] inside Claude Code with the preserve profile: codex runs, fake claude never starts", async () => {
    const { run, fakes } = setup({ config: "profile: preserve\n" });
    const { code, out } = await run([...TASK, "--json"], { CLAUDECODE: "1" });
    expect(code).toBe(0);
    const r = JSON.parse(out) as RunResult;
    expect(r.externalAgent?.instance).toBe("codex");
    expect(r.decisions[0]?.reason).toMatch(/preserve/);
    expect(fakes.readLog({ cli: "claude" })).toEqual([]);
    expect(fakes.readLog({ cli: "codex", kind: "run" })).toHaveLength(1);
  });

  it("prints a concise human summary with the untrusted block, patch and log path", async () => {
    const { run } = setup();
    const { code, out } = await run(TASK);
    expect(code).toBe(0);
    expect(out).toMatch(/^Run \S+: completed \(success\)/);
    expect(out).toContain("Provider: codex (instance codex)");
    expect(out).toContain("EXTERNAL AGENT OUTPUT (untrusted");
    expect(out).toMatch(/Patch: .*patch\.diff/);
    expect(out).toMatch(/applies cleanly/);
    expect(out).toMatch(/Log: .*run\.log|Log: /);
  });

  it("[AC3] --dry-run prints the decision and spawns nothing", async () => {
    const { run, fakes, repo } = setup();
    const before = snapshotTree(repo.dir);
    const text = await run([...TASK, "--dry-run"]);
    expect(text.code).toBe(0);
    expect(text.out).toContain("Decision");
    const json = await run([...TASK, "--dry-run", "--json"]);
    const parsed = JSON.parse(json.out);
    expect(parsed).toMatchObject({ schemaVersion: 1, dryRun: true });
    expect(parsed.decision.action).toBe("delegate");
    expect(Object.keys(parsed.alternatives).length).toBeGreaterThan(0);
    expect(readFileSync(fakes.logPath, "utf8")).toBe("");
    expect(snapshotTree(repo.dir)).toEqual(before);
  });

  it("--provider forces a pin that explain shows; the router still applies", async () => {
    const { run, fakes } = setup({ config: "profile: preserve\n" });
    const dry = await run([...TASK, "--provider", "claude", "--dry-run", "--json"]);
    const d = JSON.parse(dry.out);
    expect(d.decision.targets.map((t: { instance: string }) => t.instance)).toEqual(["claude"]);
    expect(d.explain).toContain("flag:provider");
    // Inside Claude Code the host is never a target: the pinned task stays on the host.
    const self = await run([...TASK, "--provider", "claude", "--json"], { CLAUDECODE: "1" });
    expect(self.code).toBe(0);
    expect(JSON.parse(self.out)).toMatchObject({ status: "returned_to_host" });
    expect(fakes.readLog({ cli: "claude", kind: "run" })).toEqual([]);
    // "auto" is the default behaviour.
    const auto = await run([...TASK, "--provider", "auto", "--dry-run", "--json"]);
    expect(JSON.parse(auto.out).explain).not.toContain("flag:provider");
  });

  it("[SEC-x] --provider cannot select a disabled or unknown instance (exit 2)", async () => {
    const { run, fakes } = setup();
    const off = await run([...TASK, "--provider", "antigravity"]);
    expect(off.code).toBe(2);
    expect(off.err).toMatch(/disabled/);
    const unknown = await run([...TASK, "--provider", "nope", "--dry-run"]);
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/unknown provider instance "nope"/);
    expect(readFileSync(fakes.logPath, "utf8")).toBe("");
  });

  it("[SEC-x] --provider cannot enable an instance the global config disabled", async () => {
    const { run } = setup({ config: "providers:\n  codex:\n    enabled: false\n" });
    const r = await run([...TASK, "--provider", "codex"]);
    expect(r.code).toBe(2);
    expect(r.err).toMatch(/codex.*disabled/);
  });

  it("usage errors exit 2: missing task, both task flags, --detach not available yet", async () => {
    const { run } = setup();
    expect((await run(["run"])).code).toBe(2);
    expect((await run(["run", "--task", "x", "--task-file", "y"])).code).toBe(2);
    const detach = await run([...TASK, "--detach"]);
    expect(detach.code).toBe(2);
    expect(detach.err).toMatch(/--detach is not available yet/);
    expect((await run(["run", "--help"])).out).not.toContain("--detach");
  });

  it("a recursion child is rejected: exit 3 and no CLI runs", async () => {
    const { run, fakes } = setup();
    const r = await run([...TASK, "--json"], { DISPATCH_DEPTH: "1" });
    expect(r.code).toBe(3);
    expect(JSON.parse(r.out)).toMatchObject({ status: "rejected", outcome: "rejected" });
    expect(fakes.readLog({ kind: "run" })).toEqual([]);
  });

  it("a failing agent or an exhausted chain goes back to the host: exit 0, reason in the result", async () => {
    const failed = setup({
      scenarios: { codex: [{ scenario: "fail" }] },
      config: "profile: off\n",
    });
    const r = await failed.run([...TASK, "--provider", "codex", "--json"]);
    expect(JSON.parse(r.out)).toMatchObject({ status: "returned_to_host", outcome: "failed" });
    expect(r.code).toBe(0);
    fakes?.dispose();
    home?.cleanup();
    repo?.cleanup();

    const quota = setup({
      scenarios: {
        codex: [{ scenario: "quota_exhausted" }],
        claude: [{ scenario: "quota_exhausted" }],
      },
    });
    const q = await quota.run([...TASK, "--json"]);
    expect(JSON.parse(q.out)).toMatchObject({
      status: "returned_to_host",
      outcome: "quota_exhausted",
    });
    expect(q.code).toBe(0);
  });
});

describe("exit code mapping [UC2]", () => {
  const result = (over: Partial<RunResult>): RunResult => ({
    schemaVersion: 1,
    runId: "r1",
    status: "completed",
    externalAgent: null,
    outcome: "success",
    summary: "",
    patch: null,
    log: { path: "/tmp/log" },
    decisions: [],
    durationMs: 1,
    ...over,
  });

  it.each([
    [{ status: "completed", outcome: "success" }, 0],
    [{ status: "completed", outcome: "failed" }, 4],
    [{ status: "completed", outcome: "quota_exhausted" }, 5],
    [{ status: "completed", outcome: "timeout" }, 6],
    [{ status: "completed", outcome: "rejected" }, 3],
    [{ status: "completed", outcome: null }, 4],
    [{ status: "rejected", outcome: "rejected" }, 3],
    [{ status: "running", outcome: null }, 75],
    [{ status: "returned_to_host", outcome: null }, 0],
    [{ status: "returned_to_host", outcome: "quota_exhausted" }, 0],
    [{ status: "returned_to_host", outcome: "timeout" }, 0],
  ] as const)("%o -> %i", (over, code) => {
    expect(exitCodeForResult(result(over))).toBe(code);
  });

  it("ExitRequest carries the code runCli returns without printing", async () => {
    const io = { out: () => {}, err: () => {} };
    const program = buildProgram(io);
    program.command("boom").action(() => {
      throw new ExitRequest(ExitCode.QUOTA);
    });
    expect(await runCli(["boom"], io, program, { platform: process.platform, env: {} })).toBe(5);
  });

  it("renders a returned-to-host result with its reason and a patch with its flags", () => {
    const text = renderRunResult(
      result({
        status: "returned_to_host",
        outcome: null,
        summary: "policy keeps this on the host",
        decisions: [
          {
            action: "host",
            reason: "pinned",
          } as RunResult["decisions"][number],
        ],
      }),
    );
    expect(text).toContain("Reason: policy keeps this on the host");
    expect(text).not.toContain("EXTERNAL AGENT OUTPUT");
    const withPatch = renderRunResult(
      result({
        externalAgent: {
          provider: "codex",
          instance: "codex",
          model: "m",
          marker: "EXTERNAL_AGENT_OUTPUT",
        },
        summary: "line1\nline2",
        patch: {
          path: "/p.diff",
          diffstat: " a | 1 +\n",
          applies: false,
          rejectedPaths: [".env"],
          needsReview: true,
        },
      }),
    );
    expect(withPatch).toContain("does NOT apply");
    expect(withPatch).toContain("needs review");
    expect(withPatch).toContain("dropped paths: .env");
    expect(withPatch).toContain("  line2");
  });

  it("[SEC-patch] renders an all-rejected patch as nothing to apply, listing the dropped paths", () => {
    const text = renderRunResult(
      result({
        patch: {
          path: "/p.diff",
          diffstat: "",
          applies: false,
          rejectedPaths: [".git/hooks/pre-commit", "link"],
          needsReview: false,
        },
      }),
    );
    expect(text).toContain("Patch: none (every change was rejected; nothing to apply)");
    expect(text).not.toContain("/p.diff");
    expect(text).toContain("dropped paths: .git/hooks/pre-commit, link");
  });
});
