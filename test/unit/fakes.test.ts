import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_LEAKS, tempHome, tempRepo, withFakes } from "../support/index.js";
import { isAlive, jsonLines, runFake, sleep, startFake, waitFor } from "./fakes-helpers.js";

type Obj = Record<string, unknown>;

describe("fake CLIs: logging and scenario selection [AC1]", () => {
  it("[AC1] logs argv, cwd, env (minus FAKE_*), pid/pgid, stdin and timing for each call", async () => {
    await withFakes(
      { claude: [{ scenario: "replay", fixture: "claude/2.1.301/child_isolation_canary" }] },
      async (ctx) => {
        const repo = tempRepo();
        const r = await runFake(ctx, "claude", ["-p", "--model", "haiku"], {
          cwd: repo.dir,
          input: "x".repeat(6000),
          env: { MARKER_VAR: "m1" },
        });
        expect(r.code).toBe(0);
        const [entry] = ctx.readLog();
        expect(entry?.cli).toBe("claude");
        expect(entry?.kind).toBe("run");
        expect(entry?.argv).toEqual(["claude", "-p", "--model", "haiku"]);
        expect(entry?.args).toEqual(["-p", "--model", "haiku"]);
        expect(entry?.cwd).toBe(repo.dir);
        expect(entry?.env.MARKER_VAR).toBe("m1");
        expect(Object.keys(entry?.env ?? {}).filter((k) => k.startsWith("FAKE_"))).toEqual([]);
        expect(entry?.stdin).toHaveLength(4096);
        expect(entry?.stdinBytes).toBe(6000);
        expect(typeof entry?.pid).toBe("number");
        // Windows has no process groups: the fake reports null there.
        expect(typeof entry?.pgid).toBe(process.platform === "win32" ? "object" : "number");
        expect(entry?.exitCode).toBe(0);
        expect(Date.parse(entry?.endedAt ?? "")).toBeGreaterThanOrEqual(
          Date.parse(entry?.startedAt ?? ""),
        );
        repo.cleanup();
      },
    );
  });

  it("[AC1] picks scenarios by per-CLI call index, repeats the last, and keeps counters per CLI", async () => {
    await withFakes(
      {
        claude: [
          { scenario: "fail", exitCode: 3 },
          { scenario: "fail", exitCode: 4 },
        ],
        codex: [{ scenario: "fail", exitCode: 7 }],
      },
      async (ctx) => {
        const codes = [
          (await runFake(ctx, "claude", ["-p"])).code,
          (await runFake(ctx, "codex", ["exec", "-"])).code,
          (await runFake(ctx, "claude", ["--version"])).code, // subcommands do not consume run indexes
          (await runFake(ctx, "claude", ["-p"])).code,
          (await runFake(ctx, "claude", ["-p"])).code,
          (await runFake(ctx, "codex", ["exec", "-"])).code,
        ];
        expect(codes).toEqual([3, 7, 0, 4, 4, 7]);
        expect(ctx.readLog({ cli: "claude", kind: "run" }).map((e) => e.callIndex)).toEqual([
          0, 1, 2,
        ]);
      },
    );
  });

  it("[AC1] concurrent calls get distinct call indexes", async () => {
    const scenarios = Array.from({ length: 6 }, (_, i) => ({
      scenario: "fail" as const,
      exitCode: 10 + i,
    }));
    await withFakes({ agy: scenarios }, async (ctx) => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => runFake(ctx, "agy", ["-p=hi"])),
      );
      expect(results.map((r) => r.code).sort()).toEqual([10, 11, 12, 13, 14, 15]);
    });
  });

  it("[AC1] a run without a scenario, or with an unknown one, fails loudly and is still logged", async () => {
    await withFakes({ codex: [{ scenario: "nope" } as never] }, async (ctx) => {
      const unknown = await runFake(ctx, "codex", ["exec", "-"]);
      expect(unknown.code).toBe(98);
      expect(unknown.stderr).toMatch(/unknown scenario/);
      ctx.setScenarios({});
      const none = await runFake(ctx, "codex", ["exec", "-"]);
      expect(none.code).toBe(97);
      expect(ctx.readLog({ cli: "codex" })).toHaveLength(2);
    });
  });

  it("[AC1] fixtures replay with meta exit code, stderr and <WT> substitution", async () => {
    await withFakes(
      {
        agy: [{ scenario: "replay", fixture: "agy/1.5.2/plan_mode_write_denied" }],
        codex: [{ scenario: "replay", fixture: "codex/0.167.0/invalid_model_turn_failed" }],
      },
      async (ctx) => {
        const agy = await runFake(ctx, "agy", ["-p=hello"]);
        expect(agy.code).toBe(0);
        expect(agy.stderr).toMatch(/--mode plan has no effect/);
        expect((jsonLines(agy.stdout).at(-1) as Obj).event).toBe("result");
        const codex = await runFake(ctx, "codex", ["exec", "-"]);
        expect(codex.code).toBe(1);
        expect(jsonLines(codex.stdout).map((e) => (e as Obj).type)).toContain("turn.failed");
        const missing = await withFakes(
          { claude: [{ scenario: "replay", fixture: "claude/9/none" }] },
          (c2) => runFake(c2, "claude", ["-p"]),
        );
        expect(missing.code).toBe(99);
      },
    );
  });
});

describe("fake CLIs: run scenarios [AC1]", () => {
  it("[AC1] success_edit writes the file in cwd then replays a success stream (all three CLIs)", async () => {
    await withFakes(
      {
        claude: [{ scenario: "success_edit", file: "src/a.txt", content: "hello" }],
        codex: [{ scenario: "success_edit", files: { "b.txt": "b" } }],
        agy: [{ scenario: "success_edit", file: "c.txt", content: "c" }],
      },
      async (ctx) => {
        const repo = tempRepo();
        const claude = await runFake(ctx, "claude", ["-p"], { cwd: repo.dir, input: "do it" });
        expect(readFileSync(join(repo.dir, "src/a.txt"), "utf8")).toBe("hello");
        expect(jsonLines(claude.stdout).at(-1)).toMatchObject({ type: "result" });
        const codex = await runFake(ctx, "codex", ["exec", "-"], { cwd: repo.dir, input: "do it" });
        expect(existsSync(join(repo.dir, "b.txt"))).toBe(true);
        expect(jsonLines(codex.stdout).at(-1)).toMatchObject({ type: "turn.completed" });
        const agy = await runFake(ctx, "agy", ["-p=do it"], { cwd: repo.dir });
        expect(existsSync(join(repo.dir, "c.txt"))).toBe(true);
        expect(jsonLines(agy.stdout).at(-1)).toMatchObject({
          event: "result",
          result: { status: "SUCCESS" },
        });
        expect(ctx.readLog({ cli: "codex" })[0]?.stdin).toBe("do it");
        repo.cleanup();
      },
    );
  });

  // Windows: child.kill() is TerminateProcess, so the fake never sees SIGTERM.
  it.skipIf(process.platform === "win32")(
    "[AC1] slow emits one event per delay and records SIGTERM as exit 143",
    async () => {
      await withFakes(
        {
          claude: [
            {
              scenario: "slow",
              delayMs: 120,
              events: [{ type: "a" }, { type: "b" }, { type: "c" }],
            },
          ],
        },
        async (ctx) => {
          const t0 = Date.now();
          const r = await runFake(ctx, "claude", ["-p"]);
          expect(Date.now() - t0).toBeGreaterThanOrEqual(340);
          expect(jsonLines(r.stdout)).toEqual([{ type: "a" }, { type: "b" }, { type: "c" }]);

          const { child, done } = startFake(ctx, "claude", ["-p"]);
          await waitFor(() => ctx.readLog({ cli: "claude" })[1]?.pid);
          child.kill("SIGTERM");
          const killed = await done;
          expect(killed.code).toBe(143);
          const second = ctx.readLog({ cli: "claude" })[1];
          expect(second?.exitCode).toBe(143);
          expect(second?.signalReceived).toBe("SIGTERM");
        },
      );
    },
  );

  it("[AC1] quota_exhausted replays each CLI's synthetic quota fixture", async () => {
    await withFakes(
      {
        claude: [{ scenario: "quota_exhausted" }],
        codex: [{ scenario: "quota_exhausted" }],
        agy: [{ scenario: "quota_exhausted" }],
      },
      async (ctx) => {
        const claude = await runFake(ctx, "claude", ["-p"]);
        expect(claude.code).toBe(1);
        expect(jsonLines(claude.stdout).at(-1)).toMatchObject({
          is_error: true,
          api_error_status: 429,
        });
        const codex = await runFake(ctx, "codex", ["exec", "-"]);
        expect(codex.code).toBe(1);
        expect(codex.stdout).toContain("You’ve hit your usage limit");
        const agy = await runFake(ctx, "agy", ["-p=x"]);
        expect(agy.code).toBe(3);
        expect(agy.stderr).toContain("AGY_ERROR");
        expect(agy.stderr).toMatch(/exhausted your quota/);
      },
    );
  });

  it("[AC1] malformed yields a valid first event, truncated JSON, non-JSON, an unknown event, and a truncated tail", async () => {
    await withFakes(
      {
        claude: [{ scenario: "malformed" }],
        codex: [{ scenario: "malformed" }],
        agy: [{ scenario: "malformed" }],
      },
      async (ctx) => {
        for (const cli of ["claude", "codex", "agy"] as const) {
          const r = await runFake(ctx, cli, cli === "codex" ? ["exec", "-"] : ["-p=x"]);
          expect(r.code).toBe(0);
          expect(r.stdout.endsWith("\n")).toBe(false);
          const lines = r.stdout.split("\n");
          const parsed = lines.map((l) => {
            try {
              return JSON.parse(l) as Obj;
            } catch {
              return null;
            }
          });
          expect(parsed[0]).not.toBeNull();
          expect(parsed[1]).toBeNull();
          expect(lines[2]).toMatch(/not json/);
          expect(JSON.stringify(parsed[3])).toContain("zz_unknown_event");
          expect(parsed.at(-1)).toBeNull();
        }
      },
    );
  });

  it("[AC1] crash exits 139 mid-stream (or dies by signal when asked)", async () => {
    await withFakes(
      { codex: [{ scenario: "crash" }, { scenario: "crash", signal: "SIGKILL" }] },
      async (ctx) => {
        const r = await runFake(ctx, "codex", ["exec", "-"]);
        expect(r.code).toBe(139);
        expect(jsonLines(r.stdout)).toHaveLength(2);
        expect(r.stderr).toMatch(/Segmentation fault/);
        const k = await runFake(ctx, "codex", ["exec", "-"]);
        // Windows has no signal deaths: a self-kill is reported as an exit code.
        if (process.platform !== "win32") expect(k.signal).toBe("SIGKILL");
      },
    );
  });

  // POSIX-only: process groups and signals sent to them (process.kill(-pgid)).
  it.skipIf(process.platform === "win32")(
    "[AC1] hang_ignore_term survives SIGTERM, leaves a grandchild in the group, and dies with the group on SIGKILL",
    async () => {
      await withFakes(
        { claude: [{ scenario: "hang_ignore_term", maxLifetimeMs: 20000 }] },
        async (ctx) => {
          const { child, done } = startFake(ctx, "claude", ["-p"], { detached: true });
          const entry = await waitFor(() => {
            const e = ctx.readLog()[0];
            return e?.grandchildPid ? e : undefined;
          });
          const grandchild = entry.grandchildPid as number;
          expect(entry.pgid).toBe(child.pid);
          expect(isAlive(grandchild)).toBe(true);

          process.kill(-(child.pid as number), "SIGTERM");
          await waitFor(() => ctx.readLog()[0]?.sigtermCount === 1);
          await sleep(250);
          expect(isAlive(child.pid as number)).toBe(true);
          expect(isAlive(grandchild)).toBe(true);

          process.kill(-(child.pid as number), "SIGKILL");
          const r = await done;
          expect(r.signal).toBe("SIGKILL");
          await waitFor(() => !isAlive(grandchild));
          expect(ctx.readLog()[0]?.endedAt).toBeUndefined(); // SIGKILL leaves no end record
        },
      );
    },
  );

  it("[AC1] recurse runs the dispatch command and records its exit code and output", async () => {
    await withFakes(
      {
        claude: [{ scenario: "recurse" }],
        codex: [{ scenario: "recurse", command: "echo nested-out; echo nested-err >&2; exit 5" }],
      },
      async (ctx) => {
        const viaEnv = await runFake(ctx, "claude", ["-p"], {
          env: {
            DISPATCH_RECURSE_CMD: 'echo "depth=$DISPATCH_DEPTH"; exit 3',
            DISPATCH_DEPTH: "1",
          },
        });
        expect(viaEnv.code).toBe(0);
        expect(ctx.readLog({ cli: "claude" })[0]?.recurse).toMatchObject({
          exitCode: 3,
          stdout: "depth=1\n",
          error: null,
        });
        await runFake(ctx, "codex", ["exec", "-"]);
        expect(ctx.readLog({ cli: "codex" })[0]?.recurse).toMatchObject({
          exitCode: 5,
          stdout: "nested-out\n",
          stderr: "nested-err\n",
        });
        ctx.setScenarios({ claude: [{ scenario: "recurse" }] });
        expect((await runFake(ctx, "claude", ["-p"])).code).toBe(97);
      },
    );
  });

  it("[AC1] escape_writes attempts every out-of-tree write and records the outcome", async () => {
    await withFakes(
      { claude: [{ scenario: "escape_writes", pinnedPath: "pinned/secret.txt" }] },
      async (ctx) => {
        const home = tempHome();
        const repo = tempRepo();
        mkdirSync(join(home.home, "ws"));
        const wt = join(home.home, "ws", "wt");
        repo.git("worktree", "add", "-q", "-b", "side", wt);
        const r = await runFake(ctx, "claude", ["-p"], { cwd: wt });
        expect(r.code).toBe(0);
        const results = ctx.readLog()[0]?.escape ?? [];
        expect(results.map((e) => e.label)).toEqual([
          "git-hook",
          "parent-dir",
          "absolute",
          "dispatch-config",
          "claude-settings",
          "git-hook-resolved",
          "pinned",
        ]);
        expect(results.find((e) => e.label === "git-hook")).toMatchObject({ ok: false }); // .git is a file in a worktree
        for (const label of [
          "parent-dir",
          "absolute",
          "dispatch-config",
          "claude-settings",
          "git-hook-resolved",
          "pinned",
        ]) {
          expect(results.find((e) => e.label === label)?.ok, label).toBe(true);
        }
        expect(readFileSync(join(home.home, "ws", "outside.txt"), "utf8")).toContain("FAKE-ESCAPE");
        expect(readFileSync(join(ctx.stateDir, "abs.txt"), "utf8")).toContain("FAKE-ESCAPE");
        expect(existsSync(join(wt, ".dispatch/config.yaml"))).toBe(true);
        expect(existsSync(join(wt, ".claude/settings.json"))).toBe(true);
        expect(existsSync(join(wt, "pinned/secret.txt"))).toBe(true);
        const hook = execFileSync("git", ["rev-parse", "--git-dir"], {
          cwd: wt,
          encoding: "utf8",
        }).trim();
        expect(existsSync(join(hook, "hooks", "pre-commit"))).toBe(true);
        repo.cleanup();
        home.cleanup();
      },
    );
  });

  it("[AC1] escape_writes in a plain repo writes .git/hooks/pre-commit directly", async () => {
    await withFakes({ codex: [{ scenario: "escape_writes" }] }, async (ctx) => {
      const home = tempHome();
      const repo = tempRepo({ parent: home.home });
      await runFake(ctx, "codex", ["exec", "-"], { cwd: repo.dir });
      expect(existsSync(join(repo.dir, ".git/hooks/pre-commit"))).toBe(true);
      expect(ctx.readLog()[0]?.escape?.some((e) => e.label === "git-hook-resolved")).toBe(false);
      repo.cleanup();
      home.cleanup();
    });
  });

  // Windows: symlinks need privileges and their targets are rewritten with backslashes.
  it.skipIf(process.platform === "win32")(
    "[AC1] symlink plants link -> /etc/passwd and link2 -> ../..",
    async () => {
      await withFakes(
        { agy: [{ scenario: "symlink" }, { scenario: "symlink", links: { custom: "/tmp" } }] },
        async (ctx) => {
          const repo = tempRepo();
          await runFake(ctx, "agy", ["-p=x"], { cwd: repo.dir });
          expect(lstatSync(join(repo.dir, "link")).isSymbolicLink()).toBe(true);
          expect(readlinkSync(join(repo.dir, "link"))).toBe("/etc/passwd");
          expect(readlinkSync(join(repo.dir, "link2"))).toBe("../..");
          expect(ctx.readLog()[0]?.symlink).toHaveLength(2);
          await runFake(ctx, "agy", ["-p=x"], { cwd: repo.dir });
          expect(readlinkSync(join(repo.dir, "custom"))).toBe("/tmp");
          repo.cleanup();
        },
      );
    },
  );

  it("[AC1] leak_secret prints fake tokens and the CANARY_SECRET value to stdout and stderr", async () => {
    await withFakes(
      {
        claude: [{ scenario: "leak_secret" }],
        codex: [{ scenario: "leak_secret", secret: "explicit-canary" }],
      },
      async (ctx) => {
        const r = await runFake(ctx, "claude", ["-p"], {
          env: { CANARY_SECRET: "canary-value-123" },
        });
        for (const stream of [r.stdout, r.stderr]) {
          expect(stream).toContain(FAKE_LEAKS.anthropic);
          expect(stream).toContain(FAKE_LEAKS.github);
          expect(stream).toContain(FAKE_LEAKS.bearer);
          expect(stream).toContain("canary-value-123");
        }
        expect(FAKE_LEAKS.anthropic).toMatch(/^sk-ant-/);
        expect(FAKE_LEAKS.github).toMatch(/^ghp_[A-Za-z0-9]{36}$/);
        const c = await runFake(ctx, "codex", ["exec", "-"]);
        expect(c.stdout).toContain("explicit-canary");
      },
    );
  });

  it("[AC1] fail exits with the configured code and message", async () => {
    await withFakes(
      { agy: [{ scenario: "fail", exitCode: 2, stderr: "boom\n", stdout: "out" }] },
      async (ctx) => {
        const r = await runFake(ctx, "agy", ["-p=x"]);
        expect(r).toMatchObject({ code: 2, stderr: "boom\n", stdout: "out" });
      },
    );
  });
});

describe("fake CLIs: subcommands [AC1]", () => {
  it("[AC1] --version has sensible defaults and is overridable", async () => {
    await withFakes(
      { agy: [], "agy:version": [{}, { stdout: "9.9.9\n" }, { exitCode: 1, stderr: "gone" }] },
      async (ctx) => {
        expect((await runFake(ctx, "claude", ["--version"])).stdout).toBe(
          "2.1.301 (Claude Code)\n",
        );
        expect((await runFake(ctx, "codex", ["--version"])).stdout).toBe("codex-cli 0.167.0\n");
        expect((await runFake(ctx, "agy", ["--version"])).stdout).toBe("1.5.2\n");
        expect((await runFake(ctx, "agy", ["--version"])).stdout).toBe("9.9.9\n");
        expect(await runFake(ctx, "agy", ["--version"])).toMatchObject({ code: 1, stderr: "gone" });
        expect(ctx.readLog({ kind: "subcommand", key: "version" })).toHaveLength(5);
      },
    );
  });

  it("[AC1] codex login status, features list and debug models", async () => {
    await withFakes({ "codex:login": [{}, { loggedIn: false }] }, async (ctx) => {
      const ok = await runFake(ctx, "codex", ["login", "status"]);
      expect(ok).toMatchObject({ code: 0 });
      expect(ok.stdout).toContain("Logged in using ChatGPT");
      expect(await runFake(ctx, "codex", ["login", "status"])).toMatchObject({
        code: 1,
        stderr: "Not logged in\n",
      });
      const features = (await runFake(ctx, "codex", ["features", "list"])).stdout;
      for (const f of [
        "hooks",
        "plugins",
        "multi_agent",
        "multi_agent_v2",
        "apps",
        "unified_exec",
        "memories",
      ]) {
        expect(features).toMatch(new RegExp(`^${f}\\s`, "m"));
      }
      const models = JSON.parse((await runFake(ctx, "codex", ["debug", "models"])).stdout) as {
        models: Obj[];
      };
      expect(models.models.map((m) => m.slug)).toContain("gpt-6-luna");
      expect(models.models.find((m) => m.slug === "gpt-reserve")?.multi_agent_version).toBe("v1");
      expect(await runFake(ctx, "codex", ["bogus-sub"])).toMatchObject({ code: 97 }); // falls through to the run scenario path
    });
  });

  it("[AC1] agy models and the /usage variants", async () => {
    await withFakes(
      {
        "agy:usage": [
          { variant: "fixture" },
          { variant: "fixture", remainingFraction: 0, resetTime: "2030-01-01T00:00:00Z" },
          { variant: "changed_format" },
          { variant: "unauthenticated" },
        ],
      },
      async (ctx) => {
        expect((await runFake(ctx, "agy", ["models"])).stdout).toContain("gemini-3.8-flash-low");
        const fixture = jsonLines(
          (await runFake(ctx, "agy", ["-p=/usage", "--output-format", "json"])).stdout,
        )[0] as Obj;
        expect(JSON.stringify(fixture)).toContain("remaining_fraction");
        const zero = await runFake(ctx, "agy", ["-p", "/usage", "--output-format", "json"]);
        const z = JSON.parse(zero.stdout) as {
          response: string;
          command: { data: { groups: { buckets: Obj[] }[] } };
        };
        expect(z.command.data.groups[0]?.buckets[0]).toMatchObject({
          remaining_fraction: 0,
          reset_time: "2030-01-01T00:00:00Z",
        });
        expect(z.response).toContain("0%\t2030-01-01T00:00:00Z");
        const changed = JSON.parse((await runFake(ctx, "agy", ["-p=/usage"])).stdout) as {
          command: { data: Obj };
        };
        expect(changed.command.data.groups).toBeUndefined();
        expect(changed.command.data.limits).toBeDefined();
        const unauth = await runFake(ctx, "agy", ["-p=/usage"]);
        expect(unauth.code).toBe(1);
        expect(unauth.stderr).toMatch(/^AGY_ERROR: \{"short_error":/);
        expect(ctx.readLog({ key: "usage" })).toHaveLength(4);
      },
    );
  });

  it("[AC1] claude plugin and plugin marketplace log argv and can fail on request", async () => {
    await withFakes(
      { "claude:plugin": [{}, {}, { exitCode: 1, stderr: "marketplace unreachable\n" }] },
      async (ctx) => {
        expect(
          (await runFake(ctx, "claude", ["plugin", "marketplace", "add", "dragonfly25/dispatch"]))
            .code,
        ).toBe(0);
        expect((await runFake(ctx, "claude", ["plugin", "list", "--json"])).stdout).toBe("[]\n");
        expect(
          await runFake(ctx, "claude", ["plugin", "install", "dispatch@dispatch"]),
        ).toMatchObject({ code: 1, stderr: "marketplace unreachable\n" });
        expect(ctx.readLog({ cli: "claude", key: "plugin" }).map((e) => e.args)).toEqual([
          ["plugin", "marketplace", "add", "dragonfly25/dispatch"],
          ["plugin", "list", "--json"],
          ["plugin", "install", "dispatch@dispatch"],
        ]);
      },
    );
  });
});
