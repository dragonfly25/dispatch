import { describe, expect, it, vi } from "vitest";
import { loadAppContext } from "../../src/app/index.js";
import type { QuotaObservation, QuotaWindow } from "../../src/core/contracts.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { type DefaultReadersOptions, defaultReaders } from "../../src/quota/readers/index.js";
import { ProcessSpawner } from "../../src/runner/proc.js";
import { FakeClock, ScriptedSpawner } from "../stubs/index.js";
import { NOW } from "./cli-read.helpers.js";
import { sandbox } from "./config/helpers.js";

/** Records the options the app passes to the real `defaultReaders` and counts reader calls. */
const spy = vi.hoisted(() => ({
  options: undefined as unknown,
  reads: [] as string[],
}));

vi.mock("../../src/quota/readers/index.js", async (original) => {
  const actual = await original<typeof import("../../src/quota/readers/index.js")>();
  return {
    ...actual,
    defaultReaders: (options: DefaultReadersOptions) => {
      spy.options = options;
      const window = (kind: string): QuotaWindow => ({
        kind,
        usedPct: 10,
        resetAt: null,
        source: "fake",
        readAt: NOW,
        reliability: "real",
      });
      const reader = (id: string) => ({
        id,
        version: "1",
        channel: "fake",
        read: async () => {
          spy.reads.push(id);
          return [window("5h")];
        },
      });
      return new QuotaReaderRegistry()
        .register("claude", reader("fake-claude"))
        .register("codex", reader("fake-codex"));
    },
  };
});

const spawner = new ScriptedSpawner([]);

function ctxFor(sb: ReturnType<typeof sandbox>, extra: Record<string, unknown> = {}) {
  return loadAppContext({
    cwd: sb.root,
    env: sb.env,
    clock: new FakeClock(NOW),
    spawner,
    ...extra,
  });
}

describe("default quota readers", () => {
  it("use a ProcessSpawner by default", () => {
    const sb = sandbox();
    const ctx = loadAppContext({ cwd: sb.root, env: sb.env, clock: new FakeClock(NOW) });
    try {
      expect(ctx.readers.all()).toHaveLength(2);
      expect((spy.options as DefaultReadersOptions).spawner).toBeInstanceOf(ProcessSpawner);
    } finally {
      ctx.close();
    }
  });

  it("passes the claude-usage LLM fallback switch from the config (default on)", () => {
    const sb = sandbox();
    let ctx = ctxFor(sb);
    try {
      ctx.readers.all();
      expect((spy.options as DefaultReadersOptions).claudeLlmFallback).toBe(true);
    } finally {
      ctx.close();
    }
    sb.global("version: 1\nquota:\n  readers:\n    claude-usage: { llm_fallback: false }\n");
    ctx = ctxFor(sb);
    try {
      ctx.readers.all();
      expect((spy.options as DefaultReadersOptions).claudeLlmFallback).toBe(false);
    } finally {
      ctx.close();
    }
  });

  it("an explicit registry wins over the defaults", () => {
    const sb = sandbox();
    const registry = new QuotaReaderRegistry();
    const ctx = ctxFor(sb, { quotaReaders: registry });
    try {
      expect(ctx.readers).toBe(registry);
    } finally {
      ctx.close();
    }
  });

  it("with an injected spawner the defaults are built with the context's clock, env and store", () => {
    const sb = sandbox();
    const ctx = ctxFor(sb);
    try {
      expect(ctx.readers.all().map((r) => r.id)).toEqual(["fake-claude", "fake-codex"]);
      expect(ctx.readers).toBe(ctx.readers);
      const o = spy.options as DefaultReadersOptions;
      expect(o.spawner).toBe(spawner);
      expect(o.env).toBe(sb.env);
      expect(o.reliability).toEqual({ cacheMinutes: 5 });
      expect(o.store).toBe(ctx.store);
    } finally {
      ctx.close();
    }
  });

  it("observations from the readers reach the quota provider (exhaustion makes an instance unavailable)", async () => {
    const sb = sandbox();
    const ctx = ctxFor(sb);
    try {
      expect(ctx.readers.all()).toHaveLength(2); // builds the registry, capturing the options
      const o = spy.options as DefaultReadersOptions;
      const observation: QuotaObservation = {
        instanceId: "codex",
        at: NOW,
        exhausted: { resetAt: "2026-11-07T12:00:00.000Z" },
      };
      await o.onObservation?.(observation);
      const snap = await ctx.quota.snapshot(ctx.config.execution.instances);
      expect(snap.instances.codex?.unavailableUntil).toBe("2026-11-07T12:00:00.000Z");
    } finally {
      ctx.close();
    }
  });

  it("readers switched off in quota.readers (by reader id or instance id) are not called", async () => {
    spy.reads.length = 0;
    const sb = sandbox();
    sb.global("version: 1\nquota:\n  readers:\n    codex: { enabled: false }\n");
    const ctx = ctxFor(sb);
    try {
      await ctx.quota.snapshot(ctx.config.execution.instances);
      expect(spy.reads).toEqual(["fake-claude"]);
    } finally {
      ctx.close();
    }

    spy.reads.length = 0;
    const sb2 = sandbox();
    sb2.global("version: 1\nquota:\n  readers:\n    fake-claude: { enabled: false }\n");
    const ctx2 = ctxFor(sb2);
    try {
      await ctx2.quota.snapshot(ctx2.config.execution.instances);
      expect(spy.reads).toEqual(["fake-codex"]);
    } finally {
      ctx2.close();
    }
  });
});

// Keeps the real factory referenced so a rename there breaks this file's types.
void defaultReaders;

describe("[SEC-agy-ro] disabled instances are never read", () => {
  it("buildDecisionInput does not invoke the reader of a disabled instance (agy is off by default)", async () => {
    const { buildDecisionInput, buildTask } = await import("../../src/app/index.js");
    const sb = sandbox();
    const calls: string[] = [];
    const registry = new QuotaReaderRegistry();
    for (const adapter of ["claude", "codex", "antigravity"]) {
      registry.register(adapter, {
        id: `spy-${adapter}`,
        version: "1",
        channel: "test",
        read: async (inst) => {
          calls.push(inst.id);
          return [];
        },
      });
    }
    const ctx = loadAppContext({
      cwd: sb.root,
      env: sb.env,
      clock: new FakeClock(NOW),
      quotaReaders: registry,
    });
    try {
      const input = await buildDecisionInput(ctx, buildTask(ctx, { task: "x" }));
      expect(calls).not.toContain("antigravity");
      expect(input.quota.instances.antigravity?.windows[0]?.reliability).toBe("unknown");
    } finally {
      ctx.close();
    }
  });
});
