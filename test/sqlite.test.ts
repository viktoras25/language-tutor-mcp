import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { migrate } from "../src/migrate";
import { SqliteD1 } from "../src/sqlite-d1";

const MIGRATIONS = join(__dirname, "..", "migrations");

describe("SqliteD1 adapter", () => {
  it("applies migrations once and skips them on the next start", () => {
    const db = new SqliteD1(":memory:");
    expect(migrate(db, MIGRATIONS).length).toBeGreaterThan(0);
    expect(migrate(db, MIGRATIONS)).toEqual([]);
  });

  it("honours the wrangler ledger of a restored dump", () => {
    const db = new SqliteD1(":memory:");
    migrate(db, MIGRATIONS);
    db.exec("DROP TABLE _migrations; CREATE TABLE d1_migrations (name TEXT)");
    db.raw.prepare("INSERT INTO d1_migrations VALUES ('0001_init.sql')").run();
    // Only 0001 is marked done. 0002 is re-runnable, 0003 is not: failing at 0003 (not at 0001) proves 0001 was skipped.
    expect(() => migrate(db, MIGRATIONS)).toThrow(/0003/);
  });

  it("rolls a batch back as a whole when one statement fails", async () => {
    const db = new SqliteD1(":memory:");
    db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    await expect(
      db.batch([db.prepare("INSERT INTO t VALUES (1)"), db.prepare("INSERT INTO t VALUES (1)")]),
    ).rejects.toThrow();
    expect((await db.prepare("SELECT count(*) AS n FROM t").first<{ n: number }>())!.n).toBe(0);
  });

  it("rejects undefined binds and maps booleans to 0/1", async () => {
    const db = new SqliteD1(":memory:");
    expect(() => db.prepare("SELECT ?1").bind(undefined)).toThrow(/undefined/);
    expect((await db.prepare("SELECT ?1 AS v").bind(true).first<{ v: number }>())!.v).toBe(1);
  });
});
