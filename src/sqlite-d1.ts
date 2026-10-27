import { DatabaseSync, type SQLInputValue } from "node:sqlite";

// A small adapter that gives a local SQLite file the part of the D1 API the stores use
// (prepare / bind / first / all / run / batch). D1Store and D1Syllabus then run unchanged on a local file.
// SQL is the same dialect, so there is no second implementation of the queries to keep in step.

interface RunMeta {
  changes: number;
  last_row_id: number;
}

function toParam(v: unknown): SQLInputValue {
  if (v === undefined) throw new Error("bind: undefined is not allowed (use null)");
  if (typeof v === "boolean") return v ? 1 : 0;
  return v as SQLInputValue;
}

class SqliteStatement {
  constructor(
    private db: DatabaseSync,
    readonly sql: string,
    private params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): SqliteStatement {
    return new SqliteStatement(this.db, this.sql, values.map(toParam));
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    return (column === undefined ? row : row[column]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: RunMeta }> {
    const results = this.db.prepare(this.sql).all(...this.params) as T[];
    return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
  }

  async run(): Promise<{ results: never[]; success: true; meta: RunMeta }> {
    const r = this.db.prepare(this.sql).run(...this.params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
}

export class SqliteD1 {
  readonly raw: DatabaseSync;

  constructor(path: string) {
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  }

  prepare(sql: string): SqliteStatement {
    return new SqliteStatement(this.raw, sql);
  }

  // Like D1: all statements in one transaction, one result per statement.
  async batch(statements: SqliteStatement[]): Promise<Awaited<ReturnType<SqliteStatement["all"]>>[]> {
    this.raw.exec("BEGIN");
    try {
      const out = [];
      for (const s of statements) out.push(await s.all());
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }

  exec(sql: string): void {
    this.raw.exec(sql);
  }

  close(): void {
    this.raw.close();
  }

  asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
