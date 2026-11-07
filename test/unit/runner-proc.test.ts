import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SpawnRequest } from "../../src/core/contracts.js";
import { DispatchError } from "../../src/core/errors.js";
import { assertDepthAllowed } from "../../src/runner/depth.js";
import { buildChildEnv } from "../../src/runner/env.js";
import { MAX_LINE_LENGTH, ProcessSpawner, TRUNCATION_MARKER } from "../../src/runner/proc.js";
import { bundleHelper } from "../helpers/bundle.js";
import { type FakesContext, withFakes } from "../support/index.js";
import { isAlive, sleep, waitFor } from "./fakes-helpers.js";

const NODE = process.execPath;
const BASE_ENV = { PATH: process.env.PATH ?? "/usr/bin:/bin" };

/**
 * Asserts that `pid` is gone. kill(pid, 0) still succeeds for a killed process that has not been
 * reaped yet (a grandchild is reaped by launchd/init a moment after its parent died, which can
 * take long on a loaded macOS runner), so poll with a bound instead of checking once.
 */
async function expectDead(pid: number): Promise<void> {
  const deadline = performance.now() + 15_000;
  while (isAlive(pid)) {
    if (performance.now() > deadline) {
      const state = spawnSync("ps", ["-o", "pid,ppid,pgid,stat,command", "-p", String(pid)], {
        encoding: "utf8",
      }).stdout;
      throw new Error(`process ${pid} is still alive after the group was killed:\n${state}`);
    }
    await sleep(50);
  }
}

/** Waits until the hang_ignore_term fake reported its grandchild pid. */
const grandchildLogged = (ctx: FakesContext) =>
  waitFor(() => {
    const e = ctx.readLog()[0];
    return e?.grandchildPid ? e : undefined;
  }, 20_000);

interface Collected {
  lines: { stream: "stdout" | "stderr"; line: string; at: number }[];
  stdout: string[];
  stderr: string[];
}

/** Runs `node -e script` through a ProcessSpawner and collects the lines. */
async function runNode(
  script: string,
  req: Partial<SpawnRequest> = {},
  spawner = new ProcessSpawner(),
) {
  const lines: Collected["lines"] = [];
  const result = await spawner.spawn({
    binary: NODE,
    argv: ["-e", script],
    env: BASE_ENV,
    cwd: tmpdir(),
    onLine: (stream, line) => lines.push({ stream, line, at: performance.now() }),
    ...req,
  });
  return {
    result,
    lines,
    stdout: lines.filter((l) => l.stream === "stdout").map((l) => l.line),
    stderr: lines.filter((l) => l.stream === "stderr").map((l) => l.line),
  };
}

describe("ProcessSpawner: basics", () => {
  it("returns exit code 0 and streams stdout/stderr lines", async () => {
    const r = await runNode("console.log('a');console.error('b');console.log('c')");
    expect(r.result).toEqual({ exitCode: 0, signal: null, timedOut: false });
    expect(r.stdout).toEqual(["a", "c"]);
    expect(r.stderr).toEqual(["b"]);
  });

  it("reports a non-zero exit code", async () => {
    const r = await runNode("process.exit(7)");
    expect(r.result).toEqual({ exitCode: 7, signal: null, timedOut: false });
  });

  it("works without an onLine callback", async () => {
    const r = await new ProcessSpawner().spawn({
      binary: NODE,
      argv: ["-e", "console.log('x')"],
      env: BASE_ENV,
      cwd: tmpdir(),
    });
    expect(r.exitCode).toBe(0);
  });

  it("gives the child exactly req.env (no inheritance) and honours cwd", async () => {
    process.env.PARENT_ONLY_CANARY = "leak";
    try {
      const dir = mkdtempSync(join(tmpdir(), "dispatch-proc-"));
      const r = await runNode(
        "console.log(JSON.stringify(Object.keys(process.env).sort()));console.log(process.cwd())",
        { env: { ...BASE_ENV, ONLY_THIS: "1" }, cwd: dir },
      );
      const keys: string[] = JSON.parse(r.stdout[0] ?? "[]");
      // macOS adds __CF_USER_TEXT_ENCODING to every process on its own.
      expect(keys.filter((k) => k !== "__CF_USER_TEXT_ENCODING")).toEqual(["ONLY_THIS", "PATH"]);
      expect(r.stdout[1]).toBe(realpathSync(dir));
      rmSync(dir, { recursive: true, force: true });
    } finally {
      delete process.env.PARENT_ONLY_CANARY;
    }
  });

  it("does not use a shell: metacharacters in argv stay literal", async () => {
    const out = await runNode("console.log(process.argv.slice(1).join('|'))", {
      argv: ["-e", "console.log(process.argv.slice(1).join('|'))", "a;echo pwned", "$HOME", "`id`"],
    });
    expect(out.stdout).toEqual(["a;echo pwned|$HOME|`id`"]);
  });

  it("starts the child as leader of a new process group", async () => {
    const r = await runNode(
      "const {execFileSync}=require('child_process');" +
        "console.log(execFileSync('ps',['-o','pgid=','-p',String(process.pid)]).toString().trim()+' '+process.pid)",
    );
    const [pgid, pid] = (r.stdout[0] ?? "").split(" ");
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(String(process.pid));
  });

  it("writes stdin and closes it", async () => {
    const r = await runNode("process.stdin.pipe(process.stdout)", { stdin: "one\ntwo\n" });
    expect(r.stdout).toEqual(["one", "two"]);
    expect(r.result.exitCode).toBe(0);
  });

  it("ignores stdin when none is given (the child sees EOF at once)", async () => {
    const r = await runNode(
      "let n=0;process.stdin.on('data',()=>n++).on('end',()=>console.log('eof',n))",
    );
    expect(r.stdout).toEqual(["eof 0"]);
  });

  it("survives a child that never reads a large stdin (EPIPE)", async () => {
    const r = await runNode("process.exit(0)", { stdin: "x".repeat(4 << 20) });
    expect(r.result.exitCode).toBe(0);
  });

  it("rejects with a DispatchError when the binary does not exist", async () => {
    const p = new ProcessSpawner().spawn({
      binary: "/nonexistent/dispatch-test-binary",
      argv: [],
      env: BASE_ENV,
      cwd: tmpdir(),
    });
    await expect(p).rejects.toBeInstanceOf(DispatchError);
    await expect(p).rejects.toMatchObject({ code: "spawn.failed" });
  });

  it("an onLine callback that throws does not break the run", async () => {
    let calls = 0;
    const r = await new ProcessSpawner().spawn({
      binary: NODE,
      argv: ["-e", "console.log(1);console.log(2)"],
      env: BASE_ENV,
      cwd: tmpdir(),
      onLine: () => {
        calls++;
        throw new Error("consumer bug");
      },
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toBe(2);
  });
});

describe("ProcessSpawner: line buffering", () => {
  it("joins partial chunks, strips CRLF and flushes a last line without newline", async () => {
    const r = await runNode(
      "process.stdout.write('a');setTimeout(()=>process.stdout.write('b\\r\\nc\\n'),60);" +
        "setTimeout(()=>process.stdout.write('d\\n\\ne'),120)",
    );
    expect(r.stdout).toEqual(["ab", "c", "d", "", "e"]);
  });

  it("does not split a multi-byte character across chunks", async () => {
    const r = await runNode(
      "const b=Buffer.from('h\\u00e9llo \\u20ac\\n');process.stdout.write(b.subarray(0,2));" +
        "setTimeout(()=>process.stdout.write(b.subarray(2,8)),60);setTimeout(()=>process.stdout.write(b.subarray(8)),120)",
    );
    expect(r.stdout).toEqual(["héllo €"]);
  });

  it("keeps stdout and stderr lines separate", async () => {
    const r = await runNode(
      "process.stdout.write('o1');process.stderr.write('e1\\n');setTimeout(()=>process.stdout.write('o2\\n'),60)",
    );
    expect(r.stdout).toEqual(["o1o2"]);
    expect(r.stderr).toEqual(["e1"]);
  });

  it("caps very long lines at 1 MB with a truncation marker and recovers on the next line", async () => {
    const r = await runNode(
      "process.stdout.write('x'.repeat(2*1024*1024+17));process.stdout.write('\\nafter\\n')",
    );
    expect(r.stdout).toHaveLength(2);
    expect(r.stdout[0]).toBe("x".repeat(MAX_LINE_LENGTH) + TRUNCATION_MARKER);
    expect(r.stdout[1]).toBe("after");
  });

  it("truncates a long last line that has no trailing newline", async () => {
    const spawner = new ProcessSpawner({ maxLineLength: 10 });
    const r = await runNode("process.stdout.write('0123456789ABCDEF')", {}, spawner);
    expect(r.stdout).toEqual([`0123456789${TRUNCATION_MARKER}`]);
  });

  it("does not truncate a line of exactly the maximum length", async () => {
    const spawner = new ProcessSpawner({ maxLineLength: 10 });
    const r = await runNode("console.log('0123456789');console.log('ab\\r')", {}, spawner);
    expect(r.stdout).toEqual(["0123456789", "ab"]);
  });
});

describe("ProcessSpawner: fake CLIs", () => {
  it("[UC13] slow output is streamed line by line, not buffered until exit", async () => {
    await withFakes(
      { claude: [{ scenario: "slow", delayMs: 150, events: ["l1", "l2", "l3", "l4"] }] },
      async (ctx) => {
        const { lines, result } = await runNode("", {
          binary: "claude",
          argv: ["-p"],
          env: ctx.env,
          stdin: "go",
        });
        expect(result.exitCode).toBe(0);
        expect(lines).toHaveLength(4);
        const gaps = lines.slice(1).map((l, i) => l.at - (lines[i]?.at ?? 0));
        for (const gap of gaps) expect(gap).toBeGreaterThan(80);
      },
    );
  });

  it("[UC13] a crash is reported as exit code (and as a signal when killed by one)", async () => {
    await withFakes(
      {
        claude: [
          { scenario: "crash", lines: 2 },
          { scenario: "crash", signal: "SIGABRT" },
        ],
      },
      async (ctx) => {
        const req = { binary: "claude", argv: ["-p"], env: ctx.env, stdin: "x" };
        const first = await runNode("", req);
        expect(first.result).toEqual({ exitCode: 139, signal: null, timedOut: false });
        expect(first.stderr.join("\n")).toContain("Segmentation fault");
        expect(first.lines.filter((l) => l.stream === "stdout")).toHaveLength(2);

        const second = await runNode("", req);
        expect(second.result).toEqual({ exitCode: null, signal: "SIGABRT", timedOut: false });
      },
    );
  });

  it("[UC13] hang_ignore_term: SIGTERM is ignored, SIGKILL after the grace kills child AND grandchild", async () => {
    await withFakes(
      { claude: [{ scenario: "hang_ignore_term", maxLifetimeMs: 30_000 }] },
      async (ctx) => {
        const started = performance.now();
        const { result } = await runNode("", {
          binary: "claude",
          argv: ["-p"],
          env: ctx.env,
          stdin: "x",
          timeoutMs: 3000,
          killGraceMs: 600,
        });
        const elapsed = performance.now() - started;
        const entry = ctx.readLog()[0];
        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        expect(entry?.sigtermCount).toBe(1); // SIGTERM was delivered and ignored
        expect(elapsed).toBeGreaterThanOrEqual(3000 + 600 - 50); // the grace period was honoured
        expect(elapsed).toBeLessThan(10_000);

        const child = entry?.pid as number;
        const grandchild = entry?.grandchildPid as number;
        expect(entry?.pgid).toBe(child);
        expect(grandchild).toBeGreaterThan(0);
        await expectDead(child);
        await expectDead(grandchild);
        expect(() => process.kill(grandchild, 0)).toThrow();
      },
    );
  });

  it("[UC13] a cooperative child dies on SIGTERM and the run does not wait for the grace", async () => {
    await withFakes({ claude: [{ scenario: "slow", delayMs: 2000 }] }, async (ctx) => {
      const started = performance.now();
      const { result } = await runNode("", {
        binary: "claude",
        argv: ["-p"],
        env: ctx.env,
        stdin: "x",
        timeoutMs: 700,
        killGraceMs: 8000,
      });
      expect(result.timedOut).toBe(true);
      expect(performance.now() - started).toBeLessThan(5000);
    });
  });

  it("[UC13] AbortSignal kills the group like a timeout but without timedOut", async () => {
    await withFakes(
      { claude: [{ scenario: "hang_ignore_term", maxLifetimeMs: 30_000 }] },
      async (ctx) => {
        const ac = new AbortController();
        const run = runNode("", {
          binary: "claude",
          argv: ["-p"],
          env: ctx.env,
          stdin: "x",
          killGraceMs: 400,
          signal: ac.signal,
        });
        const entry = await grandchildLogged(ctx);
        ac.abort();
        const { result } = await run;
        expect(result.timedOut).toBe(false);
        expect(result.signal).toBe("SIGKILL");
        await expectDead(entry.pid);
        await expectDead(entry.grandchildPid as number);
      },
    );
  });

  it("an already-aborted signal does not spawn anything", async () => {
    await withFakes({ claude: [{ scenario: "slow" }] }, async (ctx) => {
      const r = await runNode("", {
        binary: "claude",
        argv: ["-p"],
        env: ctx.env,
        signal: AbortSignal.abort(),
      });
      expect(r.result).toEqual({ exitCode: null, signal: null, timedOut: false });
      expect(ctx.readLog()).toHaveLength(0);
    });
  });

  it("abort after the child finished is harmless", async () => {
    const ac = new AbortController();
    const r = await runNode("console.log('ok')", { signal: ac.signal });
    ac.abort();
    expect(r.result.exitCode).toBe(0);
  });
});

describe("ProcessSpawner: stray processes and timeouts", () => {
  it("[UC13] reaps background processes left in the group by a child that exited by itself", async () => {
    const r = await runNode(
      "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});" +
        "console.log(c.pid);c.unref()",
      { killGraceMs: 300 },
    );
    expect(r.result.exitCode).toBe(0);
    const stray = Number(r.stdout[0]);
    expect(stray).toBeGreaterThan(0);
    await expectDead(stray);
  });

  it("does not wait forever for a detached escapee that holds the pipes", async () => {
    const started = performance.now();
    const r = await runNode(
      "const c=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},3000)'],{detached:true,stdio:['ignore','inherit','inherit']});" +
        "console.log(c.pid);c.unref()",
    );
    expect(r.result.exitCode).toBe(0);
    expect(performance.now() - started).toBeLessThan(2500);
    process.kill(Number(r.stdout[0]), "SIGKILL"); // not ours to reap: it left the group on purpose
  });

  it("[UC13] the timeout uses the injected monotonic clock", async () => {
    // A clock running 10x fast: a 5 s timeout fires after ~0.5 s of real time.
    const t0 = performance.now();
    const fast = new ProcessSpawner({
      clock: { monotonicMs: () => (performance.now() - t0) * 10 },
    });
    const started = performance.now();
    const r = await runNode(
      "setTimeout(()=>{},20000)",
      { timeoutMs: 5000, killGraceMs: 500 },
      fast,
    );
    const elapsed = performance.now() - started;
    expect(r.result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(3000);
  });

  it("[UC13] a clock that runs slower than real time delays the timeout (re-armed, not trusted)", async () => {
    const t0 = performance.now();
    const slow = new ProcessSpawner({ clock: { monotonicMs: () => (performance.now() - t0) / 4 } });
    const started = performance.now();
    const r = await runNode("setTimeout(()=>{},20000)", { timeoutMs: 150, killGraceMs: 500 }, slow);
    expect(r.result.timedOut).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150 * 4 - 100);
  });

  it("[UC13] wall-clock jumps do not trigger or suppress the timeout", async () => {
    const realNow = Date.now.bind(Date);
    const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 365 * 24 * 3600 * 1000);
    try {
      const r = await runNode("setTimeout(()=>console.log('fine'),300)", { timeoutMs: 5000 });
      expect(r.result).toEqual({ exitCode: 0, signal: null, timedOut: false });
      expect(r.stdout).toEqual(["fine"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("a child finishing before the timeout is not marked timed out and clears the timer", async () => {
    const r = await runNode("console.log('quick')", { timeoutMs: 60_000 });
    expect(r.result).toEqual({ exitCode: 0, signal: null, timedOut: false });
  });

  it("a timeout of 0 fires at once", async () => {
    const r = await runNode("setTimeout(()=>{},20000)", { timeoutMs: 0, killGraceMs: 300 });
    expect(r.result.timedOut).toBe(true);
  });
});

describe("ProcessSpawner: parent signals", () => {
  it("[UC13] SIGTERM to the parent in-process terminates every running group (second signal escalates)", async () => {
    await withFakes(
      { claude: [{ scenario: "hang_ignore_term", maxLifetimeMs: 30_000 }] },
      async (ctx) => {
        // A listener keeps the default action (terminate the test worker) away; the handler under
        // test only re-raises when nobody else listens.
        const noop = (): void => {};
        process.on("SIGTERM", noop);
        try {
          const run = runNode("", {
            binary: "claude",
            argv: ["-p"],
            env: ctx.env,
            stdin: "x",
            killGraceMs: 20_000,
          });
          const entry = await grandchildLogged(ctx);
          process.emit("SIGTERM");
          await waitFor(() => ctx.readLog()[0]?.sigtermCount === 1);
          await sleep(200);
          expect(isAlive(entry.pid)).toBe(true); // ignoring SIGTERM, grace is 20 s
          process.emit("SIGTERM"); // impatient: SIGKILL right away
          const { result } = await run;
          expect(result.timedOut).toBe(false);
          expect(result.signal).toBe("SIGKILL");
          await expectDead(entry.pid);
          await expectDead(entry.grandchildPid as number);
        } finally {
          process.off("SIGTERM", noop);
        }
      },
    );
  });

  it("the parent's exit hook kills any group that is still running", async () => {
    const before = new Set(process.listeners("exit"));
    const run = runNode("setInterval(()=>{},1000)", { killGraceMs: 200 });
    const hook = process.listeners("exit").find((l) => !before.has(l));
    expect(hook).toBeDefined();
    await sleep(150);
    (hook as () => void)();
    const { result } = await run;
    expect(result.signal).toBe("SIGKILL");
  });

  it("registers its process handlers per spawn and removes them afterwards", async () => {
    const count = () => process.listenerCount("SIGINT") + process.listenerCount("SIGTERM");
    const before = count();
    const run = runNode("setTimeout(()=>{},300)");
    await sleep(50);
    expect(count()).toBe(before + 2);
    await run;
    expect(count()).toBe(before);
  });
});

describe("ProcessSpawner: parent signal in a real helper process [UC13]", () => {
  let dir: string;
  let helper: string;

  beforeAll(async () => {
    const bundled = await bundleHelper("spawn-helper");
    dir = bundled.dir;
    helper = bundled.file;
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "[UC13] %s to the parent leaves no orphans (child and grandchild die)",
    async (sig) => {
      await withFakes(
        { claude: [{ scenario: "hang_ignore_term", maxLifetimeMs: 30_000 }] },
        async (ctx) => {
          const req = { binary: "claude", argv: ["-p"], env: ctx.env, cwd: tmpdir(), stdin: "x" };
          const req2 = { ...req, killGraceMs: 400 };
          const parent: ChildProcess = spawn(NODE, [helper, JSON.stringify(req2)], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let out = "";
          parent.stdout?.on("data", (d) => {
            out += d;
          });
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (res) => parent.on("close", (code, signal) => res({ code, signal })),
          );
          const entry = await grandchildLogged(ctx);
          await waitFor(() => out.includes("stdout:"), 20_000);
          const child = entry.pid;
          const grandchild = entry.grandchildPid as number;
          expect(isAlive(child)).toBe(true);
          expect(isAlive(grandchild)).toBe(true);

          parent.kill(sig);
          const ended = await exited;
          // The helper re-raises the signal after cleaning up, so it dies the default way. Accept the
          // shell-style exit code too: a runtime that exits instead of dying by the signal reports it.
          const signo = sig === "SIGINT" ? 2 : 15;
          expect(ended.signal === sig || ended.code === 128 + signo).toBe(true);
          await expectDead(child);
          await expectDead(grandchild);
        },
      );
    },
    60_000,
  );
});

describe("[SEC-env] canaries through the real spawner", () => {
  const canaryParent = {
    HOME: "/home/u",
    USER: "u",
    LANG: "C.UTF-8",
    CANARY_SECRET: "canary-secret-0123456789",
    ANTHROPIC_API_KEY: "sk-ant-api03-CANARY",
    OPENAI_API_KEY: "sk-openai-CANARY",
    GITHUB_TOKEN: "ghp_CANARYCANARYCANARY",
    NODE_OPTIONS: "--max-old-space-size=1",
    CLAUDECODE: "1",
    CODEX_THREAD_ID: "thread-canary",
  };
  const ALLOWED = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "TMPDIR",
    "SHELL",
    "TERM",
    "DISPATCH_DEPTH",
    "DISPATCH_RUN_ID",
    // Added by /bin/sh itself (the fake CLI is a shell shim), not by Dispatch.
    "PWD",
    "OLDPWD",
    "SHLVL",
    "_",
    "__CF_USER_TEXT_ENCODING", // macOS adds it to every process
  ]);

  it("[SEC-env] the fake CLI sees only allow-listed keys plus DISPATCH_* and never a canary value", async () => {
    await withFakes({ claude: [{ scenario: "leak_secret" }] }, async (ctx) => {
      const { env, secrets } = buildChildEnv({
        parentEnv: { ...canaryParent, PATH: ctx.env.PATH },
        passthrough: ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS", "CLAUDECODE"],
        extra: {},
        depth: 0,
        runId: "run-sec-env",
      });
      const r = await runNode("", {
        binary: "claude",
        argv: ["-p"],
        env,
        stdin: "x",
      });
      expect(r.result.exitCode).toBe(0);
      const seen = ctx.readLog()[0]?.env ?? {};
      const stray = Object.keys(seen).filter((k) => !ALLOWED.has(k));
      expect(stray).toEqual([]);
      expect(seen.DISPATCH_DEPTH).toBe("1");
      expect(seen.DISPATCH_RUN_ID).toBe("run-sec-env");
      expect(seen.TERM).toBe("dumb");
      expect(JSON.stringify(seen)).not.toMatch(/CANARY|canary-secret|sk-ant|ghp_/i);
      // The canary values are handed to the redactor.
      expect(secrets).toEqual(
        expect.arrayContaining([
          canaryParent.CANARY_SECRET,
          canaryParent.ANTHROPIC_API_KEY,
          canaryParent.OPENAI_API_KEY,
          canaryParent.GITHUB_TOKEN,
          canaryParent.NODE_OPTIONS,
          canaryParent.CODEX_THREAD_ID,
        ]),
      );
    });
  });
});

describe("recursion guard through the recurse scenario [UC13][SEC-env]", () => {
  let dir: string;
  let nested: string;

  beforeAll(async () => {
    const bundled = await bundleHelper("nested-dispatch");
    dir = bundled.dir;
    nested = bundled.file;
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("[UC13] a nested `dispatch` inside the child is rejected as recursion (exit 3)", async () => {
    await withFakes({ claude: [{ scenario: "recurse" }] }, async (ctx) => {
      // Top-level process: depth 0 is allowed...
      const depth = assertDepthAllowed({}, 1);
      const { env } = buildChildEnv({
        parentEnv: { PATH: ctx.env.PATH },
        passthrough: [],
        extra: { DISPATCH_RECURSE_CMD: `"${NODE}" "${nested}" 1` },
        depth,
        runId: "run-rec",
      });
      const r = await runNode("", { binary: "claude", argv: ["-p"], env, stdin: "x" });
      expect(r.result.exitCode).toBe(0);
      // ...but the child's own `dispatch` call sees DISPATCH_DEPTH=1 and refuses.
      const recursed = ctx.readLog()[0]?.recurse;
      expect(recursed?.exitCode).toBe(3);
      expect(recursed?.stdout).toContain("outcome=rejected reason=recursion");
      expect(recursed?.stderr).toContain("recursion refused");
    });
  });

  it("a raised max_depth lets the nested call through", async () => {
    await withFakes({ claude: [{ scenario: "recurse" }] }, async (ctx) => {
      const { env } = buildChildEnv({
        parentEnv: { PATH: ctx.env.PATH },
        passthrough: [],
        extra: { DISPATCH_RECURSE_CMD: `"${NODE}" "${nested}" 2` },
        depth: 0,
      });
      await runNode("", { binary: "claude", argv: ["-p"], env, stdin: "x" });
      const recursed = ctx.readLog()[0]?.recurse;
      expect(recursed?.exitCode).toBe(0);
      expect(recursed?.stdout).toContain("allowed depth=1");
    });
  });
});
