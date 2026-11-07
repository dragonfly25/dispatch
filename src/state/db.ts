/**
 * Thin SQLite port. This is the ONLY file that imports `node:sqlite`, so the driver can be swapped
 * (e.g. for better-sqlite3) without touching the store or the migrations.
 */
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A bindable SQL parameter. */
export type SqlValue = string | number | bigint | null | Uint8Array;
/** A result row. */
export type Row = Record<string, unknown>;

/** Outcome of a write statement. */
export interface RunInfo {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** A prepared statement. Parameters are positional (`?`). */
export interface DbStatement {
  run(...params: SqlValue[]): RunInfo;
  get(...params: SqlValue[]): Row | undefined;
  all(...params: SqlValue[]): Row[];
}

/** Minimal synchronous database interface used by the state layer. */
export interface DbPort {
  /** Runs one or more statements without parameters. */
  exec(sql: string): void;
  prepare(sql: string): DbStatement;
  /**
   * Runs `fn` inside `BEGIN IMMEDIATE ... COMMIT`, taking the write lock up front so concurrent
   * writers serialize instead of failing on lock upgrade. Rolls back when `fn` throws. Calls made
   * from inside `fn` join the outer transaction.
   */
  transaction<T>(fn: () => T): T;
  close(): void;
}

/** Connection pragmas applied by {@link openDb} (plan §2 "State"). */
const PRAGMAS = [
  "PRAGMA journal_mode = WAL",
  "PRAGMA busy_timeout = 5000",
  "PRAGMA synchronous = NORMAL",
  "PRAGMA foreign_keys = ON",
] as const;

class NodeSqliteDb implements DbPort {
  #depth = 0;

  constructor(private readonly db: DatabaseSync) {}

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): DbStatement {
    const stmt = this.db.prepare(sql);
    return {
      run: (...params) => {
        const info = stmt.run(...params);
        return { changes: Number(info.changes), lastInsertRowid: info.lastInsertRowid };
      },
      get: (...params) => stmt.get(...params) as Row | undefined,
      all: (...params) => stmt.all(...params) as Row[],
    };
  }

  transaction<T>(fn: () => T): T {
    if (this.#depth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.#depth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.#depth = 0;
    }
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Opens (creating if needed) the database at `path` with WAL, a 5 s busy timeout and foreign keys.
 * The parent directory is created with mode 0700 and the file with mode 0600. Use `:memory:` for
 * a throwaway database (no files are touched).
 */
export function openDb(path: string): DbPort {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Create the file ourselves so it is never world-readable, even briefly.
    closeSync(openSync(path, "a", 0o600));
    chmodSync(path, 0o600);
  }
  const db = new DatabaseSync(path, { timeout: 5000 });
  for (const pragma of PRAGMAS) db.exec(pragma);
  return new NodeSqliteDb(db);
}
