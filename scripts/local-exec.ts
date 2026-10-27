// Runs a SQL file against the local database: node scripts/local-exec.ts <file.sql> [db path]
// Use it for the output of `npm run syllabus:import` or for a dump made with `wrangler d1 export`.
import { readFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "../src/migrate.ts";
import { SqliteD1 } from "../src/sqlite-d1.ts";

const [file, pathArg] = process.argv.slice(2).filter((a) => a !== "--raw");
if (file === undefined) {
  console.error("usage: node scripts/local-exec.ts <file.sql> [db path]");
  process.exit(1);
}
const dbPath = pathArg ?? process.env.LANGUAGE_MEMORY_DB ?? join(homedir(), ".language-memory", "memory.db");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new SqliteD1(dbPath);
const raw = process.argv.includes("--raw");
if (!raw) migrate(db, join(dirname(fileURLToPath(import.meta.url)), "..", "migrations"));
db.exec("BEGIN");
try {
  db.exec(readFileSync(file, "utf8"));
  db.exec("COMMIT");
} catch (e) {
  db.exec("ROLLBACK");
  throw e;
}
console.log(`ok: ${file} -> ${dbPath}`);
