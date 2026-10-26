import { D1Syllabus } from "./d1-syllabus";
import type { TopicStatus } from "./planner";
import { computeSrs, EMPTY_SRS, type SrsState, type SrsStatus } from "./srs";
import { addDays, daysBetween, normalizeTs } from "./time";
import type {
  CheckpointResult,
  NextTopicsView,
  PlanSummary,
  Profile,
  ProfilePatch,
  ProgressView,
  SyllabusView,
  TopicCard,
  TopicStatusChange,
} from "./syllabus-store";
import type {
  Attempt,
  AttemptInput,
  CourseState,
  DueItem,
  Edge,
  EdgeType,
  FoundItem,
  Item,
  ItemContext,
  ItemType,
  Lang,
  Session,
  SessionDetail,
  Stats,
  Store,
  WeakItem,
} from "./store";

interface ItemRow {
  id: string;
  lang: string;
  type: ItemType;
  label: string;
  data_json: string | null;
  created_at: string;
}

interface AttemptRow {
  id: number;
  item_id: string;
  ts: string;
  correct: number;
  error_type: string | null;
  context: string | null;
  session_id: string | null;
}

interface SessionRow {
  id: string;
  lang: string;
  kind: string;
  title: string;
  plan: string | null;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  score: number | null;
  next_step: string | null;
  attempts_count: number;
}

function toItem(row: ItemRow): Item {
  return {
    id: row.id,
    lang: row.lang,
    type: row.type,
    label: row.label,
    data: row.data_json === null ? null : JSON.parse(row.data_json),
    created_at: row.created_at,
  };
}

function toAttempt(row: AttemptRow): Attempt {
  return { ...row, correct: row.correct === 1 };
}

function toSession(row: SessionRow): Session {
  return { ...row, status: row.ended_at === null ? "open" : "closed" };
}

// Escapes LIKE wildcards so user text is matched literally (used with ESCAPE '\').
function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export class D1Store implements Store {
  private syllabus: D1Syllabus;

  // userId = the signed-in user; every query below is limited to that user's rows.
  // errorTypes = error categories from the config. When given, log_attempt accepts those plus the categories of the
  // imported syllabus (core + the item's language). When omitted, error types are not checked here.
  constructor(
    private db: D1Database,
    private userId: string,
    private timezone: string,
    private errorTypes?: string[],
  ) {
    this.syllabus = new D1Syllabus(db, userId);
  }

  async upsertItem(
    lang: Lang,
    type: ItemType,
    label: string,
    data?: Record<string, unknown>,
    replace = false,
  ): Promise<string> {
    // Deterministic id makes upsert idempotent: same lang+type+label -> same item.
    const id = `${lang}:${type}:${label.trim().toLowerCase()}`;
    const dataJson = data === undefined ? null : JSON.stringify(data);
    // No data -> keep existing. replace -> overwrite. Otherwise JSON merge patch (null value deletes a key).
    await this.db
      .prepare(
        `INSERT INTO items (user_id, id, lang, type, label, data_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(user_id, id) DO UPDATE SET data_json = CASE
           WHEN excluded.data_json IS NULL THEN items.data_json
           WHEN ?7 = 1 THEN excluded.data_json
           ELSE json_patch(COALESCE(items.data_json, '{}'), excluded.data_json)
         END`,
      )
      .bind(this.userId, id, lang, type, label.trim(), dataJson, replace ? 1 : 0)
      .run();
    return id;
  }

  async link(src: string, dst: string, type: EdgeType): Promise<void> {
    const found = await this.db
      .prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = ?1 AND id IN (?2, ?3)")
      .bind(this.userId, src, dst)
      .first<{ n: number }>();
    const expected = src === dst ? 1 : 2;
    if (!found || found.n !== expected) {
      throw new Error("src and dst must both be existing item ids");
    }
    await this.db
      .prepare("INSERT OR IGNORE INTO edges (user_id, src, dst, type) VALUES (?1, ?2, ?3, ?4)")
      .bind(this.userId, src, dst, type)
      .run();
  }

  async logAttempt(input: AttemptInput): Promise<SrsState> {
    const item = await this.db
      .prepare("SELECT lang FROM items WHERE user_id = ?1 AND id = ?2")
      .bind(this.userId, input.itemId)
      .first<{ lang: string }>();
    if (!item) throw new Error(`Unknown item_id: ${input.itemId}`);
    if (input.errorType !== undefined && this.errorTypes !== undefined) {
      const allowed = [...this.errorTypes];
      for (const id of await this.syllabus.syllabusErrorTypes(item.lang)) {
        if (!allowed.includes(id)) allowed.push(id);
      }
      if (!allowed.includes(input.errorType)) {
        throw new Error(`error_type "${input.errorType}" is not valid for "${item.lang}". Valid: ${allowed.join(", ")}`);
      }
    }
    if (input.sessionId !== undefined) {
      const session = await this.db
        .prepare("SELECT 1 AS x FROM sessions WHERE user_id = ?1 AND id = ?2")
        .bind(this.userId, input.sessionId)
        .first();
      if (!session) throw new Error(`Unknown session_id: ${input.sessionId}`);
    }
    const ts = input.ts === undefined ? new Date().toISOString() : normalizeTs(input.ts);
    await this.db
      .prepare(
        "INSERT INTO attempts (user_id, item_id, ts, correct, error_type, context, session_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(
        this.userId,
        input.itemId,
        ts,
        input.correct ? 1 : 0,
        input.errorType ?? null,
        input.context ?? null,
        input.sessionId ?? null,
      )
      .run();
    return this.recomputeSrs(input.itemId);
  }

  // Replays the item's full history, so back-dated imports end up with the right state.
  private async recomputeSrs(itemId: string): Promise<SrsState> {
    const res = await this.db
      .prepare("SELECT ts, correct FROM attempts WHERE user_id = ?1 AND item_id = ?2 ORDER BY ts, id")
      .bind(this.userId, itemId)
      .all<{ ts: string; correct: number }>();
    const srs = computeSrs(
      res.results.map((r) => ({ ts: r.ts, correct: r.correct === 1 })),
      this.timezone,
    );
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO item_srs (user_id, item_id, status, interval_days, due_at, streak, streak_days)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(this.userId, itemId, srs.status, srs.interval_days, srs.due_at, srs.streak, srs.streak_days)
      .run();
    return srs;
  }

  async getContext(itemId: string, attemptsLimit: number): Promise<ItemContext | null> {
    const row = await this.db
      .prepare("SELECT * FROM items WHERE user_id = ?1 AND id = ?2")
      .bind(this.userId, itemId)
      .first<ItemRow>();
    if (!row) return null;

    // Bounded: edges capped at 50 per direction, neighbors derived from those, attempts capped by the caller.
    const [outRes, inRes, attRes, srsRes] = await this.db.batch([
      this.db.prepare("SELECT src, dst, type FROM edges WHERE user_id = ?1 AND src = ?2 LIMIT 50").bind(this.userId, itemId),
      this.db.prepare("SELECT src, dst, type FROM edges WHERE user_id = ?1 AND dst = ?2 LIMIT 50").bind(this.userId, itemId),
      this.db
        .prepare(
          `SELECT id, item_id, ts, correct, error_type, context, session_id FROM attempts
           WHERE user_id = ?1 AND item_id = ?2 ORDER BY ts DESC, id DESC LIMIT ?3`,
        )
        .bind(this.userId, itemId, attemptsLimit),
      this.db
        .prepare(
          "SELECT status, interval_days, due_at, streak, streak_days FROM item_srs WHERE user_id = ?1 AND item_id = ?2",
        )
        .bind(this.userId, itemId),
    ]);
    const outgoing = outRes.results as unknown as Edge[];
    const incoming = inRes.results as unknown as Edge[];
    const attemptRows = attRes.results as unknown as AttemptRow[];
    const srs = (srsRes.results[0] as unknown as SrsState | undefined) ?? { ...EMPTY_SRS };

    const neighborIds = [...new Set([...outgoing.map((e) => e.dst), ...incoming.map((e) => e.src)])].filter(
      (id) => id !== itemId,
    );
    let neighbors: Item[] = [];
    if (neighborIds.length > 0) {
      const marks = neighborIds.map((_, i) => `?${i + 2}`).join(",");
      const res = await this.db
        .prepare(`SELECT * FROM items WHERE user_id = ?1 AND id IN (${marks})`)
        .bind(this.userId, ...neighborIds)
        .all<ItemRow>();
      neighbors = res.results.map(toItem);
    }

    return { item: toItem(row), srs, outgoing, incoming, neighbors, attempts: attemptRows.map(toAttempt) };
  }

  async startSession(lang: Lang, title: string, plan?: string, kind = "lesson"): Promise<string> {
    const id = `s_${crypto.randomUUID().slice(0, 8)}`;
    await this.db
      .prepare(
        "INSERT INTO sessions (user_id, id, lang, kind, title, plan, started_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(this.userId, id, lang, kind, title, plan ?? null, new Date().toISOString())
      .run();
    return id;
  }

  async endSession(id: string, summary?: string, score?: number, nextStep?: string): Promise<void> {
    const row = await this.db
      .prepare("SELECT ended_at FROM sessions WHERE user_id = ?1 AND id = ?2")
      .bind(this.userId, id)
      .first<{ ended_at: string | null }>();
    if (!row) throw new Error(`Unknown session id: ${id}`);
    if (row.ended_at !== null) throw new Error(`Session ${id} is already closed (${row.ended_at})`);
    await this.db
      .prepare("UPDATE sessions SET ended_at = ?3, summary = ?4, score = ?5, next_step = ?6 WHERE user_id = ?1 AND id = ?2")
      .bind(this.userId, id, new Date().toISOString(), summary ?? null, score ?? null, nextStep ?? null)
      .run();
  }

  async listSessions(lang: Lang, limit: number): Promise<Session[]> {
    const res = await this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM attempts a WHERE a.user_id = s.user_id AND a.session_id = s.id) AS attempts_count
         FROM sessions s WHERE s.user_id = ?1 AND s.lang = ?2 ORDER BY s.started_at DESC LIMIT ?3`,
      )
      .bind(this.userId, lang, limit)
      .all<SessionRow>();
    return res.results.map(toSession);
  }

  async getSession(id: string): Promise<SessionDetail | null> {
    const row = await this.db
      .prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM attempts a WHERE a.user_id = s.user_id AND a.session_id = s.id) AS attempts_count
         FROM sessions s WHERE s.user_id = ?1 AND s.id = ?2`,
      )
      .bind(this.userId, id)
      .first<SessionRow>();
    if (!row) return null;
    const res = await this.db
      .prepare(
        `SELECT a.id, a.item_id, a.ts, a.correct, a.error_type, a.context, a.session_id, i.label
         FROM attempts a LEFT JOIN items i ON i.user_id = a.user_id AND i.id = a.item_id
         WHERE a.user_id = ?1 AND a.session_id = ?2 ORDER BY a.ts, a.id LIMIT 500`,
      )
      .bind(this.userId, id)
      .all<AttemptRow & { label: string | null }>();
    return { ...toSession(row), attempts: res.results.map((r) => ({ ...toAttempt(r), label: r.label })) };
  }

  async dueItems(lang: Lang, date: string, type: ItemType | undefined, limit: number): Promise<DueItem[]> {
    const cutoff = `${date}T23:59:59.999Z`;
    const recentFrom = addDays(`${date}T00:00:00.000Z`, -3);
    const res = await this.db
      .prepare(
        `SELECT i.id, i.label, i.type, s.status, s.interval_days, s.due_at, s.streak,
           (SELECT COUNT(*) FROM attempts a
            WHERE a.user_id = i.user_id AND a.item_id = i.id AND a.correct = 0 AND a.ts >= ?4) AS recent_errors
         FROM item_srs s JOIN items i ON i.user_id = s.user_id AND i.id = s.item_id
         WHERE s.user_id = ?1 AND i.lang = ?2 AND s.due_at <= ?3 AND (?5 IS NULL OR i.type = ?5)
         ORDER BY (recent_errors > 0) DESC, s.due_at ASC LIMIT ?6`,
      )
      .bind(this.userId, lang, cutoff, recentFrom, type ?? null, limit)
      .all<Omit<DueItem, "overdue_days">>();
    return res.results.map((r) => ({
      ...r,
      overdue_days: Math.max(0, daysBetween(r.due_at.slice(0, 10), date)),
    }));
  }

  async findItems(
    lang: Lang,
    query: string | undefined,
    type: ItemType | undefined,
    status: SrsStatus | undefined,
    limit: number,
  ): Promise<FoundItem[]> {
    const pattern = query === undefined || query === "" ? null : likePattern(query);
    const res = await this.db
      .prepare(
        `SELECT i.id, i.label, i.type, i.data_json, COALESCE(s.status, 'new') AS status
         FROM items i LEFT JOIN item_srs s ON s.user_id = i.user_id AND s.item_id = i.id
         WHERE i.user_id = ?1 AND i.lang = ?2
           AND (?3 IS NULL OR i.label LIKE ?3 ESCAPE '\\' OR i.data_json LIKE ?3 ESCAPE '\\')
           AND (?4 IS NULL OR i.type = ?4)
           AND (?5 IS NULL OR COALESCE(s.status, 'new') = ?5)
         ORDER BY i.label LIMIT ?6`,
      )
      .bind(this.userId, lang, pattern, type ?? null, status ?? null, limit)
      .all<{ id: string; label: string; type: ItemType; data_json: string | null; status: SrsStatus }>();
    return res.results.map((r) => ({
      id: r.id,
      label: r.label,
      type: r.type,
      status: r.status,
      data: r.data_json === null ? null : JSON.parse(r.data_json),
    }));
  }

  async weakItems(lang: Lang, limit: number): Promise<WeakItem[]> {
    const since = addDays(new Date().toISOString(), -14);
    const res = await this.db
      .prepare(
        `SELECT i.id, i.label, i.type, COUNT(*) AS attempts, SUM(a.correct = 0) AS wrong
         FROM attempts a JOIN items i ON i.user_id = a.user_id AND i.id = a.item_id
         WHERE a.user_id = ?1 AND i.lang = ?2 AND a.ts >= ?3
         GROUP BY i.id HAVING wrong > 0
         ORDER BY 1.0 * wrong / attempts DESC, wrong DESC, attempts DESC LIMIT ?4`,
      )
      .bind(this.userId, lang, since, limit)
      .all<Omit<WeakItem, "error_rate">>();
    return res.results.map((r) => ({ ...r, error_rate: Math.round((r.wrong / r.attempts) * 100) / 100 }));
  }

  async stats(lang: Lang, since?: string): Promise<Stats> {
    const sinceTs = since === undefined ? null : normalizeTs(since);
    const [totalRes, errRes, statusRes] = await this.db.batch([
      this.db
        .prepare(
          `SELECT COUNT(*) AS attempts, COALESCE(SUM(a.correct), 0) AS correct
           FROM attempts a JOIN items i ON i.user_id = a.user_id AND i.id = a.item_id
           WHERE a.user_id = ?1 AND i.lang = ?2 AND (?3 IS NULL OR a.ts >= ?3)`,
        )
        .bind(this.userId, lang, sinceTs),
      this.db
        .prepare(
          `SELECT COALESCE(a.error_type, 'unspecified') AS error_type, COUNT(*) AS n
           FROM attempts a JOIN items i ON i.user_id = a.user_id AND i.id = a.item_id
           WHERE a.user_id = ?1 AND i.lang = ?2 AND a.correct = 0 AND (?3 IS NULL OR a.ts >= ?3)
           GROUP BY 1 ORDER BY n DESC`,
        )
        .bind(this.userId, lang, sinceTs),
      this.db
        .prepare(
          `SELECT COALESCE(s.status, 'new') AS status, COUNT(*) AS n
           FROM items i LEFT JOIN item_srs s ON s.user_id = i.user_id AND s.item_id = i.id
           WHERE i.user_id = ?1 AND i.lang = ?2 GROUP BY 1`,
        )
        .bind(this.userId, lang),
    ]);
    const total = totalRes.results[0] as unknown as { attempts: number; correct: number };
    const errors: Record<string, number> = {};
    for (const r of errRes.results as unknown as { error_type: string; n: number }[]) errors[r.error_type] = r.n;
    const byStatus: Record<SrsStatus, number> = { new: 0, learning: 0, known: 0 };
    for (const r of statusRes.results as unknown as { status: SrsStatus; n: number }[]) byStatus[r.status] = r.n;
    return {
      lang,
      since: sinceTs,
      attempts: total.attempts,
      correct: total.correct,
      correct_pct: total.attempts === 0 ? null : Math.round((total.correct / total.attempts) * 1000) / 10,
      errors_by_type: errors,
      items_by_status: byStatus,
    };
  }

  async getCourseState(lang: Lang): Promise<CourseState> {
    const row = await this.db
      .prepare("SELECT data_json, updated_at FROM course_state WHERE user_id = ?1 AND lang = ?2")
      .bind(this.userId, lang)
      .first<{ data_json: string; updated_at: string }>();
    return row
      ? { lang, data: JSON.parse(row.data_json), updated_at: row.updated_at }
      : { lang, data: null, updated_at: null };
  }

  async setCourseState(lang: Lang, data: Record<string, unknown>): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO course_state (user_id, lang, data_json, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(user_id, lang) DO UPDATE SET data_json = excluded.data_json, updated_at = excluded.updated_at`,
      )
      .bind(this.userId, lang, JSON.stringify(data), new Date().toISOString())
      .run();
  }

  // ---------- Syllabus: implemented in d1-syllabus.ts ----------

  getProfile(): Promise<Profile> {
    return this.syllabus.getProfile();
  }

  setProfile(patch: ProfilePatch): Promise<Profile> {
    return this.syllabus.setProfile(patch);
  }

  getSyllabus(lang: Lang, level?: string, moduleId?: string): Promise<SyllabusView> {
    return this.syllabus.getSyllabus(lang, level, moduleId);
  }

  getTopic(lang: Lang, topicId: string): Promise<TopicCard> {
    return this.syllabus.getTopic(lang, topicId);
  }

  nextTopics(lang: Lang): Promise<NextTopicsView> {
    return this.syllabus.nextTopics(lang);
  }

  setTopicStatus(
    lang: Lang,
    topicId: string,
    status: TopicStatus,
    sessionId?: string,
    allowRegress?: boolean,
  ): Promise<TopicStatusChange> {
    return this.syllabus.setTopicStatus(lang, topicId, status, sessionId, allowRegress);
  }

  progress(lang: Lang, level?: string): Promise<ProgressView> {
    return this.syllabus.progress(lang, level);
  }

  recordCheckpoint(
    lang: Lang,
    moduleId: string,
    passed: boolean,
    sessionId?: string,
    notes?: string,
  ): Promise<CheckpointResult> {
    return this.syllabus.recordCheckpoint(lang, moduleId, passed, sessionId, notes);
  }

  planSummary(lang: Lang): Promise<PlanSummary | null> {
    return this.syllabus.planSummary(lang);
  }

  syllabusErrorTypes(lang: Lang): Promise<string[]> {
    return this.syllabus.syllabusErrorTypes(lang);
  }
}
