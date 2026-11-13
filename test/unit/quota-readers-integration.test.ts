import fs, {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ProviderInstance,
  QuotaObservation,
  QuotaWindow,
  RunRecord,
} from "../../src/core/contracts.js";
import { DefaultQuotaProvider } from "../../src/quota/provider.js";
import {
  CLAUDE_PASSIVE_ID,
  ClaudePassiveReader,
  defaultReaders,
  ingestClaudeObservations,
} from "../../src/quota/readers/index.js";
import { SqliteStateStore } from "../../src/state/store.js";
import * as fx from "../fixtures/contracts.js";
import { FakeClock } from "../stubs/index.js";
import { createFakes, type FakeScenarioMap, type FakesContext } from "../support/index.js";
import { NodeSpawner } from "./quota-readers-helpers.js";

const MIN = 60_000;
const H = 3_600_000;

let dir: string;
let home: string;
let clock: FakeClock;
let store: SqliteStateStore;
let fakes: FakesContext | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "dispatch-readers-int-"));
  home = join(dir, "home");
  mkdirSync(home);
  clock = new FakeClock(new Date());
  store = SqliteStateStore.open(join(dir, "state", "dispatch.db"), { clock });
});
afterEach(() => {
  store.close();
  fakes?.dispose();
  fakes = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const iso = (ms: number) => new Date(clock.now().getTime() + ms).toISOString();
const claude: ProviderInstance = { id: "claude", adapter: "claude", pool: "subscription" };
const codex: ProviderInstance = { id: "codex", adapter: "codex", pool: "subscription" };
const agy: ProviderInstance = { id: "agy", adapter: "antigravity", pool: "subscription" };

/** Provider wired to the real readers, running against fake `codex`/`agy` on PATH. */
function setup(scenarios: FakeScenarioMap = {}, timeoutMs = 3_000) {
  fakes = createFakes(scenarios);
  const spawner = new NodeSpawner();
  const env = { ...fakes.env, HOME: home };
  const holder: { provider?: DefaultQuotaProvider } = {};
  const readers = defaultReaders({
    clock,
    spawner,
    store,
    env,
    version: "1.2.3",
    onObservation: (o) => holder.provider?.recordObservation(o),
  });
  const provider = new DefaultQuotaProvider({
    store,
    clock,
    readers,
    readerTimeoutMs: timeoutMs,
    instancePlans: { claude: "pro", codex: "plus", agy: "antigravity:pro" },
  });
  holder.provider = provider;
  return { provider, readers, spawner };
}

async function delegated(id: string, instanceId: string, inputTokens: number): Promise<void> {
  const record: RunRecord = {
    runId: id,
    status: "completed",
    createdAt: iso(-H),
    updatedAt: iso(-H),
    instance: instanceId,
    pid: null,
    result: {
      ...fx.runResult,
      runId: id,
      externalAgent: {
        provider: instanceId,
        instance: instanceId,
        model: "m",
        marker: "EXTERNAL_AGENT_OUTPUT",
      },
      decisions: [
        {
          ...fx.decision,
          targets: [{ instance: instanceId, tier: "max", model: "m", effort: "high" }],
        },
      ],
      usage: { inputTokens },
      durationMs: 60_000,
    },
  };
  await store.recordRun(record);
}

const windowOf = (
  q: Awaited<ReturnType<DefaultQuotaProvider["snapshot"]>>,
  id: string,
  kind: string,
): QuotaWindow => {
  const w = q.instances[id]?.windows.find((x) => x.kind === kind);
  if (!w) throw new Error(`no window ${id}/${kind}`);
  return w;
};

describe("readers wired into the quota core [UC11]", () => {
  it("registers the readers by adapter id", () => {
    const { readers } = setup();
    expect(readers.forAdapter("claude").map((r) => r.id)).toEqual([
      "claude-passive",
      "claude-usage",
    ]);
    expect(readers.forAdapter("codex").map((r) => r.id)).toEqual(["codex-app-server"]);
    expect(readers.forAdapter("antigravity").map((r) => r.id)).toEqual(["agy-usage"]);
    expect(readers.forAdapter("fake")).toEqual([]);
    const minimal = defaultReaders({ clock, spawner: new NodeSpawner(), store });
    expect(minimal.all().map((r) => r.id)).toEqual([
      "claude-passive",
      "claude-usage",
      "codex-app-server",
      "agy-usage",
    ]);
    const tuned = defaultReaders({
      clock,
      spawner: new NodeSpawner(),
      store,
      reliability: { cacheMinutes: 1 },
    });
    expect(tuned.all()).toHaveLength(4);
  });

  it("passes the resolved binary to every spawning reader; null falls back to instance.binary ?? name", async () => {
    const binaries: string[] = [];
    const spawner = {
      spawn: async (req: { binary: string }) => {
        binaries.push(req.binary);
        return { exitCode: 1, signal: null, timedOut: false };
      },
    };
    const asked: string[] = [];
    const readers = defaultReaders({
      clock,
      spawner,
      store,
      env: { PATH: "" },
      claudeLlmFallback: false,
      resolveBinary: (name, inst) => {
        asked.push(`${name}:${inst.id}`);
        if (name === "claude") return "/abs/bin/claude";
        if (name === "codex") return "/nonexistent/abs/codex";
        return null;
      },
    });
    const byId = (id: string) => readers.all().find((r) => r.id === id);
    const inst = (id: string, adapter: string, binary?: string): ProviderInstance =>
      ({ id, adapter, ...(binary ? { binary } : {}) }) as ProviderInstance;
    await expect(byId("claude-usage")?.read(inst("c", "claude"))).rejects.toThrow();
    await expect(byId("agy-usage")?.read(inst("a", "antigravity"))).rejects.toThrow();
    await expect(byId("agy-usage")?.read(inst("a2", "antigravity", "/cfg/agy"))).rejects.toThrow();
    await expect(byId("codex-app-server")?.read(inst("x", "codex"))).rejects.toThrow(
      "/nonexistent/abs/codex",
    );
    expect(binaries).toEqual(["/abs/bin/claude", "agy", "/cfg/agy"]);
    expect(asked).toEqual(["claude:c", "agy:a", "agy:a2", "codex:x"]);
  });

  it("codex ok: real windows in the snapshot, healthy reader", async () => {
    const { provider } = setup({ "codex:app-server": { primaryUsed: 42, secondaryUsed: 17 } });
    const q = await provider.snapshot([codex]);
    expect(windowOf(q, "codex", "5h")).toMatchObject({
      usedPct: 42,
      source: "codex-app-server",
      reliability: "real",
    });
    expect(windowOf(q, "codex", "weekly")).toMatchObject({ usedPct: 17, reliability: "real" });
    expect(provider.readerHealth("codex")).toMatchObject([
      { readerId: "codex-app-server", channel: "app-server", ok: true },
    ]);
  });

  it("[UC11] changed format: falls back to the estimate and health shows 'format changed'", async () => {
    const { provider } = setup({ "codex:app-server": { variant: "changed_format" } });
    await delegated("r1", "codex", 120_000);
    const q = await provider.snapshot([codex]);
    expect(windowOf(q, "codex", "5h")).toMatchObject({
      source: "estimator",
      reliability: "estimated",
    });
    const health = provider.readerHealth("codex");
    expect(health[0]).toMatchObject({ readerId: "codex-app-server", ok: false });
    expect(health[0]?.error).toMatch(/format changed/);
  });

  it("[UC11] always-zero is incoherent with the estimator: not trusted, flagged", async () => {
    const { provider } = setup({ "codex:app-server": { variant: "always_zero" } });
    await delegated("r1", "codex", 200_000);
    const q = await provider.snapshot([codex]);
    expect(windowOf(q, "codex", "5h").reliability).not.toBe("real");
    expect(windowOf(q, "codex", "5h").usedPct).not.toBe(0);
    const bad = provider.readerHealth("codex").find((h) => !h.ok);
    expect(bad?.error).toMatch(/0% used while the estimator/);
  });

  it("[UC11] a hanging app-server never blocks the snapshot", async () => {
    const { provider } = setup({ "codex:app-server": { variant: "hang" } }, 700);
    const started = Date.now();
    const q = await provider.snapshot([codex]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(windowOf(q, "codex", "5h").reliability).not.toBe("real");
    expect(provider.readerHealth("codex")[0]).toMatchObject({ ok: false });
    expect(provider.readerHealth("codex")[0]?.error).toMatch(/timed out/);
  });

  it("an exhausted codex account becomes an unavailability signal", async () => {
    const resetsAt = Math.floor(Date.now() / 1000) + 1800;
    const { provider } = setup({
      "codex:app-server": { primaryUsed: 100, secondaryUsed: 20, primaryResetsAt: resetsAt },
    });
    const q = await provider.snapshot([codex]);
    expect(q.instances.codex?.unavailableUntil).toBe(new Date(resetsAt * 1000).toISOString());
    expect(q.instances.codex?.lastQuotaError).toMatch(/usage limit reached/);
    expect(windowOf(q, "codex", "5h").usedPct).toBe(100);
  });

  it("agy ok: weekly windows per model group are real, the missing 5h stays estimated/unknown", async () => {
    const { provider } = setup();
    const q = await provider.snapshot([agy]);
    expect(windowOf(q, "agy", "weekly:gemini")).toMatchObject({
      usedPct: 0,
      source: "agy-usage",
      reliability: "real",
    });
    expect(windowOf(q, "agy", "weekly:claude-gpt").reliability).toBe("real");
    expect(windowOf(q, "agy", "5h:gemini").reliability).not.toBe("real");
  });

  it("[UC11] agy unauthenticated: health shows the auth error, snapshot still valid", async () => {
    const { provider } = setup({ "agy:usage": { variant: "unauthenticated" } });
    const q = await provider.snapshot([agy]);
    expect(windowOf(q, "agy", "weekly:gemini").reliability).not.toBe("real");
    expect(provider.readerHealth("agy")[0]?.error).toMatch(/not authenticated/);
  });

  it("agy changed format is reported as 'format changed'", async () => {
    const { provider } = setup({ "agy:usage": { variant: "changed_format" } });
    await provider.snapshot([agy]);
    expect(provider.readerHealth("agy")[0]?.error).toMatch(/format changed/);
  });
});

describe("claude passive ingest", () => {
  const observation = (over: Partial<QuotaWindow> = {}, extra: Partial<QuotaObservation> = {}) => ({
    instanceId: "claude",
    at: clock.now().toISOString(),
    window: {
      kind: "5h",
      usedPct: 40,
      resetAt: iso(2 * H),
      source: "adapter-claude",
      readAt: clock.now().toISOString(),
      reliability: "real" as const,
      ...over,
    },
    ...extra,
  });

  it("records observations through the provider; status shows them as real while fresh", async () => {
    const { provider } = setup();
    const result = await ingestClaudeObservations(provider, [
      observation(),
      observation({ kind: "7d", usedPct: 26 }),
    ]);
    expect(result).toEqual({ recorded: 2, rejected: 0 });

    let q = await provider.snapshot([claude]);
    expect(windowOf(q, "claude", "5h")).toMatchObject({
      usedPct: 40,
      source: CLAUDE_PASSIVE_ID,
      reliability: "real",
    });
    expect(windowOf(q, "claude", "7d")).toMatchObject({ usedPct: 26, reliability: "real" });

    // Passive data does not refresh itself: once old it is shown as stale, never silently real.
    clock.advance(20 * MIN);
    q = await provider.snapshot([claude]);
    expect(windowOf(q, "claude", "5h").reliability).toBe("stale");
  });

  it("an exhaustion observation makes the instance unavailable", async () => {
    const { provider } = setup();
    const reset = iso(90 * MIN);
    await ingestClaudeObservations(provider, [
      {
        instanceId: "claude",
        at: clock.now().toISOString(),
        exhausted: { resetAt: reset, error: "rejected" },
      },
    ]);
    const q = await provider.snapshot([claude]);
    expect(q.instances.claude?.unavailableUntil).toBe(reset);
  });

  it("skips invalid items, tolerates non-arrays and provider failures", async () => {
    const calls: QuotaObservation[] = [];
    const provider = {
      async recordObservation(o: QuotaObservation) {
        calls.push(o);
        if (calls.length === 2) throw new Error("db closed");
      },
    };
    expect(await ingestClaudeObservations(provider, undefined)).toEqual({
      recorded: 0,
      rejected: 0,
    });
    const result = await ingestClaudeObservations(provider, [
      observation(),
      observation({ kind: "7d" }),
      { instanceId: "", at: "nope" },
      "garbage",
    ]);
    expect(result).toEqual({ recorded: 1, rejected: 3 });
    expect(calls[0]?.window?.source).toBe(CLAUDE_PASSIVE_ID);
  });

  it("the reader only returns this instance's fresh, real, un-rolled passive readings", async () => {
    const { provider } = setup();
    await ingestClaudeObservations(provider, [
      observation(),
      { ...observation({ kind: "7d" }), instanceId: "claude-alt" },
      observation({ kind: "old", readAt: iso(-30 * MIN) }),
      observation({ kind: "rolled", resetAt: iso(1_000), readAt: iso(0) }),
    ]);
    // A reading from another channel for the same instance is not passive data.
    store.recordQuotaReading("claude", {
      kind: "other",
      usedPct: 1,
      resetAt: iso(H),
      source: "estimator",
      readAt: iso(0),
      reliability: "real",
    });
    const reader = new ClaudePassiveReader({ store, clock });
    expect((await reader.read(claude)).map((w) => w.kind).sort()).toEqual(["5h", "rolled"]);
    clock.advance(2_000);
    expect((await reader.read(claude)).map((w) => w.kind)).toEqual(["5h"]);
    clock.advance(16 * MIN);
    expect(await reader.read(claude)).toEqual([]);
  });
});

describe("[SEC-cred][AC7] readers never touch credential files", () => {
  const CANARIES = [
    [".codex", "auth.json"],
    [".claude", ".credentials.json"],
    [".gemini", "oauth_creds.json"],
  ] as const;
  type AnyFn = (...args: unknown[]) => unknown;
  const SYNC = [
    "open",
    "openSync",
    "readFile",
    "readFileSync",
    "createReadStream",
    "opendir",
    "opendirSync",
    "readdir",
    "readdirSync",
    "stat",
    "statSync",
    "lstat",
    "lstatSync",
    "access",
    "accessSync",
    "existsSync",
    "copyFile",
    "copyFileSync",
    "realpath",
    "realpathSync",
  ] as const;
  const PROMISES = [
    "open",
    "readFile",
    "readdir",
    "stat",
    "lstat",
    "access",
    "copyFile",
    "opendir",
    "realpath",
  ] as const;

  /** Records every path-like first argument passed to fs while `fn` runs. */
  async function traceFs(fn: () => Promise<void>): Promise<string[]> {
    const seen: string[] = [];
    const restore: Array<() => void> = [];
    const wrap = (target: Record<string, unknown>, name: string) => {
      const original = target[name] as AnyFn | undefined;
      if (typeof original !== "function") return;
      target[name] = function (this: unknown, ...args: unknown[]) {
        const first = args[0];
        if (typeof first === "string") seen.push(first);
        else if (first instanceof URL) seen.push(first.pathname);
        else if (Buffer.isBuffer(first)) seen.push(first.toString());
        return original.apply(this, args);
      };
      restore.push(() => {
        target[name] = original;
      });
    };
    for (const name of SYNC) wrap(fs as unknown as Record<string, unknown>, name);
    for (const name of PROMISES) wrap(fs.promises as unknown as Record<string, unknown>, name);
    syncBuiltinESMExports();
    try {
      await fn();
    } finally {
      for (const undo of restore) undo();
      syncBuiltinESMExports();
    }
    return seen;
  }

  it("runs every reader under a temp HOME holding canaries without opening them", async () => {
    const canaryPaths = CANARIES.map(([d, f]) => {
      mkdirSync(join(home, d), { recursive: true });
      const file = join(home, d, f);
      writeFileSync(file, `CANARY-${f}`);
      return file;
    });

    // Control: the trace does see a read of a canary.
    const control = await traceFs(async () => {
      readFileSync(canaryPaths[0] as string);
      readdirSync(join(home, ".claude"));
    });
    expect(control).toContain(canaryPaths[0]);
    expect(control).toContain(join(home, ".claude"));

    const { provider } = setup({
      "codex:app-server": { primaryUsed: 100 },
    });
    const seen = await traceFs(async () => {
      await provider.snapshot([claude, codex, agy]);
      await ingestClaudeObservations(provider, [
        {
          instanceId: "claude",
          at: clock.now().toISOString(),
          window: {
            kind: "5h",
            usedPct: 10,
            resetAt: iso(H),
            source: "x",
            readAt: clock.now().toISOString(),
            reliability: "real",
          },
        },
      ]);
      await provider.snapshot([claude, codex, agy]);
    });

    const forbidden = seen.filter(
      (p) =>
        p.startsWith(join(home, ".codex")) ||
        p.startsWith(join(home, ".claude")) ||
        p.startsWith(join(home, ".gemini")),
    );
    expect(forbidden).toEqual([]);
    expect(seen.some((p) => /(auth\.json|\.credentials\.json|oauth_creds\.json)$/.test(p))).toBe(
      false,
    );
    for (const file of canaryPaths) expect(readFileSync(file, "utf8")).toMatch(/^CANARY-/);
  });

  it("reader sources mention no credential file names", () => {
    const srcDir = join(import.meta.dirname, "..", "..", "src", "quota", "readers");
    for (const name of readdirSync(srcDir)) {
      const text = readFileSync(join(srcDir, name), "utf8");
      expect(text, name).not.toMatch(
        /auth\.json|\.credentials|oauth_creds|readFile|createReadStream/i,
      );
    }
  });
});
