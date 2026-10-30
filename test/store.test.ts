import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { D1Store } from "../src/d1-store";
import { newDb, runSql } from "./helpers";

let db: D1Database;
let dispose: () => Promise<void>;
let store: D1Store;

beforeEach(async () => {
  ({ db, dispose } = await newDb());
  store = new D1Store(db, "owner", "UTC");
});
afterEach(() => dispose());

const lemma = (label: string) => store.upsertItem("es", "lemma", label);

describe("logAttempt + SRS", () => {
  it("updates srs and stores a custom ts; back-dated imports replay in order", async () => {
    const id = await lemma("hablar");
    // Imported out of order: the later attempt first.
    await store.logAttempt({ itemId: id, correct: true, ts: "2026-10-03T12:00:00Z" });
    const srs = await store.logAttempt({ itemId: id, correct: true, ts: "2026-10-01T12:00:00Z" });
    expect(srs).toMatchObject({ streak: 2, interval_days: 3 });
    const ctx = await store.getContext(id, 5);
    expect(ctx!.attempts.map((a) => a.ts)).toEqual(["2026-10-03T12:00:00.000Z", "2026-10-01T12:00:00.000Z"]);
    expect(ctx!.srs.due_at).toBe("2026-10-06T12:00:00.000Z");
  });

  it("rejects a bad ts and unknown ids", async () => {
    const id = await lemma("hablar");
    await expect(store.logAttempt({ itemId: id, correct: true, ts: "yesterday-ish" })).rejects.toThrow(/ISO 8601/);
    await expect(store.logAttempt({ itemId: "nope", correct: true })).rejects.toThrow(/Unknown item_id/);
    await expect(store.logAttempt({ itemId: id, correct: true, sessionId: "s_nope" })).rejects.toThrow(/Unknown session_id/);
  });
});

describe("dueItems", () => {
  it("returns only due items, recent errors first, then oldest due", async () => {
    const a = await lemma("a-old-ok");
    const b = await lemma("b-recent-error");
    const c = await lemma("c-older-ok");
    const d = await lemma("d-due-today");
    const e = await lemma("e-not-due");
    await store.logAttempt({ itemId: a, correct: true, ts: "2026-10-01T12:00:00Z" }); // due 10-02
    await store.logAttempt({ itemId: b, correct: false, ts: "2026-10-14T12:00:00Z" }); // due 10-15, error 1 day ago
    await store.logAttempt({ itemId: c, correct: true, ts: "2026-10-05T12:00:00Z" }); // due 10-06
    await store.logAttempt({ itemId: d, correct: true, ts: "2026-10-14T12:00:00Z" }); // due 10-15
    await store.logAttempt({ itemId: e, correct: true, ts: "2026-10-15T12:00:00Z" }); // due 10-16
    const due = await store.dueItems("es", "2026-10-15", undefined, 20);
    expect(due.map((x) => x.label)).toEqual(["b-recent-error", "a-old-ok", "c-older-ok", "d-due-today"]);
    expect(due[1].overdue_days).toBe(13);
    expect((await store.dueItems("es", "2026-10-15", undefined, 2)).length).toBe(2);
    expect(await store.dueItems("de", "2026-10-15", undefined, 20)).toEqual([]);
  });
});

describe("sessions", () => {
  it("creates on first save, then adds and overwrites only the given fields", async () => {
    const id = await lemma("hablar");
    const s1 = await store.saveSession({ lang: "es", title: "Lesson 1", plan: "ser/estar" });
    expect(s1.lang).toBe("es");
    await store.logAttempts([{ itemId: id, correct: false, errorType: "conjugation", sessionId: s1.id }]);
    await store.saveSession({ id: s1.id, summary: "went ok", score: 80, nextStep: "do lesson 2" });
    await store.saveSession({ id: s1.id, score: 90 }); // a corrected grade

    const [s] = await store.listSessions("es", 5);
    expect(s).toMatchObject({ id: s1.id, title: "Lesson 1", plan: "ser/estar", summary: "went ok", score: 90, next_step: "do lesson 2", attempts_count: 1 });
    expect(s.updated_at >= s.started_at).toBe(true);

    const detail = await store.getSession(s1.id);
    expect(detail!.attempts).toHaveLength(1);
    expect(detail!.attempts[0]).toMatchObject({ label: "hablar", error_type: "conjugation", correct: false });
    expect(await store.getSession("s_nope")).toBeNull();
  });

  it("rejects a new session without lang or title, an unknown id and a different lang", async () => {
    await expect(store.saveSession({ lang: "es" })).rejects.toThrow(/needs lang and title/);
    await expect(store.saveSession({ id: "s_nope", summary: "x" })).rejects.toThrow(/Unknown session id/);
    const { id } = await store.saveSession({ lang: "es", title: "t" });
    await expect(store.saveSession({ id, lang: "de" })).rejects.toThrow(/is for "es"/);
  });

  it("shows sessions from before save_session with updated_at = started_at", async () => {
    await db
      .prepare("INSERT INTO sessions (user_id, id, lang, kind, title, started_at) VALUES ('owner', 's_old', 'es', 'lesson', 'old', '2026-10-01T10:00:00.000Z')")
      .run();
    expect((await store.listSessions("es", 5))[0]).toMatchObject({ id: "s_old", updated_at: "2026-10-01T10:00:00.000Z" });
  });

  it("lists newest first and respects limit", async () => {
    await store.saveSession({ lang: "es", title: "first" });
    await new Promise((r) => setTimeout(r, 5));
    await store.saveSession({ lang: "es", title: "second" });
    expect((await store.listSessions("es", 1)).map((s) => s.title)).toEqual(["second"]);
  });
});

describe("logAttempts", () => {
  it("writes all attempts and recomputes each item once", async () => {
    const a = await lemma("a");
    const b = await lemma("b");
    const srs = await store.logAttempts([
      { itemId: a, correct: true, ts: "2026-10-01T12:00:00Z" },
      { itemId: a, correct: true, ts: "2026-10-03T12:00:00Z" },
      { itemId: b, correct: false, errorType: "vocab" },
    ]);
    expect(Object.keys(srs).sort()).toEqual([a, b]);
    expect(srs[a]).toMatchObject({ streak: 2, interval_days: 3 });
    expect(srs[b]).toMatchObject({ streak: 0, status: "learning" });
    expect(await store.logAttempts([])).toEqual({});
  });

  it("writes nothing when one attempt is invalid", async () => {
    const a = await lemma("a");
    const strict = new D1Store(db, "owner", "UTC", ["vocab", "other"]);
    await expect(strict.logAttempts([{ itemId: a, correct: true }, { itemId: "nope", correct: true }])).rejects.toThrow(/Unknown item_id: nope/);
    await expect(strict.logAttempts([{ itemId: a, correct: true }, { itemId: a, correct: false, errorType: "made-up" }])).rejects.toThrow(/not valid/);
    await expect(strict.logAttempts([{ itemId: a, correct: true }, { itemId: a, correct: true, ts: "soon" }])).rejects.toThrow(/ISO 8601/);
    await expect(strict.logAttempts([{ itemId: a, correct: true, sessionId: "s_nope" }])).rejects.toThrow(/Unknown session_id/);
    expect((await store.getContext(a, 50))!.attempts).toEqual([]);
  });
});

describe("upsertItem", () => {
  it("merges data by default, null deletes a key, replace overwrites", async () => {
    const id = await store.upsertItem("es", "lemma", "hablar", { pos: "verb", gloss: "to speak" });
    await store.upsertItem("es", "lemma", "hablar", { gloss: "to talk", note: "regular -ar" });
    expect((await store.getContext(id, 0))!.item.data).toEqual({ pos: "verb", gloss: "to talk", note: "regular -ar" });
    await store.upsertItem("es", "lemma", "hablar", { note: null });
    expect((await store.getContext(id, 0))!.item.data).toEqual({ pos: "verb", gloss: "to talk" });
    await store.upsertItem("es", "lemma", "hablar", { only: 1 }, true);
    expect((await store.getContext(id, 0))!.item.data).toEqual({ only: 1 });
    await store.upsertItem("es", "lemma", "hablar"); // no data -> untouched
    expect((await store.getContext(id, 0))!.item.data).toEqual({ only: 1 });
  });
});

describe("find / weak / stats / course state", () => {
  it("finds by label or data, escapes wildcards, filters by status", async () => {
    const h = await store.upsertItem("es", "lemma", "hablar", { gloss: "to speak" });
    await store.upsertItem("es", "lemma", "100%", { gloss: "percent" });
    await store.logAttempt({ itemId: h, correct: true });
    expect((await store.findItems("es", "speak", undefined, undefined, 20)).map((i) => i.label)).toEqual(["hablar"]);
    expect((await store.findItems("es", "%", undefined, undefined, 20)).map((i) => i.label)).toEqual(["100%"]);
    expect((await store.findItems("es", undefined, undefined, "new", 20)).map((i) => i.label)).toEqual(["100%"]);
    expect((await store.findItems("es", undefined, undefined, "learning", 20)).map((i) => i.label)).toEqual(["hablar"]);
  });

  it("weak_items ranks by error share in the last 14 days; stats breaks down errors", async () => {
    const a = await lemma("a");
    const b = await lemma("b");
    await lemma("c");
    await store.logAttempt({ itemId: a, correct: false, errorType: "vocab" });
    await store.logAttempt({ itemId: a, correct: false, errorType: "spelling" });
    await store.logAttempt({ itemId: b, correct: false, errorType: "vocab" });
    await store.logAttempt({ itemId: b, correct: true });
    await store.logAttempt({ itemId: b, correct: true, ts: "2020-01-01T00:00:00Z" }); // too old for weak_items
    const weak = await store.weakItems("es", 10);
    expect(weak.map((w) => [w.label, w.error_rate])).toEqual([["a", 1], ["b", 0.5]]);

    const st = await store.stats("es");
    expect(st).toMatchObject({ attempts: 5, correct: 2, correct_pct: 40, errors_by_type: { vocab: 2, spelling: 1 } });
    expect(st.items_by_status).toEqual({ new: 1, learning: 2, known: 0 });
    expect((await store.stats("es", "2025-01-01")).attempts).toBe(4);
  });

  it("course state round-trips and defaults to null", async () => {
    expect(await store.getCourseState("es")).toEqual({ lang: "es", data: null, updated_at: null });
    await store.setCourseState("es", { level: "A1", lessons_done: "1,2" });
    expect((await store.getCourseState("es")).data).toEqual({ level: "A1", lessons_done: "1,2" });
  });
});

describe("migrations", () => {
  it("normalizes legacy ts and is safe to re-run", async () => {
    await dispose();
    ({ db, dispose } = await newDb("0001_init.sql")); // old schema only
    await db.prepare("INSERT INTO items (id,lang,type,label,data_json) VALUES ('es:lemma:x','es','lemma','x',NULL)").run();
    await db.prepare("INSERT INTO attempts (item_id, ts, correct) VALUES ('es:lemma:x','2026-10-25 11:01:16',1)").run();

    for (const f of ["0002_srs_sessions.sql", "0003_attempt_session.sql"]) await runSql(db, f);
    await runSql(db, "0002_srs_sessions.sql"); // re-running the idempotent file must not fail or change anything

    const ts = await db.prepare("SELECT ts FROM attempts").first<{ ts: string }>();
    expect(ts!.ts).toBe("2026-10-25T11:01:16.000Z");
  });
});
