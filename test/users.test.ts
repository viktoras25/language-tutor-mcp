import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { extractToken, hashToken, resolveUser } from "../src/auth";
import { loadConfig } from "../src/config";
import { D1Store } from "../src/d1-store";
import { buildSyllabusImport, renderStatement, type CompiledSyllabus, type Statement } from "../src/syllabus-import";
import { buildAddUser, buildRevoke, buildRotateToken } from "../src/users";
import { newDb, runSql } from "./helpers";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const plan = JSON.parse(readFileSync(join(__dirname, "..", "build", "es.json"), "utf8")) as CompiledSyllabus;
const KEEP = ["subject-pronouns", "noun-gender-number", "articles", "ser-present", "ser-vs-estar"];

function miniPlan(): CompiledSyllabus {
  const topics = plan.topics.filter((t) => KEEP.includes(t.id)).map((t) => ({ ...t, requires: t.requires.filter((r) => KEEP.includes(r)) }));
  return { ...plan, topics, lexicon: [] };
}

let db: D1Database;
let dispose: () => Promise<void>;

async function run(statements: Statement[]): Promise<void> {
  await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
}

async function addUser(id: string): Promise<string> {
  const token = `token-of-${id}`;
  await run(buildAddUser(id, await hashToken(token), "2026-10-26T10:00:00.000Z"));
  return token;
}

const storeOf = (userId: string) => new D1Store(db, userId, "UTC", loadConfig({}).errorTypes);

async function count(sql: string, ...params: (string | number)[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return row!.n;
}

beforeAll(async () => {
  ({ db, dispose } = await newDb());
  await run(buildSyllabusImport(miniPlan(), "hash-1", "2026-10-26T10:00:00.000Z"));
  await addUser("anna");
  await addUser("boris");
});
afterAll(() => dispose());

describe("isolation between users", () => {
  it("keeps items, attempts and SRS state apart, even for the same item id", async () => {
    const anna = storeOf("anna");
    const boris = storeOf("boris");
    const idA = await anna.upsertItem("es", "lemma", "hablar", { gloss: "to speak" });
    const idB = await boris.upsertItem("es", "lemma", "hablar", { gloss: "mine" });
    expect(idA).toBe(idB);

    await anna.logAttempt({ itemId: idA, correct: false, errorType: "vocab" });
    await anna.logAttempt({ itemId: idA, correct: true });

    const ctxA = await anna.getContext(idA, 10);
    const ctxB = await boris.getContext(idB, 10);
    expect(ctxA!.item.data).toEqual({ gloss: "to speak" });
    expect(ctxA!.attempts.length).toBe(2);
    expect(ctxB!.item.data).toEqual({ gloss: "mine" });
    expect(ctxB!.attempts.length).toBe(0);
    expect(ctxB!.srs.status).toBe("new");

    expect((await anna.stats("es")).attempts).toBe(2);
    expect((await boris.stats("es")).attempts).toBe(0);
    expect((await boris.weakItems("es", 10)).length).toBe(0);
    expect((await anna.weakItems("es", 10)).length).toBe(1);
  });

  it("does not show another user's items in searches, due lists or neighbors", async () => {
    const anna = storeOf("anna");
    const boris = storeOf("boris");
    const secret = await anna.upsertItem("es", "lemma", "solo-anna");
    await anna.logAttempt({ itemId: secret, correct: false, errorType: "vocab", ts: "2026-10-20T10:00:00.000Z" });

    expect((await boris.findItems("es", "solo-anna", undefined, undefined, 10)).length).toBe(0);
    expect((await anna.findItems("es", "solo-anna", undefined, undefined, 10)).length).toBe(1);
    expect((await boris.dueItems("es", "2026-10-30", undefined, 50)).map((d) => d.id)).not.toContain(secret);
    expect((await anna.dueItems("es", "2026-10-30", undefined, 50)).map((d) => d.id)).toContain(secret);
    expect(await boris.getContext(secret, 10)).toBeNull();

    // Linking to an item that only the other user has is refused.
    const own = await boris.upsertItem("es", "lemma", "solo-boris");
    await expect(boris.link(own, secret, "collocates")).rejects.toThrow(/existing item ids/);
    await expect(boris.logAttempt({ itemId: secret, correct: true })).rejects.toThrow(/Unknown item_id/);
  });

  it("keeps sessions private: they cannot be read, ended, or used by another user", async () => {
    const anna = storeOf("anna");
    const boris = storeOf("boris");
    const sid = await anna.startSession("es", "Anna's lesson");
    const item = await boris.upsertItem("es", "lemma", "comer");

    expect(await boris.getSession(sid)).toBeNull();
    expect((await boris.listSessions("es", 50)).map((s) => s.id)).not.toContain(sid);
    expect((await anna.listSessions("es", 50)).map((s) => s.id)).toContain(sid);
    await expect(boris.endSession(sid)).rejects.toThrow(/Unknown session id/);
    await expect(boris.logAttempt({ itemId: item, correct: true, sessionId: sid })).rejects.toThrow(/Unknown session_id/);
    await expect(boris.setTopicStatus("es", "ser-present", "current", sid)).rejects.toThrow(/Unknown session_id/);
    await expect(boris.recordCheckpoint("es", plan.modules[0].id, true, sid)).rejects.toThrow(/Unknown session_id/);

    await anna.endSession(sid, "done");
    expect((await anna.getSession(sid))!.status).toBe("closed");
  });

  it("keeps course state, profile, topic progress and checkpoints per user", async () => {
    const anna = storeOf("anna");
    const boris = storeOf("boris");

    await anna.setCourseState("es", { level: "A2" });
    expect((await boris.getCourseState("es")).data).toBeNull();
    await boris.setCourseState("es", { level: "A1" });
    expect((await anna.getCourseState("es")).data).toEqual({ level: "A2" });

    await anna.setProfile({ ui_lang: "ru", known_langs: ["ru"] });
    expect((await boris.getProfile()).ui_lang).toBe("en");
    expect((await anna.getProfile()).ui_lang).toBe("ru");

    await anna.setTopicStatus("es", "ser-present", "introduced");
    const annaNext = await anna.nextTopics("es");
    const borisNext = await boris.nextTopics("es");
    expect(annaNext.current.concat(annaNext.continue, annaNext.fill).length).toBeGreaterThan(0);
    expect((await boris.getTopic("es", "ser-present")).status).toBe("planned");
    expect((await anna.getTopic("es", "ser-present")).status).toBe("introduced");
    expect(borisNext).not.toEqual(annaNext);

    await anna.recordCheckpoint("es", plan.topics.find((t) => t.id === "ser-present")!.module, true);
    const annaProgress = await anna.progress("es");
    const borisProgress = await boris.progress("es");
    expect(JSON.stringify(annaProgress)).not.toBe(JSON.stringify(borisProgress));
    expect(await count("SELECT COUNT(*) AS n FROM learner_checkpoints WHERE user_id = 'boris'")).toBe(0);
  });

  it("counts a topic's SRS evidence only from the user's own attempts", async () => {
    const anna = storeOf("anna");
    const boris = storeOf("boris");
    const part = await anna.upsertItem("es", "form", "soy");
    await anna.link(part, "es:grammar_point:ser-present", "part_of");
    await anna.logAttempt({ itemId: part, correct: false, errorType: "conjugation" });

    const mine = await anna.getTopic("es", "ser-present");
    const theirs = await boris.getTopic("es", "ser-present");
    expect(mine.items.map((i) => i.id)).toContain(part);
    expect(theirs.items.map((i) => i.id)).toEqual(["es:grammar_point:ser-present"]);
    expect(mine.mastered).toBe(false);
  });
});

describe("new users", () => {
  it("get their own topic items and prerequisite edges at once", async () => {
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE user_id = 'anna' AND type = 'grammar_point'")).toBe(KEEP.length);
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE user_id = 'boris' AND type = 'grammar_point'")).toBe(KEEP.length);
    const edges = await count("SELECT COUNT(*) AS n FROM edges WHERE user_id = 'anna' AND type = 'requires'");
    expect(edges).toBeGreaterThan(0);
    expect(await count("SELECT COUNT(*) AS n FROM edges WHERE user_id = 'boris' AND type = 'requires'")).toBe(edges);
  });

  it("are provisioned by a later plan import as well", async () => {
    const other = await newDb();
    try {
      const d = other.db;
      await d.prepare("INSERT INTO users (id, token_hash, created_at) VALUES ('late', 'x', 'now')").run();
      for (const s of buildSyllabusImport(miniPlan(), "hash-1", "2026-10-26T10:00:00.000Z")) await d.prepare(s.sql).bind(...s.params).run();
      const row = await d.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = 'late'").first<{ n: number }>();
      expect(row!.n).toBe(KEEP.length);
    } finally {
      await other.dispose();
    }
  });

  it("can be created from the rendered SQL file that wrangler runs", async () => {
    const other = await newDb();
    try {
      for (const s of buildSyllabusImport(miniPlan(), "hash-1", "2026-10-26T10:00:00.000Z")) await other.db.prepare(renderStatement(s)).run();
      for (const s of buildAddUser("dina", await hashToken("t"), "2026-10-26T10:00:00.000Z")) await other.db.prepare(renderStatement(s)).run();
      const row = await other.db.prepare("SELECT COUNT(*) AS n FROM items WHERE user_id = 'dina'").first<{ n: number }>();
      expect(row!.n).toBe(KEEP.length);
      expect(await resolveUser(other.db, undefined, "t")).toBe("dina");
    } finally {
      await other.dispose();
    }
  });

  it("reject invalid ids and duplicates", async () => {
    expect(() => buildAddUser("Bad Name", "h", "t")).toThrow(/Invalid user id/);
    expect(() => buildAddUser("../x", "h", "t")).toThrow(/Invalid user id/);
    await expect(addUser("anna")).rejects.toThrow();
  });
});

describe("tokens", () => {
  it("extracts the token from the path or the header", () => {
    expect(extractToken("/mcp/abc", null)).toBe("abc");
    expect(extractToken("/mcp", "Bearer xyz")).toBe("xyz");
    expect(extractToken("/mcp", null)).toBe("");
    expect(extractToken("/mcp", "Basic xyz")).toBe("");
    expect(extractToken("/mcp/%E0%A4%A", null)).toBe("");
    expect(extractToken("/other", "Bearer xyz")).toBeNull();
  });

  it("maps tokens to users and rejects everything else", async () => {
    expect(await resolveUser(db, "owner-secret", "owner-secret")).toBe("owner");
    expect(await resolveUser(db, "owner-secret", "token-of-anna")).toBe("anna");
    expect(await resolveUser(db, "owner-secret", "token-of-boris")).toBe("boris");
    expect(await resolveUser(db, "owner-secret", "nope")).toBeNull();
    expect(await resolveUser(db, "owner-secret", "")).toBeNull();
    // Without MCP_SECRET the owner cannot sign in, and an empty secret never matches an empty token.
    expect(await resolveUser(db, undefined, "owner-secret")).toBeNull();
    expect(await resolveUser(db, "", "")).toBeNull();
  });

  it("does not store the token itself", async () => {
    const row = await db.prepare("SELECT token_hash FROM users WHERE id = 'anna'").first<{ token_hash: string }>();
    expect(row!.token_hash).toBe(await hashToken("token-of-anna"));
    expect(row!.token_hash).not.toContain("token-of-anna");
  });

  it("can be rotated and revoked", async () => {
    await addUser("carla");
    expect(await resolveUser(db, undefined, "token-of-carla")).toBe("carla");

    await run(buildRotateToken("carla", await hashToken("new-token")));
    expect(await resolveUser(db, undefined, "token-of-carla")).toBeNull();
    expect(await resolveUser(db, undefined, "new-token")).toBe("carla");

    await storeOf("carla").upsertItem("es", "lemma", "beber");
    await run(buildRevoke("carla"));
    expect(await resolveUser(db, undefined, "new-token")).toBeNull();
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE user_id = 'carla' AND label = 'beber'")).toBe(1);
  });
});

describe("migration 0005", () => {
  it("moves the existing data to the user owner and keeps ids", async () => {
    const old = await newDb("0004_syllabus.sql");
    try {
      const d = old.db;
      const exec = async (sql: string) => void (await d.prepare(sql).run());
      await exec("INSERT INTO items (id,lang,type,label,data_json) VALUES ('es:lemma:a','es','lemma','a','{\"x\":1}'), ('es:lemma:b','es','lemma','b',NULL)");
      await exec("INSERT INTO edges (src,dst,type) VALUES ('es:lemma:a','es:lemma:b','collocates')");
      await exec("INSERT INTO sessions (id,lang,title,started_at) VALUES ('s_1','es','t','2026-10-20T10:00:00.000Z')");
      await exec("INSERT INTO attempts (item_id,ts,correct,session_id) VALUES ('es:lemma:a','2026-10-20T10:01:00.000Z',1,'s_1'), ('es:lemma:a','2026-10-20T10:02:00.000Z',0,'s_1')");
      await exec("INSERT INTO item_srs (item_id,status,interval_days,due_at,streak,streak_days) VALUES ('es:lemma:a','learning',1,'2026-10-21T10:02:00.000Z',0,0)");
      await exec("INSERT INTO course_state (lang,data_json,updated_at) VALUES ('es','{\"level\":\"A1\"}','2026-10-20T10:00:00.000Z')");
      await exec("INSERT INTO learner_profile (id,ui_lang,known_langs_json,variety,packs_json) VALUES (1,'ru','[\"ru\"]','es-ES','[\"core\"]')");
      await exec("INSERT INTO learner_topics (lang,topic_id,status,changed_at) VALUES ('es','ser-present','introduced','2026-10-20T10:00:00.000Z')");
      await exec("INSERT INTO learner_checkpoints (lang,module_id,passed,ts) VALUES ('es','m1',1,'2026-10-20T10:00:00.000Z')");

      await runSql(d, "0005_users.sql");

      const owner = new D1Store(d, "owner", "UTC");
      const ctx = await owner.getContext("es:lemma:a", 10);
      expect(ctx!.item.data).toEqual({ x: 1 });
      expect(ctx!.attempts.map((a) => a.id)).toEqual([2, 1]);
      expect(ctx!.srs.status).toBe("learning");
      expect(ctx!.outgoing.length).toBe(1);
      expect((await owner.getSession("s_1"))!.attempts.length).toBe(2);
      expect((await owner.getCourseState("es")).data).toEqual({ level: "A1" });
      expect((await owner.getProfile()).ui_lang).toBe("ru");
      expect((await owner.getTopic("es", "ser-present").catch(() => null))).toBeNull(); // no syllabus imported, but no crash on the join

      const other = new D1Store(d, "someone", "UTC");
      expect(await other.getContext("es:lemma:a", 10)).toBeNull();
      expect((await other.getProfile()).ui_lang).toBe("en");

      const leftovers = await d.prepare("SELECT COUNT(*) AS n FROM attempts WHERE user_id <> 'owner'").first<{ n: number }>();
      expect(leftovers!.n).toBe(0);
      const users = await d.prepare("SELECT id, token_hash FROM users").all<{ id: string; token_hash: string | null }>();
      expect(users.results).toEqual([{ id: "owner", token_hash: null }]);

      // New attempts continue after the old ids.
      await owner.logAttempt({ itemId: "es:lemma:b", correct: true });
      const last = await d.prepare("SELECT MAX(id) AS id FROM attempts").first<{ id: number }>();
      expect(last!.id).toBe(3);
    } finally {
      await old.dispose();
    }
  });
});
