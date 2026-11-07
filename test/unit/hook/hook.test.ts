import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { HookInput } from "../../../src/core/contracts.js";
import {
  HOOK_CACHE_FILE,
  type HookCache,
  hookDispatchHome,
  readHookCache,
  trustedRepoFor,
  writeHookCache,
} from "../../../src/hook/cache.js";
import { HOOK_HOSTS } from "../../../src/hook/handlers.js";
import { type HookHostTable, readLimited, runHook } from "../../../src/hook/run.js";
import { type TempHome, tempHome } from "../../support/temp.js";

let h: TempHome | undefined;
afterEach(() => h?.cleanup());

const seen: HookInput[] = [];
const table: HookHostTable = {
  codex: async () => ({
    SessionStart: async (input) => {
      seen.push(input);
      return { stdout: '{"hookSpecificOutput":{}}', exitCode: 0 };
    },
    PreToolUse: async () => ({ stdout: "deny", exitCode: 2 }),
    Weird: async () => ({ exitCode: 999 }),
    Boom: async () => {
      throw new Error("handler bug");
    },
  }),
};
const INPUT = JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: "/r" });

describe("runHook [UC9][AC5]", () => {
  it("routes to the host handler and returns its response", async () => {
    expect(await runHook(["codex", "SessionStart"], INPUT, table)).toEqual({
      stdout: '{"hookSpecificOutput":{}}',
      exitCode: 0,
    });
    expect(seen.at(-1)?.session_id).toBe("s");
    expect(await runHook(["codex", "PreToolUse"], INPUT, table)).toEqual({
      stdout: "deny",
      exitCode: 2,
    });
    expect(await runHook(["codex", "Weird"], INPUT, table)).toEqual({ exitCode: 0 });
  });

  it.each([
    ["unknown host", ["gemini", "SessionStart"], INPUT],
    ["prototype key as host", ["__proto__", "SessionStart"], INPUT],
    ["unknown event", ["codex", "Stop"], INPUT],
    ["prototype key as event", ["codex", "constructor"], INPUT],
    ["missing args", ["codex"], INPUT],
    ["malformed stdin", ["codex", "SessionStart"], "{not json"],
    ["array stdin", ["codex", "SessionStart"], "[]"],
    ["oversized stdin", ["codex", "SessionStart"], null],
    ["handler error", ["codex", "Boom"], INPUT],
  ])("%s → silent exit 0", async (_name, args, stdin) => {
    expect(await runHook(args, stdin, table)).toEqual({ exitCode: 0 });
  });

  it("ships the claude-code (WP22) and codex (WP27) hosts", () => {
    expect(Object.keys(HOOK_HOSTS)).toEqual(["claude-code", "codex"]);
  });

  it("readLimited enforces the size limit and survives stream errors", async () => {
    const ok = new PassThrough();
    const p1 = readLimited(ok, 10);
    ok.end("hello");
    expect(await p1).toBe("hello");
    const big = new PassThrough();
    const p2 = readLimited(big, 4);
    big.end("hello");
    expect(await p2).toBeNull();
    const bad = new PassThrough();
    const p3 = readLimited(bad);
    bad.emit("error", new Error("x"));
    expect(await p3).toBeNull();
  });
});

describe("hook cache", () => {
  const cache: HookCache = {
    version: 1,
    writtenAt: "2026-11-07T00:00:00.000Z",
    trustedRepos: [
      { root: "/w/repo", policyHash: "abc" },
      { root: "/w/repo/sub", policyHash: null },
    ],
    policy: { profile: "balance", hardMode: false, summary: "Delegate reviews to codex." },
  };

  it("round-trips atomically and rejects invalid data", () => {
    const t = tempHome();
    h = t;
    expect(readHookCache(t.dispatchHome)).toBeNull();
    writeHookCache(t.dispatchHome, cache);
    expect(readHookCache(t.dispatchHome)).toEqual(cache);
    writeFileSync(join(t.dispatchHome, HOOK_CACHE_FILE), JSON.stringify({ ...cache, version: 2 }));
    expect(readHookCache(t.dispatchHome)).toBeNull();
    writeFileSync(join(t.dispatchHome, HOOK_CACHE_FILE), "nope");
    expect(readHookCache(t.dispatchHome)).toBeNull();
    expect(() =>
      writeHookCache(t.dispatchHome, { ...cache, trustedRepos: [null] } as never),
    ).toThrow();
    expect(() => writeHookCache(join(t.dispatchHome, HOOK_CACHE_FILE, "x"), cache)).toThrow();
  });

  it("finds the most specific trusted repo and the Dispatch home", () => {
    expect(trustedRepoFor(cache, "/w/repo/sub/x")?.root).toBe("/w/repo/sub");
    expect(trustedRepoFor(cache, "/w/repo")?.root).toBe("/w/repo");
    expect(trustedRepoFor(cache, "/w/repository")).toBeNull();
    expect(hookDispatchHome({ DISPATCH_HOME: "/d", HOME: "/h" })).toBe("/d");
    expect(hookDispatchHome({ HOME: "/h" })).toBe("/h/.dispatch");
    expect(hookDispatchHome({})).toBeNull();
  });
});

const dist = resolve(import.meta.dirname, "../../../dist/hook.mjs");

/** Runs the built hook like a GUI-launched host would: empty env apart from a minimal PATH. */
function runDist(args: string[], input: string) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [dist, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  return { ms: performance.now() - t0, code: r.status, out: r.stdout, err: r.stderr };
}

describe.skipIf(!existsSync(dist))("dist/hook.mjs [UC9][AC5]", () => {
  it.each([
    ["unknown host", ["nohost", "SessionStart"], INPUT],
    ["unknown event", ["codex", "Nope"], INPUT],
    ["malformed stdin", ["codex", "SessionStart"], "{{{"],
    ["no args", [], ""],
  ])("%s → silent exit 0", (_n, args, input) => {
    expect(runDist(args, input)).toMatchObject({ code: 0, out: "", err: "" });
  });

  it("bundles neither zod nor SQLite", () => {
    const text = readFileSync(dist, "utf8");
    expect(text).not.toContain("node:sqlite");
    expect(text).not.toMatch(/\bzod\b/);
  });

  it("a single run completes well under the host's timeout (< 1 s)", () => {
    const r = runDist(["codex", "SessionStart"], INPUT);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(1000);
  });

  // [perf] Timing-sensitive, so opt-in: it flakes under parallel suite load. DISPATCH_PERF=1.
  it.runIf(process.env.DISPATCH_PERF === "1")("p95 latency < 80 ms over 20 runs", () => {
    runDist(["codex", "SessionStart"], INPUT); // warm the file cache
    const times = Array.from({ length: 20 }, () => runDist(["codex", "SessionStart"], INPUT).ms);
    times.sort((a, b) => a - b);
    const p95 = times[Math.ceil(0.95 * times.length) - 1] as number;
    expect(p95).toBeLessThan(80);
  });
});
