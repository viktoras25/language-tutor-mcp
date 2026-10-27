// Local entry point: the same tools over stdio, backed by a SQLite file. One person, no tokens.
//
//   LANGUAGE_MEMORY_DB   path of the database file (default ~/.language-memory/memory.db)
//   LANGUAGE_MEMORY_USER user id inside the database (default "owner")
//   LANGS, ERROR_TYPES, TIMEZONE   same as the Worker settings
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "./config";
import { D1Store } from "./d1-store";
import { migrate } from "./migrate";
import { SqliteD1 } from "./sqlite-d1";
import { createServer } from "./tools";

const dbPath = process.env.LANGUAGE_MEMORY_DB ?? join(homedir(), ".language-memory", "memory.db");
const userId = process.env.LANGUAGE_MEMORY_USER ?? "owner";
const migrations = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

mkdirSync(dirname(dbPath), { recursive: true });
const db = new SqliteD1(dbPath);
const applied = migrate(db, migrations);
if (applied.length > 0) console.error(`language-memory: applied ${applied.length} migration(s) to ${dbPath}`);
// Learners are rows in `users`; the local user must exist.
db.raw.prepare("INSERT OR IGNORE INTO users (id, token_hash, created_at) VALUES (?1, NULL, ?2)").run(userId, new Date().toISOString());

const config = loadConfig(process.env as Record<string, string | undefined>);
const store = new D1Store(db.asD1(), userId, config.timezone, config.errorTypes);
serveStdio(() => createServer(store, config));
