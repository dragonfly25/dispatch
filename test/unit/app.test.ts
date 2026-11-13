import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  adapterCapabilities,
  buildDecisionInput,
  buildTask,
  createAdapter,
  dryRun,
  loadAppContext,
  resolveHost,
} from "../../src/app/index.js";
import type { ProviderInstance } from "../../src/core/contracts.js";
import { QuotaReaderRegistry } from "../../src/quota/reader.js";
import { ROUTER_VERSION } from "../../src/router/index.js";
import { FakeClock } from "../stubs/index.js";
import { NOW } from "./cli-read.helpers.js";
import { sandbox } from "./config/helpers.js";

const instance = (id: string, adapter: string, configDir?: string): ProviderInstance => ({
  id,
  adapter,
  pool: "subscription",
  ...(configDir ? { configDir } : {}),
});

function ctxFor(sb: ReturnType<typeof sandbox>, env: Record<string, string> = {}) {
  return loadAppContext({
    cwd: sb.root,
    env: { ...sb.env, ...env },
    clock: new FakeClock(NOW),
    newId: () => "t1",
    quotaReaders: new QuotaReaderRegistry(),
  });
}

describe("loadAppContext", () => {
  it("wires config, host and paths, and opens the store lazily", async () => {
    const sb = sandbox();
    const ctx = ctxFor(sb);
    try {
      expect(ctx.config.routing.activeProfile).toBe("balance");
      expect(ctx.host.self).toBeNull();
      expect(ctx.dispatchHome).toBe(sb.dispatchHome);
      expect(ctx.dbPath).toBe(join(sb.dispatchHome, "state", "dispatch.db"));
      expect(existsSync(ctx.dbPath)).toBe(false);
      expect(await ctx.store.listDecisions("1970-01-01T00:00:00.000Z")).toEqual([]);
      expect(existsSync(ctx.dbPath)).toBe(true);
      expect(ctx.store).toBe(ctx.store);
      expect(ctx.quota).toBe(ctx.quota);
    } finally {
      ctx.close();
    }
    ctx.close(); // idempotent
  });

  it("passes flags to the loader (tighten-only) and rejects invalid ones as an issue", () => {
    const sb = sandbox();
    const ctx = loadAppContext({
      cwd: sb.root,
      env: sb.env,
      flags: { autonomy: "read-only" },
      quotaReaders: new QuotaReaderRegistry(),
    });
    expect(ctx.config.execution.autonomy).toBe("read-only");
    const bad = loadAppContext({
      cwd: sb.root,
      env: sb.env,
      flags: { nope: 1 },
      quotaReaders: new QuotaReaderRegistry(),
    });
    expect(bad.config.issues.some((i) => i.key === "flags")).toBe(true);
  });

  it("feeds the declared plan and the model-table cost to the quota core", async () => {
    const sb = sandbox();
    sb.global("version: 1\nproviders:\n  codex:\n    plan: plus\n");
    const ctx = ctxFor(sb);
    try {
      const snap = await ctx.quota.snapshot(ctx.config.execution.instances);
      // A declared, known plan gives windows even with no readers.
      expect(snap.instances.codex?.windows.length).toBeGreaterThan(0);
      expect(snap.instances.claude?.windows.map((w) => w.reliability)).toEqual(["unknown"]);
    } finally {
      ctx.close();
    }
  });
});

describe("resolveHost", () => {
  const instances = [
    instance("claude", "claude"),
    instance("claude-alt", "claude", "/x/alt"),
    instance("codex", "codex"),
    instance("agy", "antigravity"),
  ];

  it("maps each host client to its instance", () => {
    expect(resolveHost({}, instances).self).toBeNull();
    expect(resolveHost({ CLAUDECODE: "1" }, instances).self).toBe("claude");
    expect(resolveHost({ CODEX_THREAD_ID: "t" }, instances).self).toBe("codex");
    expect(resolveHost({ ANTIGRAVITY_AGENT: "1" }, instances).self).toBe("agy");
  });

  it("picks the claude instance by CLAUDE_CONFIG_DIR, falling back to the default one", () => {
    const env = { CLAUDECODE: "1" };
    expect(resolveHost({ ...env, CLAUDE_CONFIG_DIR: "/x/alt" }, instances).self).toBe("claude-alt");
    expect(resolveHost({ ...env, CLAUDE_CONFIG_DIR: "/x/alt/" }, instances).self).toBe(
      "claude-alt",
    );
    expect(resolveHost({ ...env, CLAUDE_CONFIG_DIR: "/elsewhere" }, instances).self).toBe("claude");
    const tilde = [instance("claude-alt", "claude", "~/alt")];
    expect(resolveHost({ ...env, HOME: "/h", CLAUDE_CONFIG_DIR: "/h/alt" }, tilde).self).toBe(
      "claude-alt",
    );
    // No default instance: the first claude instance stands in.
    expect(resolveHost({ ...env, CLAUDE_CONFIG_DIR: "/elsewhere" }, tilde).self).toBe("claude-alt");
  });

  it("is null when the host's adapter has no instance, and carries depth", () => {
    const only = [instance("codex", "codex")];
    const r = resolveHost({ CLAUDECODE: "1", DISPATCH_DEPTH: "2" }, only);
    expect(r.self).toBeNull();
    expect(r.detection).toMatchObject({ host: "claude-code", depth: 2 });
  });
});

describe("buildTask", () => {
  it("defaults autonomy and timeout from the config", () => {
    const sb = sandbox();
    sb.global("version: 1\nautonomy: read-only\ntimeouts:\n  default_task_ms: 5000\n");
    const ctx = ctxFor(sb);
    expect(buildTask(ctx, { task: "do it" })).toEqual({
      id: "t1",
      prompt: "do it",
      paths: [],
      autonomy: "read-only",
      timeoutMs: 5000,
    });
    expect(buildTask(ctx, { task: "x", timeout: 1.5 }).timeoutMs).toBe(1500);
    expect(buildTask(ctx, { task: "x", autonomy: "direct" }).autonomy).toBe("direct");
  });

  it("rejects a blank prompt", () => {
    const ctx = ctxFor(sandbox());
    expect(() => buildTask(ctx, { task: "   " })).toThrow(/a task is required/);
  });
});

describe("buildDecisionInput and dryRun", () => {
  it("assembles a complete canonical input from the context", async () => {
    const sb = sandbox();
    const ctx = ctxFor(sb, { CLAUDECODE: "1", DISPATCH_DEPTH: "1" });
    try {
      const task = buildTask(ctx, { task: "x" });
      const input = await buildDecisionInput(ctx, task, {
        sessionHistory: [{ taskId: "p", instance: "codex", outcome: "failed" }],
        sessionModel: { value: "claude-opus-5-5", observed: true },
      });
      expect(input).toMatchObject({
        task,
        host: {
          self: "claude",
          depth: 1,
          sessionModel: { value: "claude-opus-5-5", observed: true },
        },
        sessionHistory: [{ taskId: "p", instance: "codex", outcome: "failed" }],
        now: NOW,
        routerVersion: ROUTER_VERSION,
      });
      expect(Object.keys(input.quota.instances)).toEqual(["claude", "codex", "antigravity"]);
      expect(input.routing.activeProfile).toBe("balance");
    } finally {
      ctx.close();
    }
  });

  it("dryRun decides without recording and explains every other profile", async () => {
    const sb = sandbox();
    const ctx = ctxFor(sb);
    try {
      const r = await dryRun(ctx, buildTask(ctx, { task: "x", path: ["src/a.ts"] }));
      expect(r.decision.action).toBe("delegate");
      expect(r.decision.inputHash).toHaveLength(64);
      expect(Object.keys(r.alternatives)).toEqual(["off", "preserve", "specialize"]);
      expect(r.explain).toContain("Other profiles:");
      expect(await ctx.store.listDecisions("1970-01-01T00:00:00.000Z")).toEqual([]);
    } finally {
      ctx.close();
    }
  });

  it("on Windows routes around claude and agy and says why", async () => {
    const sb = sandbox();
    const ctx = ctxFor(sb);
    try {
      const task = buildTask(ctx, { task: "x", path: ["src/a.ts"] });
      const r = await dryRun(ctx, task, {}, "win32");
      const instances = (r.input.routing as { instances: { adapter: string; enabled: boolean }[] })
        .instances;
      for (const i of instances.filter((x) => x.adapter === "claude" || x.adapter === "agy")) {
        expect(i.enabled).toBe(false);
      }
      expect(r.explain).toContain("Unavailable");
      const posix = await dryRun(ctx, task, {}, "darwin");
      expect(posix.explain).not.toContain("Unavailable");
    } finally {
      ctx.close();
    }
  });
});

describe("adapter registry", () => {
  it("knows the three shipped adapters", () => {
    for (const id of ["claude", "codex", "antigravity"]) {
      expect(adapterCapabilities(id)?.id).toBe(id);
      expect(createAdapter(id)?.caps.id).toBe(id);
    }
    expect(createAdapter("claude", "api_credit")?.caps.pool).toBe("api_credit");
    expect(adapterCapabilities("fake")).toBeNull();
    expect(createAdapter("fake")).toBeNull();
  });
});
