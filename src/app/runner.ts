/**
 * Production wiring of the runner ({@link RunnerDeps}) from the composition root: the same
 * config, state store, quota provider, spawner and host identity every other command uses.
 */
import type { Adapter, QuotaProvider } from "../core/contracts.js";
import { resolveBinary } from "../platform/resolve.js";
import type { RunnerDeps } from "../runner/orchestrate.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { ADAPTER_CAPABILITIES, createAdapter } from "./adapters.js";
import { type AppContext, snapshotOrUnknown } from "./context.js";

/**
 * Quota view for the runner: only enabled instances are read (a disabled provider's CLI is never
 * spawned), and a broken reader or store degrades to "unknown" instead of failing the task.
 */
function runnerQuota(ctx: AppContext): QuotaProvider {
  return {
    snapshot: () => snapshotOrUnknown(ctx, ctx.host.self),
    recordObservation: (o) => ctx.quota.recordObservation(o),
  };
}

/**
 * Builds the dependencies of `executeTask` from `ctx`. The store, quota provider and spawner are
 * the context's own, so `ctx.close()` releases everything. `overrides` replaces any wired
 * dependency (tests).
 */
export function runnerDeps(ctx: AppContext, overrides: Partial<RunnerDeps> = {}): RunnerDeps {
  const adapters: Record<string, Adapter> = {};
  for (const id of Object.keys(ADAPTER_CAPABILITIES)) {
    const adapter = createAdapter(id);
    if (adapter) adapters[id] = adapter;
  }
  return {
    config: ctx.config,
    store: ctx.store,
    quota: runnerQuota(ctx),
    clock: ctx.clock,
    spawner: ctx.spawner,
    sandbox: new WorktreeSandbox(),
    adapters,
    resolveBinary: async (name, instance) =>
      resolveBinary(name, {
        configured: instance.binary,
        env: ctx.env,
        platform: process.platform,
      })?.path ?? null,
    env: ctx.env,
    host: ctx.host.detection,
    hostSelf: ctx.host.self,
    dispatchHome: ctx.dispatchHome,
    addSecrets: (values) => ctx.secrets.push(...values),
    ...overrides,
  };
}
