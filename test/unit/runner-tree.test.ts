/**
 * Windows port of the runner's process handling: tree termination (taskkill argv), the supervisor
 * liveness probe (PowerShell argv), the spawn shape and the cancel-request protocol. Every Windows
 * branch runs here on macOS/Linux through an injected `platform: "win32"` and fake helpers.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { RunRecord, RunResult } from "../../src/core/contracts.js";
import type { ResolveFs } from "../../src/platform/resolve.js";
import { CANCEL_FILE, CANCELLED, cancelRequested, requestCancel } from "../../src/runner/detach.js";
import { layerEnv } from "../../src/runner/exec.js";
import { ProcessSpawner } from "../../src/runner/proc.js";
import { runRpcSession } from "../../src/runner/rpc.js";
import {
  clearBareCommandCache,
  isBareCommand,
  spawnCommandFor,
  type ToSpawn,
} from "../../src/runner/spawn.js";
import {
  killTree,
  type ProcessTree,
  pidExists,
  processTree,
  runSync,
  type SignalFn,
  spawnDetachedFor,
  systemRoot,
  taskkillArgs,
  taskkillPath,
} from "../../src/runner/tree.js";
import {
  cancelRun,
  makeSupervisorAlive,
  powershellPath,
  startTimeArgs,
  type WaitStore,
} from "../../src/runner/wait.js";

const WIN_ENV = { SystemRoot: "D:\\Win" };
/** Lets a real POSIX child run under `platform: "win32"` (its node has no `.exe`). */
const asIs: ToSpawn = (command, args) => ({ command, args: [...args] });
const tmp = mkdtempSync(join(tmpdir(), "dispatch-tree-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** Records helper invocations and answers with `status`. */
function recorder(status: number | null = 0) {
  const calls: { command: string; args: readonly string[] }[] = [];
  return {
    calls,
    run: (command: string, args: readonly string[]) => {
      calls.push({ command, args });
      return status;
    },
  };
}

describe("killTree / taskkill", () => {
  it("builds the absolute taskkill path from %SystemRoot% (any case), never a PATH lookup", () => {
    expect(taskkillPath(WIN_ENV, "win32")).toBe("D:\\Win\\System32\\taskkill.exe");
    expect(taskkillPath({ SYSTEMROOT: "E:\\W" }, "win32")).toBe("E:\\W\\System32\\taskkill.exe");
    expect(taskkillPath({ windir: "F:\\W" }, "win32")).toBe("F:\\W\\System32\\taskkill.exe");
    expect(taskkillPath({}, "win32")).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(systemRoot({}, "win32")).toBe("C:\\Windows");
  });

  it("win32: polite is `/PID n /T`, forced adds `/F`; delivery is taskkill's exit 0", () => {
    const ok = recorder(0);
    expect(killTree(4242, { force: false, platform: "win32", env: WIN_ENV, run: ok.run })).toBe(
      true,
    );
    expect(killTree(4242, { force: true, platform: "win32", env: WIN_ENV, run: ok.run })).toBe(
      true,
    );
    expect(ok.calls).toEqual([
      { command: "D:\\Win\\System32\\taskkill.exe", args: ["/PID", "4242", "/T"] },
      { command: "D:\\Win\\System32\\taskkill.exe", args: ["/PID", "4242", "/T", "/F"] },
    ]);
    const refused = recorder(1);
    expect(killTree(7, { force: false, platform: "win32", run: refused.run })).toBe(false);
    expect(taskkillArgs(9, true)).toEqual(["/PID", "9", "/T", "/F"]);
  });

  it("refuses invalid pids without running anything", () => {
    const r = recorder(0);
    for (const pid of [0, -5, 1.5, Number.NaN]) {
      expect(killTree(pid, { force: true, platform: "win32", run: r.run })).toBe(false);
    }
    expect(r.calls).toEqual([]);
    expect(pidExists(0)).toBe(false);
    expect(pidExists(-1)).toBe(false);
  });

  it("POSIX: signals the process group (negative pid), SIGTERM then SIGKILL", () => {
    const sent: [number, string | number][] = [];
    const kill: SignalFn = (pid, sig) => {
      sent.push([pid, sig]);
    };
    expect(killTree(50, { force: false, platform: "linux", kill })).toBe(true);
    expect(killTree(50, { force: true, platform: "darwin", kill })).toBe(true);
    expect(sent).toEqual([
      [-50, "SIGTERM"],
      [-50, "SIGKILL"],
    ]);
    const gone: SignalFn = () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    expect(killTree(50, { force: true, platform: "linux", kill: gone })).toBe(false);
  });

  it("pidExists treats EPERM as alive and anything else as gone", () => {
    const eperm: SignalFn = () => {
      throw Object.assign(new Error("EPERM"), { code: "EPERM" });
    };
    const esrch: SignalFn = () => {
      throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    };
    expect(pidExists(10, eperm)).toBe(true);
    expect(pidExists(10, esrch)).toBe(false);
    expect(pidExists(process.pid)).toBe(true);
  });

  it("processTree: win32 watches the root pid and cannot outlive it; POSIX watches the group", () => {
    const seen: [number, string | number][] = [];
    const kill: SignalFn = (pid, sig) => {
      seen.push([pid, sig]);
    };
    const r = recorder(0);
    const win = processTree(77, { platform: "win32", env: WIN_ENV, run: r.run, kill });
    expect(win.outlivesRoot).toBe(false);
    expect(win.alive()).toBe(true);
    expect(win.terminate()).toBe(true);
    expect(win.kill()).toBe(true);
    expect(r.calls.map((c) => c.args)).toEqual([
      ["/PID", "77", "/T"],
      ["/PID", "77", "/T", "/F"],
    ]);
    const posix = processTree(77, { platform: "linux", kill });
    expect(posix.outlivesRoot).toBe(true);
    expect(posix.alive()).toBe(true);
    expect(seen).toEqual([
      [77, 0],
      [-77, 0],
    ]);
    const dead = processTree(77, {
      platform: "linux",
      kill: () => {
        throw new Error("ESRCH");
      },
    });
    expect(dead.alive()).toBe(false);
  });

  it("spawnDetachedFor: a new process group on POSIX, the shared console on Windows", () => {
    expect(spawnDetachedFor("linux")).toBe(true);
    expect(spawnDetachedFor("darwin")).toBe(true);
    expect(spawnDetachedFor("win32")).toBe(false);
  });

  it("runSync returns the exit status, and null when the helper cannot start", () => {
    expect(runSync(process.execPath, ["-e", "process.exit(3)"])).toBe(3);
    expect(runSync(join(tmp, "no-such-binary"), [])).toBeNull();
  });
});

/** A fake tree over a real child: `terminate` is refused like taskkill on a console program. */
function fakeWinTree(log: string[]) {
  return (pid: number): ProcessTree => ({
    outlivesRoot: false,
    alive: () => pidExists(pid),
    terminate: () => {
      log.push(`terminate ${pid}`);
      return false;
    },
    kill: () => {
      log.push(`kill ${pid}`);
      try {
        process.kill(pid, "SIGKILL");
        return true;
      } catch {
        return false;
      }
    },
  });
}

describe("ProcessSpawner on win32 (injected tree)", () => {
  it("a refused polite request escalates to the forced kill at once (no grace wait)", async () => {
    const log: string[] = [];
    const spawner = new ProcessSpawner({
      platform: "win32",
      tree: fakeWinTree(log),
      toSpawn: asIs,
    });
    const t0 = Date.now();
    const r = await spawner.spawn({
      binary: process.execPath,
      argv: ["-e", "setInterval(() => {}, 1000)"],
      env: { PATH: process.env.PATH ?? "" },
      cwd: tmp,
      timeoutMs: 100,
      killGraceMs: 30_000,
    });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(log.map((l) => l.split(" ")[0])).toEqual(["terminate", "kill"]);
  });

  it("nothing is sent to the pid of a child that already exited (pids recycle on Windows)", async () => {
    const log: string[] = [];
    const spawner = new ProcessSpawner({
      platform: "win32",
      tree: fakeWinTree(log),
      toSpawn: asIs,
    });
    const r = await spawner.spawn({
      binary: process.execPath,
      argv: ["-e", "process.exit(0)"],
      env: {},
      cwd: tmp,
    });
    expect(r.exitCode).toBe(0);
    expect(log).toEqual([]);
  });
});

describe("runRpcSession on win32 (injected tree)", () => {
  it("forces the tree of a child that ignores stdin EOF; leaves an exited child alone", async () => {
    const log: string[] = [];
    await runRpcSession(
      {
        binary: process.execPath,
        argv: ["-e", "process.stdin.resume(); setInterval(() => {}, 1000)"],
        env: {},
        cwd: tmp,
        timeoutMs: 10_000,
        politeMs: 20,
        killGraceMs: 30_000,
        platform: "win32",
        toSpawn: asIs,
        tree: fakeWinTree(log),
      },
      async () => "done",
    );
    expect(log.map((l) => l.split(" ")[0])).toEqual(["terminate", "kill"]);

    const quiet: string[] = [];
    await runRpcSession(
      {
        binary: process.execPath,
        argv: ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()"],
        env: {},
        cwd: tmp,
        timeoutMs: 10_000,
        politeMs: 5_000,
        platform: "win32",
        toSpawn: asIs,
        tree: fakeWinTree(quiet),
      },
      async () => "done",
    );
    expect(quiet).toEqual([]);
  });

  it("POSIX default: a polite child is still signalled as a group (unchanged)", async () => {
    const child = spawn(process.execPath, ["-e", "0"]);
    await new Promise((r) => child.once("exit", r));
    const seen: string[] = [];
    await runRpcSession(
      {
        binary: process.execPath,
        argv: ["-e", "process.stdin.on('end', () => process.exit(0)); process.stdin.resume()"],
        env: {},
        cwd: tmp,
        timeoutMs: 10_000,
        platform: "linux",
        tree: () => ({
          outlivesRoot: true,
          alive: () => false,
          terminate: () => {
            seen.push("terminate");
            return false;
          },
          kill: () => {
            seen.push("kill");
            return false;
          },
        }),
      },
      async () => 1,
    );
    expect(seen).toEqual(["terminate", "kill"]);
  });
});

describe("supervisorAlive", () => {
  const created = "2026-11-13T10:00:00.000Z";
  const alive: SignalFn = () => true;

  it("win32: asks Windows PowerShell (absolute path) for the start time of a validated pid", () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const check = makeSupervisorAlive({
      platform: "win32",
      env: WIN_ENV,
      kill: alive,
      exec: (file, args) => {
        calls.push({ file, args });
        return "2026-11-13T10:00:01.1234567Z\r\n";
      },
    });
    expect(check(321, created)).toBe(true);
    expect(calls[0]?.file).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calls[0]?.args).toEqual(startTimeArgs(321));
    expect(calls[0]?.args.slice(0, 3)).toEqual(["-NoProfile", "-NonInteractive", "-Command"]);
    expect(calls[0]?.args[3]).toContain("Get-Process -Id 321 ");
    expect(powershellPath({}, "win32")).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(() => startTimeArgs(-1)).toThrow(RangeError);
    expect(() => startTimeArgs(1.5)).toThrow(RangeError);
  });

  it("win32: empty output is gone, a recycled pid is gone, unreadable or failing helper trusts the pid", () => {
    const answer = (out: string | Error) =>
      makeSupervisorAlive({
        platform: "win32",
        kill: alive,
        exec: () => {
          if (out instanceof Error) throw out;
          return out;
        },
      })(5, created);
    expect(answer("")).toBe(false);
    expect(answer("2026-11-12T10:00:00.0000000Z")).toBe(false);
    expect(answer("unknown")).toBe(true);
    expect(answer(new Error("ENOENT"))).toBe(true);
  });

  it("POSIX: parses ps, zombies and recycled pids are dead, ps exit 1 is dead", () => {
    const answer = (out: string | Error) =>
      makeSupervisorAlive({
        platform: "linux",
        kill: alive,
        exec: (file, args, env) => {
          expect(file).toBe("ps");
          expect(args).toEqual(["-o", "stat=,lstart=", "-p", "5"]);
          expect(env).toEqual({ PATH: "/bin:/usr/bin", LC_ALL: "C" });
          if (out instanceof Error) throw out;
          return out;
        },
      })(5, created);
    // `lstart` is local time; Date#toString() is a local-time form Date.parse reads back.
    const at = (deltaMs: number) => new Date(Date.parse(created) + deltaMs).toString();
    expect(answer(`S    ${at(1_000)}`)).toBe(true);
    expect(answer(`Z    ${at(1_000)}`)).toBe(false);
    expect(answer(`S    ${at(-86_400_000)}`)).toBe(false);
    expect(answer("S    garbage")).toBe(true);
    expect(answer("")).toBe(false);
    expect(answer(Object.assign(new Error("gone"), { status: 1 }))).toBe(false);
    expect(answer(Object.assign(new Error("no ps"), { status: 127 }))).toBe(true);
  });

  it("a pid that does not exist is dead without running any helper", () => {
    const check = makeSupervisorAlive({
      platform: "win32",
      kill: () => {
        throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      },
      exec: () => {
        throw new Error("must not run");
      },
    });
    expect(check(5, created)).toBe(false);
    expect(check(null, created)).toBe(false);
  });
});

describe("cancel request file", () => {
  it("requestCancel writes a 0600 file that cancelRequested sees; an absent dir fails softly", () => {
    const dir = mkdtempSync(join(tmp, "run-"));
    expect(cancelRequested(dir)).toBe(false);
    expect(requestCancel(dir, new Date("2026-11-13T10:00:00Z"))).toBe(true);
    expect(cancelRequested(dir)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, CANCEL_FILE), "utf8"))).toEqual({
      at: "2026-11-13T10:00:00.000Z",
    });
    if (process.platform !== "win32") {
      expect(statSync(join(dir, CANCEL_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(requestCancel(join(dir, "missing", "deeper"))).toBe(false);
  });
});

/** A one-run store for cancelRun. */
function fakeStore(pid: number | null, finishOnCancelFile?: string): WaitStore {
  let run: RunRecord = {
    runId: "r1",
    status: "running",
    createdAt: "2026-11-13T10:00:00.000Z",
    updatedAt: "2026-11-13T10:00:00.000Z",
    instance: null,
    pid,
    result: null,
  };
  return {
    getRun: async () => {
      if (finishOnCancelFile !== undefined && cancelRequested(finishOnCancelFile)) {
        const result = { runId: "r1", status: "completed", summary: CANCELLED } as RunResult;
        run = { ...run, status: "completed", result };
      }
      return run;
    },
    updateRun: async (_id, patch) => {
      run = { ...run, ...patch } as RunRecord;
      return run;
    },
    listEvents: () => [],
  };
}

const clock = (() => {
  let t = 0;
  return {
    now: () => new Date("2026-11-13T10:00:05.000Z"),
    monotonicMs: () => {
      t += 10;
      return t;
    },
  };
})();

describe("cancelRun on win32", () => {
  it("writes the request file and never TerminateProcess-signals the supervisor", async () => {
    const dir = mkdtempSync(join(tmp, "run-"));
    const signals: string[] = [];
    const taskkill = recorder(0);
    const result = await cancelRun(
      { store: fakeStore(42, dir), clock, runDir: () => dir, isAlive: () => true, pollMs: 1 },
      "r1",
      {
        platform: "win32",
        kill: (_pid, sig) => signals.push(sig),
        run: taskkill.run,
        env: WIN_ENV,
      },
    );
    expect(result.summary).toBe(CANCELLED);
    expect(cancelRequested(dir)).toBe(true);
    expect(signals).toEqual([]);
    expect(taskkill.calls).toEqual([]);
  });

  it("a supervisor that ignores the request is force-killed as a tree after the grace", async () => {
    const dir = mkdtempSync(join(tmp, "run-"));
    const taskkill = recorder(0);
    const result = await cancelRun(
      { store: fakeStore(42), clock, runDir: () => dir, isAlive: () => true, pollMs: 1 },
      "r1",
      { platform: "win32", graceMs: 50, run: taskkill.run, env: WIN_ENV },
    );
    expect(result.summary).toBe(CANCELLED);
    expect(taskkill.calls).toEqual([
      { command: "D:\\Win\\System32\\taskkill.exe", args: ["/PID", "42", "/T", "/F"] },
    ]);
  });

  it("without a run directory it still waits the grace", async () => {
    const taskkill = recorder(0);
    const notices: string[] = [];
    const result = await cancelRun(
      { store: fakeStore(42), clock, isAlive: () => true, pollMs: 1 },
      "r1",
      {
        platform: "win32",
        graceMs: 50,
        run: taskkill.run,
        env: WIN_ENV,
        onNotice: (m) => notices.push(m),
      },
    );
    expect(result.summary).toBe(CANCELLED);
    expect(taskkill.calls).toHaveLength(1);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/run directory of r1 not found/);
  });

  it("POSIX keeps SIGTERM and also leaves the request file", async () => {
    const dir = mkdtempSync(join(tmp, "run-"));
    const signals: string[] = [];
    await cancelRun(
      { store: fakeStore(42, dir), clock, runDir: () => dir, isAlive: () => true, pollMs: 1 },
      "r1",
      { platform: "linux", kill: (_pid, sig) => signals.push(sig) },
    );
    expect(signals).toEqual(["SIGTERM"]);
    expect(cancelRequested(dir)).toBe(true);
  });
});

describe("spawnCommandFor", () => {
  /** Fake Windows fs: only the listed absolute paths exist (case-insensitive). */
  const winFs = (...files: string[]): ResolveFs => {
    const set = new Set(files.map((f) => f.toLowerCase()));
    return { isExecutableFile: (p) => set.has(p.toLowerCase()), realpath: (p) => p };
  };
  const winEnv = {
    Path: "C:\\Program Files\\Git\\cmd;.;relative\\bin",
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
  };

  it("win32: a bare name is resolved to its absolute PATH entry, paths are converted", () => {
    const seen: string[] = [];
    const convert: ToSpawn = (b, a, o) => {
      seen.push(`${b} ${o?.platform}`);
      return b.endsWith(".cmd")
        ? { command: "node.exe", args: ["x.js", ...a] }
        : { command: b, args: [...a] };
    };
    const lookup = { env: winEnv, fs: winFs("C:\\Program Files\\Git\\cmd\\git.exe") };
    expect(spawnCommandFor("git", ["status"], "win32", convert, lookup)).toEqual({
      command: "C:\\Program Files\\Git\\cmd\\git.exe",
      args: ["status"],
    });
    expect(spawnCommandFor("C:\\npm\\codex.cmd", ["-v"], "win32", convert, lookup)).toEqual({
      command: "node.exe",
      args: ["x.js", "-v"],
    });
    expect(spawnCommandFor("git", [], "linux", convert).command).toBe("git");
    expect(seen).toEqual([
      "C:\\Program Files\\Git\\cmd\\git.exe win32",
      "C:\\npm\\codex.cmd win32",
      "git linux",
    ]);
    expect(isBareCommand("git")).toBe(true);
    for (const b of ["git.exe", "codex.cmd", "bin/git", "C:\\x\\git", "C:git"]) {
      expect(isBareCommand(b)).toBe(false);
    }
  });

  it("win32: a git.exe planted in the cwd or under a relative PATH entry is never chosen", () => {
    const cwd = "C:\\work\\repo";
    const planted = [
      `${cwd}\\git.exe`,
      `${cwd}\\git.com`,
      "git.exe",
      ".\\git.exe",
      "relative\\bin\\git.exe",
    ];
    const real = "C:\\Program Files\\Git\\cmd\\git.exe";
    const fs = winFs(...planted, real);
    const cmd = spawnCommandFor("git", ["apply"], "win32", undefined, { env: winEnv, fs });
    expect(cmd).toEqual({ command: real, args: ["apply"] });
    expect(planted.map((p) => p.toLowerCase())).not.toContain(cmd.command.toLowerCase());
  });

  it("win32: a bare name that is only in the cwd is refused instead of spawned", () => {
    const fs = winFs("C:\\work\\repo\\git.exe", "git.exe");
    expect(() =>
      spawnCommandFor("git", [], "win32", undefined, { env: { PATH: ".;bin" }, fs }),
    ).toThrow(expect.objectContaining({ code: "binary.not_found" }));
  });

  it("win32: PATHEXT order picks git.com before git.exe in the same dir; npm .cmd is unwrapped", () => {
    const fs = winFs("C:\\tools\\git.exe", "C:\\tools\\git.com");
    const env = { PATH: "C:\\tools" };
    expect(spawnCommandFor("git", [], "win32", undefined, { env, fs }).command).toBe(
      "C:\\tools\\git.com",
    );
    const convert: ToSpawn = (b, a) => ({ command: "node.exe", args: [b, ...a] });
    const shim = winFs("C:\\npm\\codex.cmd");
    expect(
      spawnCommandFor("codex", ["-v"], "win32", convert, { env: { PATH: "C:\\npm" }, fs: shim }),
    ).toEqual({ command: "node.exe", args: ["C:\\npm\\codex.cmd", "-v"] });
  });

  it("win32: the lookup is cached per name and PATH; a miss is not cached", () => {
    clearBareCommandCache();
    let probes = 0;
    const present = new Set(["c:\\tools\\git.exe"]);
    const fs: ResolveFs = {
      isExecutableFile: (p) => {
        probes++;
        return present.has(p.toLowerCase());
      },
      realpath: (p) => p,
    };
    const run = (PATH: string) =>
      spawnCommandFor("git", [], "win32", undefined, { env: { PATH }, fs });
    expect(run("C:\\tools").command).toBe("C:\\tools\\git.exe");
    const after = probes;
    present.clear();
    expect(run("C:\\tools").command).toBe("C:\\tools\\git.exe");
    expect(probes).toBe(after);
    expect(() => run("C:\\other")).toThrow(expect.objectContaining({ code: "binary.not_found" }));
    present.add("c:\\other\\git.exe");
    expect(run("C:\\other").command).toBe("C:\\other\\git.exe");
    clearBareCommandCache();
  });

  it("win32 with the real converter: a non-shim batch file is refused before anything starts", async () => {
    const spawner = new ProcessSpawner({ platform: "win32" });
    await expect(
      spawner.spawn({ binary: "C:\\x\\evil.bat", argv: [], env: {}, cwd: tmp }),
    ).rejects.toMatchObject({ code: "binary.unspawnable" });
  });
});

describe("layerEnv", () => {
  it("win32: replaces a variable under the spelling the parent already uses", () => {
    expect(layerEnv({ Path: "C:\\a", X: "1" }, { PATH: "C:\\b" }, "win32")).toEqual({
      Path: "C:\\b",
      X: "1",
    });
    expect(layerEnv({ Path: "/a" }, { PATH: "/b" }, "linux")).toEqual({ Path: "/a", PATH: "/b" });
    expect(layerEnv({ A: "1" }, undefined, "win32")).toEqual({ A: "1" });
  });
});
