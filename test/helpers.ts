import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Miniflare } from "miniflare";

const MIGRATIONS = join(__dirname, "..", "migrations");

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
}

// D1 exec() is line-based, so run migration files statement by statement.
export async function runSql(db: D1Database, file: string): Promise<void> {
  const sql = readFileSync(join(MIGRATIONS, file), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await db.prepare(stmt).run();
  }
}

export async function newDb(upTo?: string): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  if (process.env.TEST_DB === "sqlite") return newSqliteDb(upTo);
  const mf = new Miniflare({ workers: [{
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    d1Databases: { DB: "test-db" },
  }],
  });
  const db = (await mf.getD1Database("DB")) as unknown as D1Database;
  for (const f of migrationFiles()) {
    if (upTo !== undefined && f > upTo) break;
    await runSql(db, f);
  }
  return { db, dispose: () => mf.dispose() };
}

// Same schema on a local SQLite file (in memory), through the adapter used by the stdio entry point.
export async function newSqliteDb(upTo?: string): Promise<{ db: D1Database; dispose: () => Promise<void> }> {
  const { SqliteD1 } = await import("../src/sqlite-d1");
  const { migrate } = await import("../src/migrate");
  const lite = new SqliteD1(":memory:");
  if (upTo === undefined) {
    migrate(lite, MIGRATIONS);
  } else {
    lite.exec("PRAGMA foreign_keys = OFF");
    for (const f of migrationFiles()) {
      if (f > upTo) break;
      lite.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    }
    lite.exec("PRAGMA foreign_keys = ON");
  }
  return { db: lite.asD1(), dispose: async () => lite.close() };
}
