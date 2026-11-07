/**
 * Ordered schema migrations, tracked with `PRAGMA user_version`. Never edit a released migration:
 * append a new one. Timestamps are ISO-8601 UTC text (lexicographically sortable).
 */
import { ExitCode } from "../core/contracts.js";
import { DispatchError } from "../core/errors.js";
import type { DbPort } from "./db.js";

/** One schema step; `version` must be consecutive starting at 1. */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
CREATE TABLE runs (
  run_id      TEXT PRIMARY KEY,
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  instance    TEXT,
  pid         INTEGER,
  result_json TEXT
);
CREATE INDEX runs_created_idx ON runs (created_at);
CREATE INDEX runs_status_idx ON runs (status, created_at);

CREATE TABLE decisions (
  id            TEXT PRIMARY KEY,
  created_at    TEXT NOT NULL,
  run_id        TEXT,
  input_json    TEXT NOT NULL,
  decision_json TEXT NOT NULL
);
CREATE INDEX decisions_created_idx ON decisions (created_at);

CREATE TABLE events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs (run_id) ON DELETE CASCADE,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  event_json TEXT NOT NULL
);
CREATE INDEX events_run_idx ON events (run_id, id);

CREATE TABLE quota_readings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  kind        TEXT NOT NULL,
  used_pct    REAL,
  reset_at    TEXT,
  source      TEXT NOT NULL,
  read_at     TEXT NOT NULL,
  reliability TEXT NOT NULL
);
CREATE INDEX quota_readings_idx ON quota_readings (instance_id, kind, read_at);

CREATE TABLE quota_signals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  instance_id TEXT NOT NULL,
  until       TEXT NOT NULL,
  error       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX quota_signals_idx ON quota_signals (instance_id, until);

CREATE TABLE shadow_decisions (
  decision_id   TEXT NOT NULL,
  profile       TEXT NOT NULL,
  decision_json TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (decision_id, profile)
);
CREATE INDEX shadow_created_idx ON shadow_decisions (created_at);

CREATE TABLE leases (
  run_id       TEXT PRIMARY KEY,
  instance_id  TEXT NOT NULL,
  pid          INTEGER NOT NULL,
  pid_start    TEXT NOT NULL,
  acquired_at  TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
CREATE INDEX leases_instance_idx ON leases (instance_id);

CREATE TABLE idempotency (
  key        TEXT PRIMARY KEY,
  run_id     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE overrides (
  instance_id TEXT NOT NULL,
  window      TEXT NOT NULL,
  used_pct    REAL NOT NULL,
  expires_at  TEXT NOT NULL,
  PRIMARY KEY (instance_id, window)
);
`,
  },
];

/** Latest schema version known to this build. */
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;

/** Current `user_version` of the database. */
export function schemaVersion(db: DbPort): number {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

/**
 * Applies every pending migration, each in its own transaction (so two processes opening the same
 * file concurrently cannot apply one twice). Safe to call on every start. Throws when the database
 * was written by a newer Dispatch. Returns the resulting schema version.
 */
export function migrate(db: DbPort, migrations: readonly Migration[] = MIGRATIONS): number {
  const latest = migrations[migrations.length - 1]?.version ?? 0;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new DispatchError(
      `state database schema v${current} is newer than this Dispatch (v${latest}); upgrade Dispatch`,
      ExitCode.TIMEOUT_OR_STATE,
      "state.schema_too_new",
    );
  }
  for (const m of migrations) {
    db.transaction(() => {
      // Re-read inside the write lock: another process may have migrated meanwhile.
      if (schemaVersion(db) >= m.version) return;
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
    });
  }
  return schemaVersion(db);
}
