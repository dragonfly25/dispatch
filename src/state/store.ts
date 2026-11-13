/**
 * SQLite-backed {@link StateStore} plus the extra operations the runner, quota and CLI layers need
 * (leases, idempotency, quota history, shadow decisions, overrides, retention).
 *
 * Rules enforced here:
 * - EVERY value written to the database passes through {@link redactDeep} first.
 * - Logic never reads the system clock: time comes from the injected {@link Clock} or from an
 *   explicit `now` argument.
 * - The `StateStore` port methods are async (it is a port); the extras are synchronous because the
 *   underlying driver is. Multi-statement operations run in one `BEGIN IMMEDIATE` transaction, so
 *   they are atomic across connections and processes.
 */

import { systemClock } from "../core/clock.js";
import type {
  Clock,
  Decision,
  DecisionInput,
  DecisionRecord,
  NormalizedEvent,
  QuotaWindow,
  RunRecord,
  StateStore,
} from "../core/contracts.js";
import { type DbPort, openDb, type Row, type SqlValue } from "./db.js";
import { migrate } from "./migrations.js";
import { redactDeep } from "./redact.js";

/** A point in time: a `Date` or an ISO-8601 string. */
export type Instant = Date | string;

/** A lease whose heartbeat is older than this is dead (the runner beats every 5 s). */
export const LEASE_STALE_MS = 30_000;

/** Decides whether the process `(pid, pidStart)` still exists and is the same process. */
export type IsAlive = (pid: number, pidStart: string) => boolean;

export interface StateStoreOptions {
  /** Time source for bookkeeping timestamps. Defaults to the system clock. */
  clock?: Clock;
  /** Literal secrets (e.g. non-allow-listed env values) to scrub in addition to the patterns. */
  secrets?: readonly string[] | (() => readonly string[]);
}

export interface ListRunsOptions {
  status?: RunRecord["status"];
  limit?: number;
}

export interface LeaseRequest {
  pid: number;
  pidStart: string;
  /** Maximum number of live leases for the instance. */
  limit: number;
  now: Instant;
  isAlive: IsAlive;
}

export interface LeaseRecord {
  runId: string;
  instanceId: string;
  pid: number;
  pidStart: string;
  acquiredAt: string;
  heartbeatAt: string;
}

export interface QuotaReadingRecord {
  instanceId: string;
  window: QuotaWindow;
}

export interface QuotaSignalRecord {
  instanceId: string;
  /** Latest announced availability time among the instance's signals. */
  until: string;
  error: string | null;
}

export interface OverrideRecord {
  instanceId: string;
  window: string;
  usedPct: number;
  expiresAt: string;
}

export interface ShadowRecord {
  decisionId: string;
  profile: string;
  decision: Decision;
  createdAt: string;
}

/** Rows removed per table by {@link SqliteStateStore.prune}. */
export type PruneCounts = Record<
  | "runs"
  | "decisions"
  | "shadowDecisions"
  | "quotaReadings"
  | "quotaSignals"
  | "overrides"
  | "idempotency",
  number
>;

const DAY_MS = 86_400_000;

/** Normalises to `YYYY-MM-DDTHH:mm:ss.sssZ` so text comparison equals time comparison. */
function iso(t: Instant): string {
  const d = typeof t === "string" ? new Date(t) : t;
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid timestamp: ${String(t)}`);
  return d.toISOString();
}

const str = (v: unknown): string => String(v);
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** State store on a {@link DbPort}. Create it with {@link SqliteStateStore.open}. */
export class SqliteStateStore implements StateStore {
  readonly #clock: Clock;
  readonly #secrets: () => readonly string[];

  constructor(
    private readonly db: DbPort,
    options: StateStoreOptions = {},
  ) {
    this.#clock = options.clock ?? systemClock;
    const s = options.secrets ?? [];
    this.#secrets = typeof s === "function" ? s : () => s;
    migrate(db);
  }

  /** Opens the database at `path` (see {@link openDb}), migrates it and wraps it. */
  static open(path: string, options?: StateStoreOptions): SqliteStateStore {
    const db = openDb(path);
    try {
      return new SqliteStateStore(db, options);
    } catch (err) {
      db.close();
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Redacted deep copy; the single choke point for everything written to disk. */
  #clean<T>(value: T): T {
    return redactDeep(value, this.#secrets());
  }

  #now(): string {
    return iso(this.#clock.now());
  }

  // -------------------------------------------------------------------------
  // StateStore port
  // -------------------------------------------------------------------------

  async recordDecision(record: DecisionRecord): Promise<void> {
    const r = this.#clean(record);
    this.db
      .prepare(
        "INSERT INTO decisions (id, created_at, run_id, input_json, decision_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(r.id, iso(r.createdAt), r.runId, JSON.stringify(r.input), JSON.stringify(r.decision));
  }

  async recordRun(run: RunRecord): Promise<void> {
    const r = this.#clean(run);
    this.db.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(r.runId)) {
        throw new Error(`run already exists: ${r.runId}`);
      }
      this.#insertRun(r);
    });
  }

  /**
   * Shallow-merges `patch` into the run. `updatedAt` is set from the clock unless the patch
   * carries one.
   */
  async updateRun(runId: string, patch: Partial<Omit<RunRecord, "runId">>): Promise<RunRecord> {
    const cleanPatch = this.#clean(patch);
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
      if (!row) throw new Error(`unknown run: ${runId}`);
      const merged: RunRecord = { ...toRun(row), ...cleanPatch, runId };
      if (!("updatedAt" in cleanPatch)) merged.updatedAt = this.#now();
      this.db
        .prepare(
          `UPDATE runs SET status = ?, created_at = ?, updated_at = ?, instance = ?, pid = ?,
             result_json = ? WHERE run_id = ?`,
        )
        .run(
          merged.status,
          iso(merged.createdAt),
          iso(merged.updatedAt),
          merged.instance,
          merged.pid,
          merged.result === null ? null : JSON.stringify(merged.result),
          runId,
        );
      return merged;
    });
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    const row = this.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
    return row ? toRun(row) : null;
  }

  async appendEvent(runId: string, event: NormalizedEvent): Promise<void> {
    const e = this.#clean(event);
    this.db
      .prepare("INSERT INTO events (run_id, ts, kind, event_json) VALUES (?, ?, ?, ?)")
      .run(runId, iso(e.ts), e.kind, JSON.stringify(e));
  }

  async listDecisions(since: string): Promise<DecisionRecord[]> {
    return this.db
      .prepare("SELECT * FROM decisions WHERE created_at >= ? ORDER BY created_at, id")
      .all(iso(since))
      .map((row) => ({
        id: str(row.id),
        createdAt: str(row.created_at),
        runId: strOrNull(row.run_id),
        input: JSON.parse(str(row.input_json)) as DecisionInput,
        decision: JSON.parse(str(row.decision_json)) as Decision,
      }));
  }

  // -------------------------------------------------------------------------
  // Runs and events (extras)
  // -------------------------------------------------------------------------

  #insertRun(r: RunRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (run_id, status, created_at, updated_at, instance, pid, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.runId,
        r.status,
        iso(r.createdAt),
        iso(r.updatedAt),
        r.instance,
        r.pid,
        r.result === null ? null : JSON.stringify(r.result),
      );
  }

  /**
   * Records the absolute run directory of `runId` (written by `run --detach`, read by `cancel` so
   * it does not depend on the cwd it is started from). Redacted like every other write. Not part of {@link RunRecord} (frozen).
   */
  setRunDir(runId: string, dir: string): void {
    const res = this.db
      .prepare("UPDATE runs SET run_dir = ? WHERE run_id = ?")
      .run(this.#clean(dir), runId);
    if (Number(res.changes) === 0) throw new Error(`unknown run: ${runId}`);
  }

  /** The run directory recorded with {@link setRunDir}; null for unknown runs and older rows. */
  getRunDir(runId: string): string | null {
    const row = this.db.prepare("SELECT run_dir FROM runs WHERE run_id = ?").get(runId);
    return row ? strOrNull(row.run_dir) : null;
  }

  /** Newest runs first, optionally filtered by status. `limit` defaults to 50. */
  listRuns(options: ListRunsOptions = {}): RunRecord[] {
    const limit = options.limit ?? 50;
    const rows = options.status
      ? this.db
          .prepare(
            "SELECT * FROM runs WHERE status = ? ORDER BY created_at DESC, run_id DESC LIMIT ?",
          )
          .all(options.status, limit)
      : this.db
          .prepare("SELECT * FROM runs ORDER BY created_at DESC, run_id DESC LIMIT ?")
          .all(limit);
    return rows.map(toRun);
  }

  /** Events of a run in insertion order. */
  listEvents(runId: string): NormalizedEvent[] {
    return this.db
      .prepare("SELECT event_json FROM events WHERE run_id = ? ORDER BY id")
      .all(runId)
      .map((row) => JSON.parse(str(row.event_json)) as NormalizedEvent);
  }

  // -------------------------------------------------------------------------
  // Shadow decisions
  // -------------------------------------------------------------------------

  /** Stores what `profile` would have decided for `decisionId` (replaces an earlier one). */
  recordShadow(decisionId: string, profile: string, decision: Decision): void {
    const d = this.#clean({ decisionId, profile, decision });
    this.db
      .prepare(
        `INSERT OR REPLACE INTO shadow_decisions (decision_id, profile, decision_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(d.decisionId, d.profile, JSON.stringify(d.decision), this.#now());
  }

  /** Shadow decisions recorded at or after `since`, oldest first. */
  listShadow(since: Instant): ShadowRecord[] {
    return this.db
      .prepare(
        "SELECT * FROM shadow_decisions WHERE created_at >= ? ORDER BY created_at, decision_id, profile",
      )
      .all(iso(since))
      .map((row) => ({
        decisionId: str(row.decision_id),
        profile: str(row.profile),
        decision: JSON.parse(str(row.decision_json)) as Decision,
        createdAt: str(row.created_at),
      }));
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  /** Appends a quota reading (history is kept; see {@link latestQuotaReadings}). */
  recordQuotaReading(instanceId: string, window: QuotaWindow): void {
    const r = this.#clean({ instanceId, window });
    this.db
      .prepare(
        `INSERT INTO quota_readings (instance_id, kind, used_pct, reset_at, source, read_at, reliability)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r.instanceId,
        r.window.kind,
        r.window.usedPct,
        r.window.resetAt === null ? null : iso(r.window.resetAt),
        r.window.source,
        iso(r.window.readAt),
        r.window.reliability,
      );
  }

  /** The most recent reading (by `readAt`) of every instance and window kind. */
  latestQuotaReadings(): QuotaReadingRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY instance_id, kind ORDER BY read_at DESC, id DESC) AS rn
           FROM quota_readings)
         WHERE rn = 1 ORDER BY instance_id, kind`,
      )
      .all()
      .map((row) => ({
        instanceId: str(row.instance_id),
        window: {
          kind: str(row.kind),
          usedPct: row.used_pct === null ? null : Number(row.used_pct),
          resetAt: strOrNull(row.reset_at),
          source: str(row.source),
          readAt: str(row.read_at),
          reliability: str(row.reliability) as QuotaWindow["reliability"],
        },
      }));
  }

  /** Records that `instanceId` reported quota exhaustion and is unavailable until `until`. */
  recordQuotaSignal(instanceId: string, until: Instant, error?: string): void {
    const s = this.#clean({ instanceId, error: error ?? null });
    this.db
      .prepare(
        "INSERT INTO quota_signals (instance_id, until, error, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(s.instanceId, iso(until), s.error, this.#now());
  }

  /** One entry per instance that is still marked exhausted at `now` (latest `until` wins). */
  activeQuotaSignals(now: Instant): QuotaSignalRecord[] {
    return this.db
      .prepare(
        `SELECT instance_id, until, error FROM (
           SELECT *, ROW_NUMBER() OVER (
             PARTITION BY instance_id ORDER BY until DESC, id DESC) AS rn
           FROM quota_signals WHERE until > ?)
         WHERE rn = 1 ORDER BY instance_id`,
      )
      .all(iso(now))
      .map((row) => ({
        instanceId: str(row.instance_id),
        until: str(row.until),
        error: strOrNull(row.error),
      }));
  }

  /** `status --set`: pins a window's used percentage until `expiresAt` (replaces any earlier one). */
  setOverride(o: OverrideRecord): void {
    const r = this.#clean(o);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO overrides (instance_id, window, used_pct, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(r.instanceId, r.window, r.usedPct, iso(r.expiresAt));
  }

  /** Overrides that have not expired at `now`. */
  listOverrides(now: Instant): OverrideRecord[] {
    return this.db
      .prepare("SELECT * FROM overrides WHERE expires_at > ? ORDER BY instance_id, window")
      .all(iso(now))
      .map((row) => ({
        instanceId: str(row.instance_id),
        window: str(row.window),
        usedPct: Number(row.used_pct),
        expiresAt: str(row.expires_at),
      }));
  }

  // -------------------------------------------------------------------------
  // Leases
  // -------------------------------------------------------------------------

  #isLive(row: Row, nowMs: number, isAlive: IsAlive): boolean {
    const age = nowMs - Date.parse(str(row.heartbeat_at));
    return age <= LEASE_STALE_MS && isAlive(Number(row.pid), str(row.pid_start));
  }

  /**
   * Takes a concurrency slot for `instanceId`. Succeeds when fewer than `limit` OTHER leases of
   * the instance are live (fresh heartbeat AND `isAlive`); dead leases of the instance are removed
   * on the way. Atomic across connections. Re-acquiring with the same `runId` refreshes the lease.
   */
  acquireLease(instanceId: string, runId: string, req: LeaseRequest): boolean {
    const now = iso(req.now);
    const nowMs = Date.parse(now);
    const c = this.#clean({ instanceId, runId, pidStart: req.pidStart });
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT * FROM leases WHERE instance_id = ?").all(c.instanceId);
      let live = 0;
      for (const row of rows) {
        if (str(row.run_id) === c.runId) continue;
        if (this.#isLive(row, nowMs, req.isAlive)) live++;
        else this.db.prepare("DELETE FROM leases WHERE run_id = ?").run(str(row.run_id));
      }
      if (live >= req.limit) return false;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO leases
             (run_id, instance_id, pid, pid_start, acquired_at, heartbeat_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(c.runId, c.instanceId, req.pid, c.pidStart, now, now);
      return true;
    });
  }

  /** Refreshes the lease's heartbeat. Returns false when the lease no longer exists. */
  heartbeat(runId: string, now: Instant): boolean {
    const info = this.db
      .prepare("UPDATE leases SET heartbeat_at = ? WHERE run_id = ?")
      .run(iso(now), runId);
    return info.changes > 0;
  }

  /** Frees the slot. Returns false when there was no lease. */
  releaseLease(runId: string): boolean {
    return this.db.prepare("DELETE FROM leases WHERE run_id = ?").run(runId).changes > 0;
  }

  /** Live and dead leases currently stored, oldest first. */
  listLeases(): LeaseRecord[] {
    return this.db.prepare("SELECT * FROM leases ORDER BY acquired_at, run_id").all().map(toLease);
  }

  /** Deletes every lease that is not live at `now` and returns them. */
  reapStaleLeases(now: Instant, isAlive: IsAlive): LeaseRecord[] {
    const nowMs = Date.parse(iso(now));
    return this.db.transaction(() => {
      const dead = this.db
        .prepare("SELECT * FROM leases ORDER BY acquired_at, run_id")
        .all()
        .filter((row) => !this.#isLive(row, nowMs, isAlive));
      for (const row of dead)
        this.db.prepare("DELETE FROM leases WHERE run_id = ?").run(str(row.run_id));
      return dead.map(toLease);
    });
  }

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  /**
   * Returns the run id already bound to `key`, or binds a fresh one from `runIdFactory`. Atomic:
   * of any number of concurrent callers (even from other processes) with the same key exactly one
   * gets `created: true`; the factory runs only for that caller.
   */
  getOrCreateIdempotent(
    key: string,
    runIdFactory: () => string,
  ): { runId: string; created: boolean } {
    const k = this.#clean(key);
    return this.db.transaction(() => {
      const existing = this.db.prepare("SELECT run_id FROM idempotency WHERE key = ?").get(k);
      if (existing) return { runId: str(existing.run_id), created: false };
      const runId = runIdFactory();
      this.db
        .prepare("INSERT INTO idempotency (key, run_id, created_at) VALUES (?, ?, ?)")
        .run(k, this.#clean(runId), this.#now());
      return { runId, created: true };
    });
  }

  // -------------------------------------------------------------------------
  // Retention
  // -------------------------------------------------------------------------

  /**
   * Deletes data older than `olderThanDays` relative to `now`: finished runs (and their events),
   * decisions, shadow decisions, quota readings, expired signals and overrides, idempotency keys.
   * Runs that are still `running` and all leases are never touched.
   */
  prune(opts: { olderThanDays: number; now: Instant }): PruneCounts {
    const cutoff = new Date(Date.parse(iso(opts.now)) - opts.olderThanDays * DAY_MS).toISOString();
    const del = (sql: string, ...params: SqlValue[]): number =>
      this.db.prepare(sql).run(...params).changes;
    return this.db.transaction(() => ({
      runs: del("DELETE FROM runs WHERE status <> 'running' AND updated_at < ?", cutoff),
      decisions: del("DELETE FROM decisions WHERE created_at < ?", cutoff),
      shadowDecisions: del("DELETE FROM shadow_decisions WHERE created_at < ?", cutoff),
      quotaReadings: del("DELETE FROM quota_readings WHERE read_at < ?", cutoff),
      quotaSignals: del("DELETE FROM quota_signals WHERE until < ?", cutoff),
      overrides: del("DELETE FROM overrides WHERE expires_at < ?", cutoff),
      idempotency: del("DELETE FROM idempotency WHERE created_at < ?", cutoff),
    }));
  }
}

function toRun(row: Row): RunRecord {
  return {
    runId: str(row.run_id),
    status: str(row.status) as RunRecord["status"],
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
    instance: strOrNull(row.instance),
    pid: row.pid === null ? null : Number(row.pid),
    result:
      row.result_json === null ? null : (JSON.parse(str(row.result_json)) as RunRecord["result"]),
  };
}

function toLease(row: Row): LeaseRecord {
  return {
    runId: str(row.run_id),
    instanceId: str(row.instance_id),
    pid: Number(row.pid),
    pidStart: str(row.pid_start),
    acquiredAt: str(row.acquired_at),
    heartbeatAt: str(row.heartbeat_at),
  };
}
