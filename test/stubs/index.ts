/**
 * In-memory / temp-dir implementations of the core ports, for unit and integration tests.
 * They implement the frozen interfaces in src/core/contracts.ts and nothing more.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Clock,
  DecisionRecord,
  NormalizedEvent,
  ProviderInstance,
  QuotaObservation,
  QuotaProvider,
  QuotaSnapshot,
  RunRecord,
  Sandbox,
  SandboxCreateOptions,
  SandboxHandle,
  Spawner,
  SpawnRequest,
  SpawnResult,
  StateStore,
} from "../../src/core/contracts.js";

/** Settable clock. `now()` and `monotonicMs()` advance together via {@link FakeClock.advance}. */
export class FakeClock implements Clock {
  #wall: number;
  #mono = 0;

  constructor(start: Date | string = "2026-01-01T00:00:00.000Z") {
    this.#wall = new Date(start).getTime();
  }
  now(): Date {
    return new Date(this.#wall);
  }
  monotonicMs(): number {
    return this.#mono;
  }
  /** Moves both clocks forward by `ms`. */
  advance(ms: number): void {
    this.#wall += ms;
    this.#mono += ms;
  }
  /** Sets wall time only (monotonic time never goes back). */
  set(at: Date | string): void {
    this.#wall = new Date(at).getTime();
  }
}

const clone = <T>(v: T): T => structuredClone(v);

/** StateStore kept in maps. Values are deep-cloned on the way in and out. */
export class MemoryStateStore implements StateStore {
  readonly decisions: DecisionRecord[] = [];
  readonly runs = new Map<string, RunRecord>();
  readonly events = new Map<string, NormalizedEvent[]>();

  async recordDecision(record: DecisionRecord): Promise<void> {
    this.decisions.push(clone(record));
  }
  async recordRun(run: RunRecord): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`run already exists: ${run.runId}`);
    this.runs.set(run.runId, clone(run));
  }
  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<RunRecord> {
    const current = this.runs.get(runId);
    if (!current) throw new Error(`unknown run: ${runId}`);
    const next = { ...current, ...clone(patch), runId };
    this.runs.set(runId, next);
    return clone(next);
  }
  async getRun(runId: string): Promise<RunRecord | null> {
    const run = this.runs.get(runId);
    return run ? clone(run) : null;
  }
  async appendEvent(runId: string, event: NormalizedEvent): Promise<void> {
    const list = this.events.get(runId) ?? [];
    list.push(clone(event));
    this.events.set(runId, list);
  }
  async listDecisions(since: string): Promise<DecisionRecord[]> {
    const t = Date.parse(since);
    return this.decisions
      .filter((d) => Date.parse(d.createdAt) >= t)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .map(clone);
  }
}

/** QuotaProvider returning a fixed snapshot (restricted to the requested instances). */
export class StubQuotaProvider implements QuotaProvider {
  readonly observations: QuotaObservation[] = [];

  constructor(public current: QuotaSnapshot) {}

  async snapshot(instances: readonly ProviderInstance[]): Promise<QuotaSnapshot> {
    const wanted = new Set(instances.map((i) => i.id));
    const entries = Object.entries(this.current.instances).filter(([id]) => wanted.has(id));
    return clone({ takenAt: this.current.takenAt, instances: Object.fromEntries(entries) });
  }
  async recordObservation(observation: QuotaObservation): Promise<void> {
    this.observations.push(clone(observation));
  }
}

/** Sandbox backed by empty temp dirs (no git). Tracks created and kept paths. */
export class FakeSandbox implements Sandbox {
  readonly created: SandboxHandle[] = [];
  readonly kept: string[] = [];

  constructor(
    private readonly baseRef = "0000000000000000000000000000000000000000",
    private readonly dirty = false,
  ) {}

  async create(opts: SandboxCreateOptions): Promise<SandboxHandle> {
    const path = await mkdtemp(join(tmpdir(), `dispatch-sbx-${opts.runId}-`));
    const handle = { path, baseRef: this.baseRef, dirtySnapshot: this.dirty };
    this.created.push(handle);
    return handle;
  }
  async dispose(path: string, keep: boolean): Promise<void> {
    if (keep) this.kept.push(path);
    else await rm(path, { recursive: true, force: true });
  }
}

/** One scripted child: lines emitted through `onLine`, then the result. */
export interface ScriptedSpawn {
  stdout?: string[];
  stderr?: string[];
  result?: Partial<SpawnResult>;
}

/**
 * Spawner that never starts a process: it records each request and replays scripted output in
 * call order (the last script repeats). Adapters receive it through `AdapterDeps`.
 */
export class ScriptedSpawner implements Spawner {
  readonly requests: SpawnRequest[] = [];

  constructor(private readonly scripts: ScriptedSpawn[] = [{}]) {}

  async spawn(req: SpawnRequest): Promise<SpawnResult> {
    this.requests.push(req);
    const script = this.scripts[Math.min(this.requests.length - 1, this.scripts.length - 1)] ?? {};
    for (const line of script.stdout ?? []) req.onLine?.("stdout", line);
    for (const line of script.stderr ?? []) req.onLine?.("stderr", line);
    return { exitCode: 0, signal: null, timedOut: false, ...script.result };
  }
}
