import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DispatchError } from "../../src/core/errors.js";
import { type DbPort, openDb } from "../../src/state/db.js";
import { LATEST_VERSION, MIGRATIONS, migrate, schemaVersion } from "../../src/state/migrations.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "dispatch-db-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tables = (db: DbPort): string[] =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((r) => String(r.name));

describe("openDb", () => {
  it("creates parent dir 0700 and file 0600 and applies the pragmas", async () => {
    const path = join(dir, "state", "dispatch.db");
    const db = openDb(path);
    expect(((await stat(join(dir, "state"))).mode & 0o777).toString(8)).toBe("700");
    expect(((await stat(path)).mode & 0o777).toString(8)).toBe("600");
    expect(db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(5000);
    expect(db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(1); // NORMAL
    expect(db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    db.close();
  });

  it("supports :memory: without touching the disk", () => {
    const db = openDb(":memory:");
    db.exec("CREATE TABLE t (a)");
    expect(db.prepare("INSERT INTO t VALUES (1)").run().changes).toBe(1);
    db.close();
  });
});

describe("transaction", () => {
  it("commits, rolls back on throw, and joins nested calls", () => {
    const db = openDb(join(dir, "t.db"));
    db.exec("CREATE TABLE t (a INTEGER)");
    const count = () => Number(db.prepare("SELECT COUNT(*) AS n FROM t").get()?.n);

    expect(
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (1)").run();
        return db.transaction(() => {
          db.prepare("INSERT INTO t VALUES (2)").run();
          return "done";
        });
      }),
    ).toBe("done");
    expect(count()).toBe(2);

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES (3)").run();
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(count()).toBe(2);

    // The connection is usable (and not stuck "nested") after a rollback.
    db.transaction(() => db.prepare("INSERT INTO t VALUES (4)").run());
    expect(count()).toBe(3);
    db.close();
  });
});

describe("migrations", () => {
  it("applies from an empty database and creates every table", () => {
    const db = openDb(join(dir, "m.db"));
    expect(schemaVersion(db)).toBe(0);
    expect(migrate(db)).toBe(LATEST_VERSION);
    expect(tables(db)).toEqual([
      "decisions",
      "events",
      "idempotency",
      "leases",
      "overrides",
      "quota_readings",
      "quota_signals",
      "runs",
      "shadow_decisions",
    ]);
    db.close();
  });

  it("is idempotent across re-open and keeps data", () => {
    const path = join(dir, "m.db");
    const first = openDb(path);
    migrate(first);
    first.prepare("INSERT INTO idempotency VALUES ('k', 'r', '2026-01-01T00:00:00.000Z')").run();
    first.close();

    const second = openDb(path);
    expect(migrate(second)).toBe(LATEST_VERSION);
    expect(migrate(second)).toBe(LATEST_VERSION);
    expect(second.prepare("SELECT run_id FROM idempotency").get()?.run_id).toBe("r");
    second.close();
  });

  it("applies only pending migrations in order", () => {
    const db = openDb(":memory:");
    const steps = [
      { version: 1, sql: "CREATE TABLE a (x)" },
      { version: 2, sql: "CREATE TABLE b (x)" },
    ];
    expect(migrate(db, steps.slice(0, 1))).toBe(1);
    expect(migrate(db, steps)).toBe(2);
    expect(tables(db)).toEqual(["a", "b"]);
    db.close();
  });

  it("rolls back a failing migration and leaves the version untouched", () => {
    const db = openDb(":memory:");
    const steps = [{ version: 1, sql: "CREATE TABLE a (x); THIS IS NOT SQL" }];
    expect(() => migrate(db, steps)).toThrow();
    expect(schemaVersion(db)).toBe(0);
    expect(tables(db)).toEqual([]);
    db.close();
  });

  it("refuses a database written by a newer Dispatch", () => {
    const db = openDb(":memory:");
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    expect(() => migrate(db)).toThrow(DispatchError);
    expect(() => migrate(db)).toThrow(/newer than this Dispatch/);
    db.close();
  });

  it("has consecutive versions starting at 1", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(MIGRATIONS.map((_, i) => i + 1));
  });
});
