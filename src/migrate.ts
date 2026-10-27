import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SqliteD1 } from "./sqlite-d1";

// Applies the files in migrations/ that this database has not seen yet, in name order.
// Returns the names it applied.
export function migrate(db: SqliteD1, dir: string): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set((db.raw.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map((r) => r.name));
  // A database restored from a `wrangler d1 export` dump carries wrangler's own ledger; honour it.
  const ledger = db.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'd1_migrations'").get();
  if (ledger !== undefined) for (const r of db.raw.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]) done.add(r.name);
  const applied: string[] = [];
  db.exec("PRAGMA foreign_keys = OFF"); // migrations rebuild tables; the pragma is a no-op inside a transaction
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    db.exec("BEGIN");
    try {
      db.exec(readFileSync(join(dir, name), "utf8"));
      db.raw.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?1, ?2)").run(name, new Date().toISOString());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${name} failed: ${(e as Error).message}`);
    }
    applied.push(name);
  }
  db.exec("PRAGMA foreign_keys = ON");
  return applied;
}
