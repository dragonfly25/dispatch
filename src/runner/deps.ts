/**
 * Production wiring of {@link RunnerDeps}. A small factory until the composition root
 * (`src/app/context.ts`, WP20/WP24) exists.
 * TODO(WP24): fold this into the composition root and delete it.
 */
import { join } from "node:path";
import { createAgyAdapter } from "../adapters/agy/index.js";
import { createClaudeAdapter } from "../adapters/claude/index.js";
import { createCodexAdapter } from "../adapters/codex/index.js";
import type { EffectiveConfig } from "../config/load.js";
import { dispatchHome as defaultDispatchHome } from "../config/paths.js";
import { systemClock } from "../core/clock.js";
import type { Clock, Spawner } from "../core/contracts.js";
import { detectHost } from "../platform/host.js";
import { resolveBinary } from "../platform/resolve.js";
import { DefaultQuotaProvider } from "../quota/provider.js";
import {
  AGY_READER_ID,
  CLAUDE_PASSIVE_ID,
  CODEX_READER_ID,
  defaultReaders,
} from "../quota/readers/index.js";
import { WorktreeSandbox } from "../sandbox/worktree.js";
import { SqliteStateStore } from "../state/store.js";
import type { RunnerDeps } from "./orchestrate.js";
import { ProcessSpawner } from "./proc.js";

/** Reader id serving each adapter (see `defaultReaders`). */
const READER_OF: Record<string, string> = {
  claude: CLAUDE_PASSIVE_ID,
  codex: CODEX_READER_ID,
  antigravity: AGY_READER_ID,
};

/** Options of {@link createRunnerDeps}. */
export interface CreateRunnerDepsOptions {
  config: Pick<EffectiveConfig, "routing" | "execution">;
  env: Readonly<Record<string, string | undefined>>;
  /** Default `<dispatchHome>/state/dispatch.db`. */
  dbPath?: string;
  clock?: Clock;
  spawner?: Spawner;
  /** Dispatch version, for reader client info. */
  version?: string;
  /** Replaces any wired dependency (tests). */
  overrides?: Partial<RunnerDeps>;
}

/**
 * Reader ids to disable: `quota.readers.<instance>.enabled: false` turns off the reader of that
 * instance's adapter (readers are registered per adapter).
 */
export function disabledReaderIds(config: CreateRunnerDepsOptions["config"]): string[] {
  const { instances, quota } = config.execution;
  return instances
    .filter((i) => quota.readers[i.id]?.enabled === false)
    .flatMap((i) => READER_OF[i.adapter] ?? []);
}

/** Builds the real runner dependencies; call `close()` when done. */
export function createRunnerDeps(opts: CreateRunnerDepsOptions): RunnerDeps & { close(): void } {
  const { config, env } = opts;
  const clock = opts.clock ?? systemClock;
  const home = opts.overrides?.dispatchHome ?? defaultDispatchHome(env);
  const secrets: string[] = [];
  const store = SqliteStateStore.open(opts.dbPath ?? join(home, "state", "dispatch.db"), {
    clock,
    secrets: () => secrets,
  });
  const spawner = opts.spawner ?? new ProcessSpawner({ clock });
  const host = detectHost(env);
  const instances = config.execution.instances;
  let quota: DefaultQuotaProvider;
  const readers = defaultReaders({
    clock,
    spawner,
    store,
    env,
    ...(opts.version ? { version: opts.version } : {}),
    onObservation: (o) => quota.recordObservation(o),
  });
  quota = new DefaultQuotaProvider({
    store,
    clock,
    readers,
    disabledReaders: disabledReaderIds(config),
    reliability: { cacheMinutes: config.execution.quota.cacheMinutes },
    instancePlans: Object.fromEntries(
      instances.flatMap((i) => (i.plan ? [[i.id, i.plan] as const] : [])),
    ),
  });
  return {
    config,
    store,
    quota,
    clock,
    spawner,
    sandbox: new WorktreeSandbox(),
    adapters: {
      claude: createClaudeAdapter(),
      codex: createCodexAdapter(),
      antigravity: createAgyAdapter(),
    },
    resolveBinary: async (name, instance) =>
      resolveBinary(name, { configured: instance.binary, env })?.path ?? null,
    env,
    host,
    dispatchHome: home,
    addSecrets: (values) => secrets.push(...values),
    ...opts.overrides,
    close: () => store.close(),
  };
}
