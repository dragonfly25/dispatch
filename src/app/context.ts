/**
 * The composition root: every command builds one {@link AppContext} and gets its collaborators
 * from it (effective config, state store, quota provider, host identity, clock).
 *
 * The store and the quota provider are created lazily, so commands that never touch the state
 * database (`validate`, `profiles`, `use`) do not create `<dispatchHome>/state/dispatch.db`.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { dispatchHome, type EffectiveConfig, loadEffectiveConfig } from "../config/index.js";
import { assetsDir as builtInAssetsDir } from "../config/paths.js";
import { systemClock } from "../core/clock.js";
import {
  type Autonomy,
  AutonomySchema,
  type Clock,
  type DecisionInput,
  ExitCode,
  type ProviderInstance,
  type QuotaSnapshot,
  type SessionHistoryEntry,
  type Spawner,
  type Task,
} from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import { newRunId } from "../core/ids.js";
import { detectHost, type HostDetection } from "../platform/host.js";
import { DefaultQuotaProvider, type RunCostContext } from "../quota/provider.js";
import type { QuotaReaderRegistry } from "../quota/reader.js";
import { defaultReaders } from "../quota/readers/index.js";
import { ROUTER_VERSION } from "../router/index.js";
import { ProcessSpawner } from "../runner/proc.js";
import { SqliteStateStore } from "../state/store.js";
import { forceProvider } from "./force-provider.js";

/** Process environment (or a test double). */
export type AppEnv = Readonly<Record<string, string | undefined>>;

/** Who is calling Dispatch: the detected host client and the provider instance it corresponds to. */
export interface AppHost {
  detection: HostDetection;
  /** Instance id of the host (never chosen as a delegation target); null outside any host. */
  self: string | null;
}

export interface LoadAppContextOptions {
  cwd: string;
  env: AppEnv;
  /** Config overlay from CLI flags (same keys as `.dispatch/config.yaml`); validated by the loader. */
  flags?: unknown;
  clock?: Clock;
  /** Task id source for {@link buildTask}; default: a fresh ULID-style id from the clock. */
  newId?: () => string;
  /** Quota readers per adapter; overrides the default set (tests pass an empty registry). */
  quotaReaders?: QuotaReaderRegistry;
  /** Spawner for the quota readers and the runner; default: a `ProcessSpawner`. */
  spawner?: Spawner;
  /** Override of the built-in assets directory (tests). */
  assetsDir?: string;
  /**
   * `--provider <instance>`: a flag-level pin that routes every task to this instance first
   * (see {@link forceProvider}). `undefined` or `"auto"` leaves routing alone.
   * @throws DispatchError (exit 2) for an unknown or disabled instance.
   */
  provider?: string | undefined;
  /**
   * Read-only command: when the state database does not exist yet, the store is an empty
   * in-memory database and nothing is created on disk (a never-set-up Dispatch leaves no trace).
   * An existing database is opened as usual. Commands that record state must not set this.
   */
  readOnly?: boolean;
}

/** Everything a command needs. Create with {@link loadAppContext}; call `close()` when done. */
export interface AppContext {
  cwd: string;
  env: AppEnv;
  clock: Clock;
  config: EffectiveConfig;
  host: AppHost;
  /** Global Dispatch home (`$DISPATCH_HOME` or `~/.dispatch`). */
  dispatchHome: string;
  /** Directory of the built-in profiles, mappings and model tables. */
  assetsDir: string;
  /** `<dispatchHome>/state/dispatch.db`. */
  dbPath: string;
  /** Opened on first access (redacts {@link AppContext.secrets} from everything it stores). */
  readonly store: SqliteStateStore;
  /** Process spawner shared by the quota readers and the runner. */
  readonly spawner: Spawner;
  /** Env values withheld from children; the store masks them too. Grows while a run starts. */
  readonly secrets: string[];
  /** Created on first access (opens the store). */
  readonly quota: DefaultQuotaProvider;
  /** The quota readers in use (default: claude, codex and agy readers). */
  readonly readers: QuotaReaderRegistry;
  newId(): string;
  /** Closes the store if it was opened. */
  close(): void;
}

/** Loads the effective configuration and wires the collaborators. Throws `config.*` errors. */
export function loadAppContext(opts: LoadAppContextOptions): AppContext {
  const clock = opts.clock ?? systemClock;
  let config = loadEffectiveConfig({
    cwd: opts.cwd,
    env: opts.env,
    ...(opts.flags === undefined ? {} : { flags: opts.flags }),
    ...(opts.assetsDir === undefined ? {} : { assetsDir: opts.assetsDir }),
  });
  if (opts.provider !== undefined && opts.provider !== "auto") {
    config = forceProvider(config, opts.provider);
  }
  const host = resolveHost(opts.env, config.execution.instances);
  const home = dispatchHome(opts.env);
  const dbPath = join(home, "state", "dispatch.db");

  let store: SqliteStateStore | undefined;
  let quota: DefaultQuotaProvider | undefined;
  let readers: QuotaReaderRegistry | undefined;
  const secrets: string[] = [];
  const spawner = opts.spawner ?? new ProcessSpawner();
  const ctx: AppContext = {
    cwd: opts.cwd,
    env: opts.env,
    clock,
    config,
    host,
    dispatchHome: home,
    assetsDir: opts.assetsDir ?? builtInAssetsDir(),
    dbPath,
    spawner,
    secrets,
    get store() {
      store ??= SqliteStateStore.open(opts.readOnly && !existsSync(dbPath) ? ":memory:" : dbPath, {
        clock,
        secrets: () => secrets,
      });
      return store;
    },
    get readers() {
      readers ??=
        opts.quotaReaders ??
        defaultReaders({
          clock,
          spawner,
          store: ctx.store,
          env: opts.env,
          reliability: { cacheMinutes: ctx.config.execution.quota.cacheMinutes },
          onObservation: (o) => ctx.quota.recordObservation(o),
        });
      return readers;
    },
    get quota() {
      quota ??= new DefaultQuotaProvider({
        store: ctx.store,
        clock,
        readers: ctx.readers,
        disabledReaders: disabledReaders(ctx.config, ctx.readers),
        reliability: { cacheMinutes: ctx.config.execution.quota.cacheMinutes },
        instancePlans: instancePlans(ctx.config),
        relativeCost: relativeCost(ctx.config),
        hostInstanceId: host.self,
      });
      return quota;
    },
    newId: opts.newId ?? (() => newRunId(clock)),
    close() {
      store?.close();
      store = undefined;
      quota = undefined;
      readers = undefined;
    },
  };
  return ctx;
}

/**
 * Reader ids switched off by `quota.readers.<key>.enabled: false`, where `<key>` is a reader id
 * or an instance id (which disables every reader of that instance's adapter).
 */
export function disabledReaders(config: EffectiveConfig, registry: QuotaReaderRegistry): string[] {
  const switches = config.execution.quota.readers;
  const off = (key: string) => switches[key]?.enabled === false;
  const byInstance = config.execution.instances
    .filter((i) => off(i.id))
    .flatMap((i) => registry.forAdapter(i.adapter).map((r) => r.id));
  const byId = registry.all().filter((r) => off(r.id));
  return [...new Set([...byInstance, ...byId.map((r) => r.id)])];
}

function instancePlans(config: EffectiveConfig): Record<string, string> {
  return Object.fromEntries(
    config.execution.instances.flatMap((i) => (i.plan === undefined ? [] : [[i.id, i.plan]])),
  );
}

/** Relative cost of a run from the model tables (tier first, then the model name); 1 if unknown. */
function relativeCost(config: EffectiveConfig): (ctx: RunCostContext) => number {
  const { instances, models } = config.routing;
  return ({ instanceId, model, tier }) => {
    const adapter = instances.find((i) => i.id === instanceId)?.adapter;
    const rows = Object.entries((adapter && models[adapter]?.tiers) || {});
    const byTier = rows.find(([name]) => name === tier);
    const byModel = rows.find(([, row]) => row.model === model);
    return (byTier ?? byModel)?.[1].relativeCost ?? 1;
  };
}

// ---------------------------------------------------------------------------
// Host identity
// ---------------------------------------------------------------------------

const HOST_ADAPTER = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "antigravity",
} as const;

/** True when two directory paths name the same place (`~` expanded, symlinks resolved if present). */
function samePath(a: string, b: string, env: AppEnv): boolean {
  const norm = (p: string) => {
    const expanded = p.startsWith("~/") && env.HOME ? join(env.HOME, p.slice(2)) : p;
    const abs = resolve(expanded);
    try {
      return realpathSync(abs);
    } catch {
      return abs;
    }
  };
  return norm(a) === norm(b);
}

/**
 * Maps the detected host client to its provider instance: Claude Code → the claude instance whose
 * `config_dir` equals `CLAUDE_CONFIG_DIR` (else the default one: no config dir); Codex → the codex
 * instance; Antigravity → the antigravity instance. No detected host, or no matching instance,
 * gives `self: null`.
 */
export function resolveHost(env: AppEnv, instances: readonly ProviderInstance[]): AppHost {
  const detection = detectHost(env);
  const kind = detection.host;
  if (kind === null) return { detection, self: null };
  const candidates = instances.filter((i) => i.adapter === HOST_ADAPTER[kind]);
  const dir = env.CLAUDE_CONFIG_DIR;
  const byDir =
    kind === "claude-code" && dir
      ? candidates.find((i) => i.configDir !== undefined && samePath(i.configDir, dir, env))
      : undefined;
  const fallback = candidates.find((i) => i.configDir === undefined) ?? candidates[0];
  return { detection, self: (byDir ?? fallback)?.id ?? null };
}

// ---------------------------------------------------------------------------
// Task and decision input
// ---------------------------------------------------------------------------

/** Task-describing CLI flags (`--task`, `--task-file`, `--task-type`, `--path`, ...). */
export interface TaskFlags {
  task?: string | undefined;
  taskFile?: string | undefined;
  taskType?: string | undefined;
  path?: readonly string[] | undefined;
  model?: string | undefined;
  tier?: string | undefined;
  effort?: string | undefined;
  autonomy?: string | undefined;
  /** Seconds. */
  timeout?: string | number | undefined;
}

const usage = (message: string) => new DispatchError(message, ExitCode.USAGE, "cli.usage");

/**
 * Builds a {@link Task} from CLI flags. The prompt is `--task` or the content of `--task-file`
 * (relative to `ctx.cwd`); autonomy and timeout default to the configuration's.
 *
 * @throws DispatchError (exit 2) for a missing/ambiguous prompt, or an unknown tier, effort,
 *   autonomy or timeout.
 */
export function buildTask(ctx: AppContext, flags: TaskFlags): Task {
  if (flags.task !== undefined && flags.taskFile !== undefined) {
    throw usage("use either --task or --task-file, not both");
  }
  let prompt = flags.task;
  if (flags.taskFile !== undefined) {
    try {
      prompt = readFileSync(resolve(ctx.cwd, flags.taskFile), "utf8");
    } catch (err) {
      throw usage(`cannot read --task-file ${flags.taskFile}: ${(err as Error).message}`);
    }
  }
  if (prompt === undefined || prompt.trim() === "") {
    throw usage("a task is required: pass --task <text> or --task-file <path>");
  }
  const { routing, execution } = ctx.config;
  if (flags.tier !== undefined && !routing.tiers.includes(flags.tier)) {
    throw usage(`unknown tier "${flags.tier}" (known: ${routing.tiers.join(", ")})`);
  }
  if (flags.effort !== undefined && !routing.efforts.includes(flags.effort)) {
    throw usage(`unknown effort "${flags.effort}" (known: ${routing.efforts.join(", ")})`);
  }
  let autonomy: Autonomy = execution.autonomy;
  if (flags.autonomy !== undefined) {
    const parsed = AutonomySchema.safeParse(flags.autonomy);
    if (!parsed.success) {
      throw usage(
        `unknown autonomy "${flags.autonomy}" (known: ${AutonomySchema.options.join(", ")})`,
      );
    }
    autonomy = parsed.data;
  }
  let timeoutMs = execution.timeouts.defaultTaskMs;
  if (flags.timeout !== undefined) {
    const seconds = Number(flags.timeout);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      throw usage(`--timeout must be a positive number of seconds, got "${flags.timeout}"`);
    }
    timeoutMs = Math.ceil(seconds * 1000);
  }
  return {
    id: ctx.newId(),
    prompt,
    ...(flags.taskType === undefined ? {} : { taskType: flags.taskType }),
    paths: [...(flags.path ?? [])],
    ...(flags.model === undefined ? {} : { requestedModel: flags.model }),
    ...(flags.tier === undefined ? {} : { tier: flags.tier }),
    ...(flags.effort === undefined ? {} : { effort: flags.effort }),
    autonomy,
    timeoutMs,
  };
}

export interface DecisionInputOptions {
  sessionHistory?: readonly SessionHistoryEntry[];
  /** The host session's model, when known; `observed` is true when read from the host. */
  sessionModel?: { value: string; observed: boolean };
}

/** Quota snapshot for the router; a broken store or reader degrades to "unknown", never throws. */
export async function snapshotOrUnknown(
  ctx: AppContext,
  host: string | null,
): Promise<QuotaSnapshot> {
  // Only enabled instances are read: a disabled provider (e.g. Antigravity, off by default for
  // ToS reasons) must never have its CLI spawned, not even for a quota-free read.
  const all = ctx.config.execution.instances;
  const instances = all.filter((i) => i.enabled);
  try {
    const snap = await ctx.quota.snapshot(instances, { hostInstanceId: host });
    for (const inst of all) {
      if (!inst.enabled && snap.instances[inst.id] === undefined) {
        snap.instances[inst.id] = {
          windows: [
            {
              kind: "unknown",
              usedPct: null,
              resetAt: null,
              source: "disabled",
              readAt: snap.takenAt,
              reliability: "unknown",
            },
          ],
          pool: inst.pool,
        };
      }
    }
    return snap;
  } catch {
    return {
      takenAt: ctx.clock.now().toISOString(),
      instances: Object.fromEntries(
        instances.map((i) => [i.id, { windows: [], pool: i.pool }] as const),
      ),
    };
  }
}

/**
 * Assembles the canonical, complete input of the pure router: the task, the host identity, the
 * effective routing config, a fresh quota snapshot and the decision time (all from `ctx`).
 */
export async function buildDecisionInput(
  ctx: AppContext,
  task: Task,
  options: DecisionInputOptions = {},
): Promise<DecisionInput> {
  const quota = await snapshotOrUnknown(ctx, ctx.host.self);
  return {
    task,
    host: {
      self: ctx.host.self,
      ...(options.sessionModel ? { sessionModel: options.sessionModel } : {}),
      depth: ctx.host.detection.depth,
    },
    routing: structuredClone(ctx.config.routing) as unknown as Record<string, unknown>,
    quota,
    sessionHistory: [...(options.sessionHistory ?? [])],
    now: ctx.clock.now().toISOString(),
    routerVersion: ROUTER_VERSION,
  };
}
