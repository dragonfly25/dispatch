import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { QuotaObservation } from "../../src/core/contracts.js";
import { resolveBinary } from "../../src/platform/resolve.js";
import { runReader } from "../../src/quota/reader.js";
import {
  AgyUsageReader,
  CodexAppServerReader,
  QuotaAuthError,
  QuotaFormatError,
} from "../../src/quota/readers/index.js";
import { RpcError, RpcTimeoutError } from "../../src/runner/rpc.js";
import { FakeClock } from "../stubs/index.js";
import { createFakes, type FakeSubConfig, type FakesContext, withFakes } from "../support/index.js";
import { isAlive, waitFor } from "./fakes-helpers.js";
import {
  byKind,
  instance,
  NodeSpawner,
  scriptedAppServer,
  writeScript,
} from "./quota-readers-helpers.js";

let home: string;
let clock: FakeClock;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "dispatch-readers-home-"));
  clock = new FakeClock(new Date());
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Runs `fn` against a codex reader that talks to the fake `codex app-server`. */
async function withCodex<T>(
  cfg: FakeSubConfig | FakeSubConfig[],
  fn: (reader: CodexAppServerReader, ctx: FakesContext, seen: QuotaObservation[]) => Promise<T>,
): Promise<T> {
  return withFakes({ "codex:app-server": cfg }, async (ctx) => {
    const seen: QuotaObservation[] = [];
    const reader = new CodexAppServerReader({
      clock,
      version: "9.9.9",
      env: { ...ctx.env, HOME: home, SECRET_TOKEN: "do-not-forward" },
      // As in production: an absolute path from the reader's own PATH (the fake codex).
      resolveBinary: (inst) =>
        resolveBinary("codex", { configured: inst.binary, env: ctx.env })?.path ?? "codex",
      onObservation: (o) => void seen.push(o),
    });
    return fn(reader, ctx, seen);
  });
}

describe("codex app-server reader [UC11]", () => {
  it("maps primary/secondary windows, performs the handshake and isolates the env", async () => {
    const primaryResetsAt = Math.floor(Date.now() / 1000) + 3600;
    await withCodex(
      { variant: "ok", primaryUsed: 42, secondaryUsed: 17, primaryResetsAt },
      async (reader, ctx, seen) => {
        const windows = await reader.read(instance({ configDir: "/tmp/codex-alt" }));
        expect(byKind(windows)["5h"]).toEqual({
          kind: "5h",
          usedPct: 42,
          resetAt: new Date(primaryResetsAt * 1000).toISOString(),
          source: "codex-app-server",
          readAt: clock.now().toISOString(),
          reliability: "real",
        });
        expect(byKind(windows).weekly).toMatchObject({ usedPct: 17, reliability: "real" });
        expect(seen).toEqual([]);
        expect(reader.lastExhausted("codex")).toBeUndefined();

        const log = ctx.readLog({ key: "app-server" })[0];
        expect(log?.args).toEqual(["app-server"]);
        expect(log?.env.CODEX_HOME).toBe("/tmp/codex-alt");
        expect(log?.env.HOME).toBe(home);
        expect(log?.env.TERM).toBe("dumb");
        expect(log?.env.SECRET_TOKEN).toBeUndefined();
        const rpc = log?.rpcReceived ?? [];
        expect(rpc.map((m) => m.method)).toEqual([
          "initialize",
          "initialized",
          "account/rateLimits/read",
        ]);
        expect(rpc[0]?.params).toEqual({
          clientInfo: { name: "dispatch", title: "Dispatch", version: "9.9.9" },
        });
        expect(rpc[1]?.id).toBeUndefined();
      },
    );
  });

  it("copes with notifications on/off and jsonrpc-tagged messages", async () => {
    for (const cfg of [{ notifications: false }, { jsonrpc: true }] satisfies FakeSubConfig[]) {
      await withCodex(cfg, async (reader) => {
        expect((await reader.read(instance())).map((w) => w.kind)).toEqual(["5h", "weekly"]);
      });
    }
  });

  it("[UC11] reports exhaustion: 100% window, resetAt of the exhausted window, observation", async () => {
    const primaryResetsAt = Math.floor(Date.now() / 1000) + 1800;
    await withCodex(
      { primaryUsed: 100, secondaryUsed: 30, primaryResetsAt },
      async (reader, _c, seen) => {
        const windows = await reader.read(instance());
        expect(byKind(windows)["5h"]?.usedPct).toBe(100);
        expect(byKind(windows).weekly?.usedPct).toBe(30);
        const resetAt = new Date(primaryResetsAt * 1000).toISOString();
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          instanceId: "codex",
          at: clock.now().toISOString(),
          exhausted: { resetAt, error: "codex usage limit reached (rate_limit_reached)" },
        });
        expect(reader.lastExhausted("codex")).toMatchObject({ resetAt });
      },
    );
  });

  it("raises the most used window to 100% when usage is disallowed without a full window", async () => {
    await withCodex(
      { primaryUsed: 60, secondaryUsed: 30, ordinaryUsageAllowed: false },
      async (reader, _c, seen) => {
        const windows = byKind(await reader.read(instance()));
        expect(windows["5h"]?.usedPct).toBe(100);
        expect(windows.weekly?.usedPct).toBe(30);
        expect(seen[0]?.exhausted?.error).toBe("codex usage limit reached");
      },
    );
  });

  it("uses the later reset when both windows are exhausted and clears the signal once usable", async () => {
    const soon = Math.floor(Date.now() / 1000) + 600;
    const later = soon + 86_400;
    await withCodex(
      [
        { primaryUsed: 100, secondaryUsed: 100, primaryResetsAt: soon, secondaryResetsAt: later },
        { primaryUsed: 5, secondaryUsed: 5 },
      ],
      async (reader, _c, seen) => {
        await reader.read(instance());
        expect(seen[0]?.exhausted?.resetAt).toBe(new Date(later * 1000).toISOString());
        await reader.read(instance());
        expect(reader.lastExhausted("codex")).toBeUndefined();
      },
    );
  });

  it("does not fail the read when recording the observation throws", async () => {
    await withFakes({ "codex:app-server": { primaryUsed: 100 } }, async (ctx) => {
      const reader = new CodexAppServerReader({
        clock,
        env: { ...ctx.env, HOME: home },
        onObservation: () => {
          throw new Error("store closed");
        },
      });
      expect((await reader.read(instance()))[0]?.usedPct).toBe(100);
    });
  });

  it("[UC11] a changed format raises QuotaFormatError ('format changed')", async () => {
    await withCodex({ variant: "changed_format" }, async (reader) => {
      const err = await reader.read(instance()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(QuotaFormatError);
      expect((err as Error).message).toMatch(/^format changed \(codex-app-server\)/);
    });
  });

  it("[UC11] garbage output raises QuotaFormatError", async () => {
    await withCodex({ variant: "garbage" }, async (reader) => {
      await expect(reader.read(instance())).rejects.toBeInstanceOf(QuotaFormatError);
    });
  });

  it("surfaces RPC errors; auth-looking ones become QuotaAuthError", async () => {
    await withCodex({ variant: "rpc_error" }, async (reader) => {
      const err = await reader.read(instance()).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcError);
      expect((err as RpcError).code).toBe(-32603);
    });
    await withCodex(
      { variant: "rpc_error", errorMessage: "codex account authentication required" },
      async (reader) => {
        await expect(reader.read(instance())).rejects.toBeInstanceOf(QuotaAuthError);
      },
    );
  });

  it("[UC11] a hanging server times out and its process group is killed", async () => {
    await withCodex({ variant: "hang" }, async (reader, ctx) => {
      const started = Date.now();
      const err = await reader
        .read(instance(), { signal: new AbortController().signal, timeoutMs: 600 })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RpcTimeoutError);
      expect(Date.now() - started).toBeLessThan(5_000);
      const log = await waitFor(() => ctx.readLog({ key: "app-server" })[0]);
      await waitFor(() => !isAlive(log.pid));
    });
  });

  it("[UC11] a server hanging at initialize also times out and dies", async () => {
    await withCodex({ variant: "hang", hangAt: "initialize" }, async (reader, ctx) => {
      await expect(
        reader.read(instance(), { signal: new AbortController().signal, timeoutMs: 600 }),
      ).rejects.toBeInstanceOf(RpcTimeoutError);
      const log = await waitFor(() => ctx.readLog({ key: "app-server" })[0]);
      await waitFor(() => !isAlive(log.pid));
    });
  });

  it("the core's timeout aborts the read and kills the child", async () => {
    await withCodex({ variant: "hang" }, async (reader, ctx) => {
      const outcome = await runReader(reader, instance(), 700);
      expect(outcome).toMatchObject({ ok: false, timedOut: true });
      const log = await waitFor(() => ctx.readLog({ key: "app-server" })[0]);
      await waitFor(() => !isAlive(log.pid));
    });
  });

  it("an already aborted signal fails fast", async () => {
    await withCodex({ variant: "hang" }, async (reader) => {
      const controller = new AbortController();
      controller.abort();
      await expect(
        reader.read(instance(), { signal: controller.signal, timeoutMs: 5_000 }),
      ).rejects.toThrow("aborted");
    });
  });

  it("fails clearly when the binary does not exist or exits early", async () => {
    const reader = new CodexAppServerReader({ clock, env: { PATH: "/nonexistent", HOME: home } });
    // Windows only spawns .exe/.com (or npm .cmd shims) directly.
    const missing = join(home, "missing", process.platform === "win32" ? "codex.exe" : "codex");
    await expect(reader.read(instance({ binary: missing }))).rejects.toThrow(/failed to start/);
    const early = new CodexAppServerReader({ clock, env: { PATH: "/usr/bin", HOME: home } });
    await expect(
      early.read(instance({ binary: scriptedAppServer({ exitAfterInit: true }) })),
    ).rejects.toThrow(/exited/);
  });

  describe("result shapes (scripted server)", () => {
    const snapshot = (over: Record<string, unknown>) => ({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 4_102_444_800 },
      secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: null },
      ...over,
    });
    const read = (result: unknown, over: { resolveBinary?: boolean } = {}) => {
      const binary = scriptedAppServer({ result });
      const reader = new CodexAppServerReader({
        clock,
        env: { PATH: process.env.PATH ?? "", HOME: home },
        ...(over.resolveBinary ? { resolveBinary: async () => binary } : {}),
      });
      return reader.read(over.resolveBinary ? instance() : instance({ binary }));
    };

    it("ignores server requests/notifications and falls back to rateLimits when limit id 'codex' is absent", async () => {
      const windows = byKind(
        await read(
          { rateLimits: snapshot({}), rateLimitsByLimitId: { other: snapshot({}) } },
          { resolveBinary: true },
        ),
      );
      expect(windows["5h"]).toMatchObject({ usedPct: 10, resetAt: "2100-01-01T00:00:00.000Z" });
      expect(windows.weekly).toMatchObject({ usedPct: 20, resetAt: null });
    });

    it("prefers rateLimitsByLimitId.codex and clamps out-of-range percentages", async () => {
      const windows = byKind(
        await read({
          rateLimits: snapshot({ primary: { usedPercent: 1, windowDurationMins: 300 } }),
          rateLimitsByLimitId: {
            codex: snapshot({
              primary: { usedPercent: 140, windowDurationMins: 300, resetsAt: 4_102_444_800 },
              secondary: { usedPercent: -5, windowDurationMins: 10080 },
            }),
          },
        }),
      );
      expect(windows["5h"]?.usedPct).toBe(100);
      expect(windows.weekly?.usedPct).toBe(0);
    });

    it("supports plans with only a weekly window and skips unknown durations", async () => {
      const windows = await read({
        rateLimits: {
          primary: { usedPercent: 3, windowDurationMins: 60 },
          secondary: { usedPercent: 9, windowDurationMins: 10080, resetsAt: 4_102_444_800 },
        },
      });
      expect(windows.map((w) => w.kind)).toEqual(["weekly"]);
    });

    it("[UC11] rejects results that are not understood", async () => {
      for (const result of [
        "not-an-object",
        {},
        { rateLimits: { primary: { usedPercent: "x", windowDurationMins: 300 } } },
        { rateLimits: { primary: { usedPercent: 1, windowDurationMins: 60 } } },
        { rateLimits: {} },
      ]) {
        await expect(read(result)).rejects.toBeInstanceOf(QuotaFormatError);
      }
    });
  });
});

describe("agy /usage reader [UC11]", () => {
  const fakesToDispose: FakesContext[] = [];
  afterEach(() => {
    for (const f of fakesToDispose.splice(0)) f.dispose();
  });
  const readAgy = async (cfg: FakeSubConfig | undefined, over: { timeoutMs?: number } = {}) => {
    const ctx = createFakes(cfg ? { "agy:usage": cfg } : {});
    fakesToDispose.push(ctx);
    const spawner = new NodeSpawner();
    const reader = new AgyUsageReader({
      spawner,
      clock,
      env: { ...ctx.env, HOME: home, API_KEY: "nope" },
      ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
    });
    return { reader, spawner, ctx, inst: instance({ id: "agy", adapter: "antigravity" }) };
  };

  it("maps the recorded 1.5.2 fixture: weekly windows per model group, no 5h", async () => {
    const { reader, spawner, ctx, inst } = await readAgy(undefined);
    const windows = await reader.read(inst);
    expect(windows).toEqual([
      {
        kind: "weekly:gemini",
        usedPct: 0,
        resetAt: "2099-11-14T07:18:55.000Z",
        source: "agy-usage",
        readAt: clock.now().toISOString(),
        reliability: "real",
      },
      {
        kind: "weekly:claude-gpt",
        usedPct: 0,
        resetAt: "2099-11-14T07:18:55.000Z",
        source: "agy-usage",
        readAt: clock.now().toISOString(),
        reliability: "real",
      },
    ]);
    expect(windows.some((w) => w.kind.startsWith("5h"))).toBe(false);
    const req = spawner.requests[0];
    expect(req?.argv).toEqual(["-p=/usage", "--output-format", "json"]);
    expect(req?.env.API_KEY).toBeUndefined();
    expect(req?.env.HOME).toBe(home);
    expect(ctx.readLog({ cli: "agy" })[0]?.argv).toEqual([
      "agy",
      "-p=/usage",
      "--output-format",
      "json",
    ]);
  });

  it("computes usedPct = (1 - remaining) * 100", async () => {
    const { reader, inst } = await readAgy({
      remainingFraction: 0.35,
      resetTime: "2026-11-10T00:00:00Z",
    });
    const windows = await reader.read(inst);
    expect(windows.map((w) => w.usedPct)).toEqual([65, 65]);
    expect(windows[0]?.resetAt).toBe("2026-11-10T00:00:00.000Z");
  });

  it("[UC11] a changed format raises QuotaFormatError", async () => {
    const { reader, inst } = await readAgy({ variant: "changed_format" });
    await expect(reader.read(inst)).rejects.toBeInstanceOf(QuotaFormatError);
  });

  it("[UC11] unauthenticated raises QuotaAuthError", async () => {
    const { reader, inst } = await readAgy({ variant: "unauthenticated" });
    const err = await reader.read(inst).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QuotaAuthError);
    expect((err as Error).message).toMatch(/not logged in/i);
  });

  it("reports other failures with their short_error or exit status", async () => {
    let t = await readAgy({
      exitCode: 3,
      stderr: 'AGY_ERROR: {"short_error":"backend unavailable"}\n',
      stdout: "",
    });
    await expect(t.reader.read(t.inst)).rejects.toThrow(/backend unavailable/);
    t = await readAgy({ exitCode: 3, stderr: "AGY_ERROR: {not json}\n", stdout: "" });
    await expect(t.reader.read(t.inst)).rejects.toThrow(/exited with code 3/);
    t = await readAgy({ exitCode: 3, stderr: 'AGY_ERROR: {"short_error":5}\n', stdout: "" });
    await expect(t.reader.read(t.inst)).rejects.toThrow(/exited with code 3/);
    t = await readAgy({ exitCode: 1, stderr: "boom\n", stdout: "" });
    await expect(t.reader.read(t.inst)).rejects.toThrow(/exited with code 1/);
  });

  it("times out instead of hanging", async () => {
    const { reader, inst } = await readAgy({ delayMs: 5_000 }, { timeoutMs: 300 });
    await expect(reader.read(inst)).rejects.toThrow(/timed out after 300 ms/);
  });

  it("maps 5h buckets, tolerates noise lines, invalid reset times and unknown buckets", async () => {
    const data = {
      command: {
        name: "usage",
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                {
                  id: "gemini-5h",
                  window: "5h",
                  remaining_fraction: 0.5,
                  reset_time: "2026-11-08T00:00:00Z",
                },
                {
                  id: "gemini-weekly",
                  window: "weekly",
                  remaining_fraction: 0.9,
                  reset_time: "nope",
                },
                {
                  id: "gemini-weekly-b",
                  window: "weekly",
                  remaining_fraction: 0.2,
                  reset_time: null,
                },
                { id: "gemini-weekly-c", window: "weekly", remaining_fraction: 0.6 },
                { id: "gemini-monthly", window: "monthly", remaining_fraction: 0.5 },
              ],
            },
            {
              name: "Claude and GPT models",
              buckets: [
                {
                  id: "3p-five_hour",
                  window: "five_hour",
                  remaining_fraction: 1.2,
                  reset_time: "2026-11-08T00:00:00Z",
                },
              ],
            },
            {
              name: "Mystery",
              buckets: [{ id: "x-weekly", window: "weekly", remaining_fraction: 0.5 }],
            },
            { buckets: [{ id: "3p-weekly", window: "weekly", remaining_fraction: 0.25 }] },
          ],
        },
      },
    };
    const { reader, inst } = await readAgy({
      stdout: `log noise\n${JSON.stringify(data)}\nmore noise\n`,
    });
    const windows = byKind(await reader.read(inst));
    expect(windows["5h:gemini"]).toMatchObject({
      usedPct: 50,
      resetAt: "2026-11-08T00:00:00.000Z",
    });
    expect(windows["weekly:gemini"]).toMatchObject({ usedPct: 80, resetAt: null });
    expect(windows["5h:claude-gpt"]?.usedPct).toBe(0);
    expect(windows["weekly:claude-gpt"]?.usedPct).toBe(75);
    expect(Object.keys(windows)).toHaveLength(4);
  });

  it("returns no windows for an empty group list and rejects unrecognizable buckets", async () => {
    let t = await readAgy({ stdout: JSON.stringify({ command: { data: { groups: [] } } }) });
    expect(await t.reader.read(t.inst)).toEqual([]);
    t = await readAgy({
      stdout: JSON.stringify({
        command: {
          data: {
            groups: [{ name: "Gemini", buckets: [{ window: "daily", remaining_fraction: 1 }] }],
          },
        },
      }),
    });
    await expect(t.reader.read(t.inst)).rejects.toBeInstanceOf(QuotaFormatError);
    t = await readAgy({ stdout: "not json at all\n" });
    await expect(t.reader.read(t.inst)).rejects.toBeInstanceOf(QuotaFormatError);
  });

  it("resolves the binary through the injected resolver", async () => {
    const script = writeScript(
      `console.log(JSON.stringify({command:{data:{groups:[{name:"Gemini Models",buckets:[{window:"weekly",remaining_fraction:0.5}]}]}}}))`,
    );
    const spawner = new NodeSpawner();
    const reader = new AgyUsageReader({
      spawner,
      clock,
      env: { PATH: process.env.PATH ?? "" },
      cwd: tmpdir(),
      resolveBinary: async () => script,
    });
    const windows = await reader.read(instance({ id: "agy", adapter: "antigravity" }), {
      signal: new AbortController().signal,
      timeoutMs: 5_000,
    });
    expect(windows[0]).toMatchObject({ kind: "weekly:gemini", usedPct: 50 });
    expect(spawner.requests[0]?.binary).toBe(script);
  });
});
