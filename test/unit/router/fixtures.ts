import type { DecisionInput, QuotaWindow, Task } from "../../../src/core/contracts.js";
import type { RoutingConfig } from "../../../src/core/routing.js";
import { ROUTER_VERSION } from "../../../src/router/index.js";

const efforts = (high = "high") => ({ low: "low", medium: "medium", high });

const instance = (
  id: string,
  adapter: string,
  extra: Partial<RoutingConfig["instances"][number]> = {},
) => ({
  id,
  adapter,
  pool: "subscription" as const,
  enabled: true,
  maxAutonomy: "worktree" as const,
  concurrency: 2,
  thresholds: { soft: 30, hard: 10 },
  effortShift: 0,
  ...extra,
});

/** A realistic effective routing config: two Claude accounts, Codex, Antigravity (read-only). */
export function makeConfig(over: Partial<RoutingConfig> = {}): RoutingConfig {
  return {
    version: 1,
    tiers: ["fast", "balanced", "max"],
    efforts: ["low", "medium", "high"],
    instances: [
      instance("claude", "claude"),
      instance("claude-alt", "claude"),
      instance("codex", "codex"),
      instance("agy", "antigravity", { maxAutonomy: "read-only" }),
    ],
    models: {
      claude: {
        tiers: {
          fast: { model: "claude-haiku-4-5", effort: efforts(), relativeCost: 1 },
          balanced: { model: "claude-sonnet-4-5", effort: efforts(), relativeCost: 3 },
          max: { model: "claude-opus-4-1", effort: efforts(), relativeCost: 10 },
        },
        reverse: [
          { pattern: "claude-opus-*", tier: "max" },
          { pattern: "claude-sonnet-*", tier: "balanced" },
          { pattern: "claude-haiku-*", tier: "fast" },
          { pattern: "opus", tier: "max" },
        ],
      },
      codex: {
        tiers: {
          fast: { model: "gpt-5-mini", effort: efforts("xhigh"), relativeCost: 1 },
          balanced: { model: "gpt-5", effort: efforts("xhigh"), relativeCost: 3 },
          max: { model: "gpt-5-pro", effort: efforts("xhigh"), relativeCost: 8 },
        },
        reverse: [
          { pattern: "gpt-5-mini", tier: "fast" },
          { pattern: "gpt-5-pro", tier: "max" },
          { pattern: "gpt-5*", tier: "balanced" },
        ],
      },
      antigravity: {
        tiers: {
          fast: { model: "gemini-flash", effort: efforts(), relativeCost: 1 },
          balanced: { model: "gemini-pro", effort: efforts(), relativeCost: 3 },
          max: { model: "gemini-ultra", effort: efforts(), relativeCost: 6 },
        },
        reverse: [{ pattern: "gemini-*", tier: "balanced" }],
      },
    },
    pins: [{ id: "migrations", match: { paths: ["db/migrations/**"] }, action: { type: "host" } }],
    directMappings: [],
    activeProfile: "balance",
    profiles: {
      balance: {
        rules: [
          {
            id: "spread",
            match: {},
            action: {
              type: "fallback",
              instances: ["codex", "agy", "claude-alt"],
              strategy: "ordered",
            },
          },
        ],
      },
      preserve: {
        rules: [
          {
            id: "review",
            match: { taskType: ["review"] },
            action: { type: "fanout", instances: ["codex", "claude-alt"] },
          },
          { id: "all", match: {}, action: { type: "provider", instance: "codex" } },
        ],
      },
      specialize: {
        rules: [
          {
            id: "tests",
            match: { taskType: ["test"] },
            action: { type: "provider", instance: "codex" },
          },
        ],
      },
      off: { rules: [] },
    },
    activePreset: "mirror",
    presets: {
      mirror: { effortShift: 0, tierByTaskType: {} },
      economy: { effortShift: -1, tierByTaskType: { docs: "fast" } },
    },
    unspecifiedModel: "balanced",
    maxAutonomy: "direct",
    shadowProfiles: [],
    provenance: {},
    ...over,
  };
}

export const NOW = "2026-11-07T10:00:00.000Z";

/** A quota window with `usedPct` used. */
export function win(usedPct: number | null, extra: Partial<QuotaWindow> = {}): QuotaWindow {
  return {
    kind: "5h",
    usedPct,
    resetAt: null,
    source: "test-reader",
    readAt: "2026-11-07T09:55:00.000Z",
    reliability: "real",
    ...extra,
  };
}

export function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "t1",
    prompt: "do it",
    paths: ["src/a.ts"],
    autonomy: "read-only",
    timeoutMs: 60_000,
    ...over,
  };
}

export interface InputOverrides {
  task?: Partial<Task>;
  config?: Partial<RoutingConfig>;
  host?: Partial<DecisionInput["host"]>;
  used?: Record<string, number | null>;
  quota?: DecisionInput["quota"]["instances"];
  sessionHistory?: DecisionInput["sessionHistory"];
}

/** A DecisionInput with self = claude; `used` sets one 5h window per instance. */
export function makeInput(o: InputOverrides = {}): DecisionInput {
  const instances: DecisionInput["quota"]["instances"] = {};
  for (const [id, used] of Object.entries(o.used ?? {})) {
    instances[id] = { windows: [win(used)], pool: "subscription" };
  }
  return {
    task: makeTask(o.task),
    host: { self: "claude", depth: 0, ...o.host },
    routing: makeConfig(o.config) as unknown as Record<string, unknown>,
    quota: { takenAt: NOW, instances: { ...instances, ...o.quota } },
    sessionHistory: o.sessionHistory ?? [],
    now: NOW,
    routerVersion: ROUTER_VERSION,
  };
}
