import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createClaudeAdapter,
  parseClaudeVersion,
  parseHelpFlags,
  satisfiesRange,
} from "../../../src/adapters/claude/index.js";
import type {
  AdapterDeps,
  ProviderInstance,
  QuotaObservation,
} from "../../../src/core/contracts.js";
import { FakeClock, ScriptedSpawner } from "../../stubs/index.js";
import { tempHome, tempRepo, withFakes } from "../../support/index.js";
import { runCtx, TestSpawner } from "./helpers.js";

const HELP = `Usage: claude [options] [command] [prompt]

Options:
  -p, --print                       Print response and exit
  --safe-mode                       Disable user hooks, plugins and MCP
  --output-format <format>          "text", "json" or "stream-json"
  --settings <file-or-json>         Load additional settings
  --disallowedTools, --disallowed-tools <tools...>  Deny tools
  --tools <tools...>                Available tools
`;

const instance: ProviderInstance = { id: "claude", adapter: "claude", pool: "subscription" };
const adapter = createClaudeAdapter();

function deps(spawner: AdapterDeps["spawner"], binary: string | null): AdapterDeps {
  return { spawner, clock: new FakeClock(), resolveBinary: async () => binary };
}

describe("claude adapter: probe", () => {
  it("[UC2] reads version and flags from the fake CLI without a run", async () => {
    await withFakes(
      { claude: [{ scenario: "fail", stdout: HELP, stderr: "", exitCode: 0 }] },
      async (ctx) => {
        const bin = ctx.bin("claude");
        const p = await adapter.probe(
          { ...instance, configDir: "/tmp/alt" },
          deps(new TestSpawner(), bin),
        );
        expect(p).toMatchObject({
          binaryPath: bin,
          realpath: realpathSync(bin),
          version: "2.1.301",
          features: [],
          loggedIn: null,
          outsideCliRange: false,
        });
        expect(p.flags).toEqual(
          expect.arrayContaining([
            "--safe-mode",
            "--settings",
            "--disallowedTools",
            "--tools",
            "--print",
          ]),
        );
        const subs = ctx.readLog({ cli: "claude" });
        expect(subs.map((s) => s.args)).toEqual([["--version"], ["--help"]]);
        expect(subs[0]?.env.CLAUDE_CONFIG_DIR).toBe("/tmp/alt");
      },
    );
  });

  it("no binary → empty probe", async () => {
    const p = await adapter.probe(instance, deps(new ScriptedSpawner(), null));
    expect(p).toEqual({
      binaryPath: null,
      realpath: null,
      version: null,
      flags: [],
      features: [],
      loggedIn: null,
      outsideCliRange: false,
    });
  });

  it("CLI without --safe-mode: probe has no such flag, so buildInvocation refuses", async () => {
    const spawner = new ScriptedSpawner([
      { stdout: ["2.0.9 (Claude Code)"] },
      { stdout: ["  --print", "  --settings <json>"] },
    ]);
    const p = await adapter.probe(instance, deps(spawner, "/nonexistent/claude"));
    expect(p).toMatchObject({ version: "2.0.9", realpath: null, outsideCliRange: true });
    expect(p.flags).toEqual(["--print", "--settings"]);
  });

  it("failing --version/--help → unknown version, outside range, no flags", async () => {
    const failing = new ScriptedSpawner([{ result: { exitCode: 1 } }]);
    const p = await adapter.probe(instance, deps(failing, "/x/claude"));
    expect(p).toMatchObject({ version: null, flags: [], outsideCliRange: true });
    const throwing: AdapterDeps["spawner"] = { spawn: () => Promise.reject(new Error("ENOENT")) };
    expect((await adapter.probe(instance, deps(throwing, "/x/claude"))).version).toBeNull();
  });

  it("version, help and range parsing", () => {
    expect(parseClaudeVersion("2.1.301 (Claude Code)")).toBe("2.1.301");
    expect(parseClaudeVersion("claude")).toBeNull();
    expect(parseHelpFlags("--b, --a [--c] (--a)")).toEqual(["--a", "--b", "--c"]);
    const r = ">=2.1.301 <2.2";
    expect(satisfiesRange("2.1.301", r)).toBe(true);
    expect(satisfiesRange("2.1.999", r)).toBe(true);
    expect(satisfiesRange("2.1.300", r)).toBe(false);
    expect(satisfiesRange("2.2.0", r)).toBe(false);
    expect(satisfiesRange("x", r)).toBe(false);
    expect(satisfiesRange("2.1.0", "~2.1")).toBe(false);
    expect(satisfiesRange("2.1.0", "=2.1.0")).toBe(true);
    expect(satisfiesRange("2.1.0", "2.1")).toBe(true);
    expect(satisfiesRange("2.1.1", ">2.1.0 <=2.1.1")).toBe(true);
    expect(satisfiesRange("2.1.0", ">2.1.0")).toBe(false);
  });
});

// Native Windows refuses to build a claude invocation (adapterPlatformBlocker: no OS sandbox), so
// there is no claude child to run end to end there.
describe.skipIf(process.platform === "win32")(
  "claude adapter: end to end against the fake CLI",
  () => {
    async function runOnce(scenarios: Parameters<typeof withFakes>[0], timeoutMs?: number) {
      return withFakes(scenarios, async (ctx) => {
        const home = tempHome();
        const repo = tempRepo();
        const spawner = new TestSpawner();
        const bin = ctx.bin("claude");
        const probe = {
          binaryPath: bin,
          realpath: bin,
          version: "2.1.301",
          flags: ["--safe-mode"],
          features: [],
          loggedIn: null,
          outsideCliRange: false,
        };
        const inv = adapter.buildInvocation({
          task: {
            id: "t",
            prompt: "say hi",
            paths: [],
            autonomy: "worktree",
            timeoutMs: 60_000,
          },
          target: { instance: "claude", tier: "fast", model: "haiku", effort: "low" },
          autonomy: "worktree",
          worktree: repo.dir,
          repoRoot: repo.dir,
          runDir: home.home,
          instance,
          probe,
          baseEnv: { PATH: ctx.env.PATH ?? "", HOME: home.home },
        });
        const rc = runCtx(repo.dir, { instanceId: "claude" });
        const events: string[] = [];
        const res = await spawner.spawn({
          binary: inv.binary,
          argv: inv.argv,
          env: inv.env,
          cwd: inv.cwd,
          stdin: inv.stdin ?? "",
          ...(timeoutMs ? { timeoutMs } : {}),
          onLine: (s, l) => {
            for (const e of adapter.parseLine(s, l, rc)) events.push(e.kind);
          },
        });
        const outcome = adapter.finalize({ ...res, durationMs: 1 }, rc);
        const log = ctx.readLog({ cli: "claude", kind: "run" });
        home.cleanup();
        repo.cleanup();
        return { outcome, events, log, rc };
      });
    }

    it("[UC2] replays the isolation fixture through spawn → parseLine → finalize", async () => {
      const { outcome, log, rc } = await runOnce({
        claude: [{ scenario: "replay", fixture: "claude/2.1.301/child_isolation_canary" }],
      });
      expect(outcome.outcome).toBe("success");
      expect(log[0]?.args.slice(0, 2)).toEqual(["-p", "--safe-mode"]);
      expect(log[0]?.stdin).toContain("--- TASK ---\nsay hi");
      expect((rc.scratch.quotaObservations as QuotaObservation[])[0]?.window?.kind).toBe("7d");
    });

    it("[UC13] a hanging child is killed at the timeout and classified as timeout", async () => {
      const { outcome } = await runOnce({ claude: [{ scenario: "slow", delayMs: 400 }] }, 600);
      expect(outcome.outcome).toBe("timeout");
    });

    it("fake quota_exhausted scenario → quota_exhausted", async () => {
      const { outcome } = await runOnce({ claude: [{ scenario: "quota_exhausted" }] });
      expect(outcome.outcome).toBe("quota_exhausted");
    });
  },
);
