import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../src/config";
import { D1Store } from "../src/d1-store";
import {
  buildSeedImport,
  buildSyllabusImport,
  renderStatement,
  type CompiledSyllabus,
  type LearnerSeed,
  type Statement,
} from "../src/syllabus-import";
import { newDb } from "./helpers";

// build/ is produced by `npm run syllabus:validate` and committed.
const BUILD = join(__dirname, "..", "build");
const plan = JSON.parse(readFileSync(join(BUILD, "es.json"), "utf8")) as CompiledSyllabus;
const seed = JSON.parse(readFileSync(join(BUILD, "seed-es-example.json"), "utf8")) as LearnerSeed;

// Importing the full plan takes a few seconds in the test runtime, so most tests use a small slice of it.
// Only the "full plan" tests below use all 95 topics (and share one database, because they only read).
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const KEEP = [
  "subject-pronouns",
  "noun-gender-number",
  "articles",
  "ser-present",
  "ser-vs-estar",
  "present-regular",
  "numbers-0-29",
  "connectors-basic",
  "reflexive-verbs",
  "preterite-indefinido-ar",
  "preterite-er-ir",
  "usted-formal",
];

function miniPlan(): CompiledSyllabus {
  const topics = plan.topics.filter((t) => KEEP.includes(t.id)).map((t) => ({ ...t, requires: t.requires.filter((r) => KEEP.includes(r)) }));
  return { ...plan, topics, lexicon: [] };
}

let db: D1Database;
let dispose: () => Promise<void>;
let store: D1Store;

async function freshDb(): Promise<void> {
  ({ db, dispose } = await newDb());
  store = new D1Store(db, "owner", "UTC", loadConfig({}).errorTypes);
}

async function run(statements: Statement[]): Promise<void> {
  const prepared: D1PreparedStatement[] = [];
  for (const s of statements) prepared.push(db.prepare(s.sql).bind(...s.params));
  await db.batch(prepared);
}

const importPlan = (at = "2026-10-26T10:00:00.000Z") => run(buildSyllabusImport(miniPlan(), "hash-1", at));
const importFullPlan = () => run(buildSyllabusImport(plan, "hash-1", "2026-10-26T10:00:00.000Z"));
const importSeed = () => run(buildSeedImport(seed, "2026-10-26T10:00:00.000Z", "owner"));

const TABLES = [
  "items",
  "edges",
  "syllabus_meta",
  "syllabus_modules",
  "syllabus_can_do",
  "syllabus_topics",
  "syllabus_requires",
  "syllabus_errors",
  "syllabus_lexicon",
  "learner_profile",
  "learner_topics",
];

async function dump(database: D1Database): Promise<string> {
  const parts: string[] = [];
  for (const t of TABLES) {
    // created_at is set by the database clock, so it is left out of the comparison.
    const columns = t === "items" ? "id, lang, type, label, data_json" : "*";
    const res = await database.prepare(`SELECT ${columns} FROM ${t} ORDER BY 1, 2, 3`).all();
    parts.push(`${t}: ${JSON.stringify(res.results)}`);
  }
  return parts.join("\n");
}

async function count(sql: string, ...params: (string | number)[]): Promise<number> {
  const row = await db.prepare(sql).bind(...params).first<{ n: number }>();
  return row!.n;
}

describe("import", () => {
  beforeEach(freshDb);
  afterEach(() => dispose());

  it("creates the topics as items and keeps data and attempts of items that already exist", async () => {
    const legacy = await store.upsertItem("es", "grammar_point", "ser-vs-estar", { rule: "keep me", first_seen: "2026-10-15" });
    await store.logAttempt({ itemId: legacy, correct: true });
    await store.logAttempt({ itemId: legacy, correct: false, errorType: "vocab" });

    await importPlan();

    expect(await count("SELECT COUNT(*) AS n FROM syllabus_topics WHERE lang = 'es'")).toBe(KEEP.length);
    expect(await count("SELECT COUNT(*) AS n FROM items WHERE lang = 'es' AND type = 'grammar_point'")).toBe(KEEP.length);
    const ctx = await store.getContext(legacy, 10);
    expect(ctx!.item.data).toMatchObject({ rule: "keep me", first_seen: "2026-10-15", syllabus_kind: "grammar" });
    expect(ctx!.attempts.length).toBe(2);
    // The mirrored prerequisite edges show up as neighbors.
    expect(ctx!.outgoing.map((e) => e.type)).toContain("requires");
  });

  it("is idempotent, and imported_at only moves when the content changes", async () => {
    await importPlan("2026-10-26T10:00:00.000Z");
    await importSeed();
    const first = await dump(db);
    await importPlan("2026-10-27T10:00:00.000Z");
    await importSeed();
    expect(await dump(db)).toBe(first);

    await run(buildSyllabusImport(miniPlan(), "hash-2", "2026-10-28T10:00:00.000Z"));
    const meta = await db.prepare("SELECT imported_at, content_hash FROM syllabus_meta").first<{ imported_at: string; content_hash: string }>();
    expect(meta).toEqual({ imported_at: "2026-10-28T10:00:00.000Z", content_hash: "hash-2" });
  });

  it("rendered SQL gives the same result as bound parameters", async () => {
    await importPlan();
    await importSeed();
    const expected = await dump(db);

    const other = await newDb();
    try {
      const all = [...buildSyllabusImport(miniPlan(), "hash-1", "2026-10-26T10:00:00.000Z"), ...buildSeedImport(seed, "2026-10-26T10:00:00.000Z", "owner")];
      for (const s of all) await other.db.prepare(renderStatement(s)).run();
      expect(await dump(other.db)).toBe(expected);
    } finally {
      await other.dispose();
    }
  });

  it("renders quotes and question marks inside values safely", () => {
    const sql = renderStatement({ sql: "INSERT INTO t VALUES (?1, ?2, ?10)", params: ["it's ?2", 5, null, null, null, null, null, null, null, "x"] });
    expect(sql).toBe("INSERT INTO t VALUES ('it''s ?2', 5, 'x');");
  });
});

describe("seed", () => {
  beforeEach(freshDb);
  afterEach(() => dispose());

  it("links the five existing items to their topics with part_of and skips missing ones", async () => {
    for (const id of Object.keys(seed.part_of)) {
      const label = id.split(":")[2];
      await store.upsertItem("es", "grammar_point", label);
    }
    await importPlan();
    await importSeed();
    expect(await count("SELECT COUNT(*) AS n FROM edges WHERE type = 'part_of'")).toBe(5);
    const ctx = await store.getContext("es:grammar_point:present-regular", 5);
    expect(ctx!.incoming.filter((e) => e.type === "part_of").map((e) => e.src).sort()).toEqual([
      "es:grammar_point:person-endings",
      "es:grammar_point:present-yo-ending",
    ]);
  });

  it("never overwrites progress made after the first import", async () => {
    await importPlan();
    await importSeed();
    await store.setTopicStatus("es", "preterite-indefinido-ar", "introduced");
    await store.setProfile({ ui_lang: "de" });
    await importSeed();
    expect((await store.getTopic("es", "preterite-indefinido-ar")).status).toBe("introduced");
    expect((await store.getProfile()).ui_lang).toBe("de");
  });
});

// All tests in this block only read, so one database is imported once and shared.
describe("full plan on the seed", () => {
  beforeAll(async () => {
    await freshDb();
    await importFullPlan();
    await importSeed();
  });
  afterAll(() => dispose());

  it("next_topics gives the expected topics", async () => {
    const next = await store.nextTopics("es");
    expect(next.current.map((t) => t.id)).toEqual(["preterite-indefinido-ar"]);
    expect(next.continue.map((t) => t.id)).toEqual(["preterite-er-ir", "preterite-ser-ir"]);
    expect(next.fill.map((t) => t.id)).toEqual(["usted-formal", "gender-agreement", "estar-location"]);
    expect(next.blocked).toBe(27);
    expect(next.continue[0].title).toBe("Preterite: regular -er/-ir verbs"); // texts are English
  });

  it("progress gives the expected coverage per level", async () => {
    const p = await store.progress("es");
    expect(p.levels.map((l) => [l.level, l.covered, l.total])).toEqual([["A1", 30, 59], ["A2", 2, 36]]);
    expect(p.levels.every((l) => l.mastered === 0)).toBe(true); // nothing is practised yet
    const a1 = await store.progress("es", "A1");
    expect(a1.modules.length).toBe(10);
  });

  it("get_course_state summary comes from planSummary", async () => {
    const s = await store.planSummary("es");
    expect(s).toMatchObject({ level: "A1", coverage: { covered: 30, total: 59 } });
    expect(s!.next.fill.length).toBe(3);
    expect(await store.planSummary("de")).toBeNull();
    await expect(store.nextTopics("de")).rejects.toThrow(/No syllabus/);
  });

  it("get_syllabus is compact and can be narrowed", async () => {
    const all = await store.getSyllabus("es");
    expect(all.modules.length).toBe(20);
    const one = await store.getSyllabus("es", undefined, "A1.03");
    expect(one.modules.length).toBe(1);
    expect(one.modules[0]).toMatchObject({ module_id: "A1.03", covered: 10, total: 10 });
    expect(one.modules[0].can_do.length).toBeGreaterThan(0);
    expect(one.modules[0].topics[0]).toEqual({ id: expect.any(String), title: expect.any(String), kind: expect.any(String), status: expect.any(String) });
    await expect(store.getSyllabus("es", undefined, "A9.99")).rejects.toThrow(/No module/);
  });
});

// These tests change data, so each one gets a fresh database with the small plan.
describe("topic cards and mastery", () => {
  beforeEach(async () => {
    await freshDb();
    await importPlan();
    await importSeed();
  });
  afterEach(() => dispose());

  it("a topic is mastered only when all its items are known and have no recent mistakes", async () => {
    // reflexive-verbs has its own item plus levantarse-vs-acostarse linked with part_of.
    const own = "es:grammar_point:reflexive-verbs";
    const part = await store.upsertItem("es", "grammar_point", "levantarse-vs-acostarse");
    await store.link(part, own, "part_of");
    const day = 86400000;
    const known = async (id: string) => {
      for (const ago of [5, 4, 3]) await store.logAttempt({ itemId: id, correct: true, ts: new Date(Date.now() - ago * day).toISOString() });
    };
    const mastered = async () => (await store.getTopic("es", "reflexive-verbs")).mastered;

    await known(own);
    expect(await mastered()).toBe(false); // the part_of item is still new
    await known(part);
    expect(await mastered()).toBe(true);
    await store.logAttempt({ itemId: part, correct: false, errorType: "other" });
    expect(await mastered()).toBe(false); // a fresh mistake
    const p = await store.progress("es", "A1");
    expect(p.levels[0].mastered).toBe(0);
  });

  it("get_topic shows transfer hints only for known languages", async () => {
    const card = await store.getTopic("es", "noun-gender-number");
    expect(Object.keys(card.transfer).sort()).toEqual(["de", "ru"]);
    expect(card.title).toBe("Noun gender and plural");
    expect(card.requires).toEqual([]);

    await store.setProfile({ known_langs: ["ru"] });
    const onlyRu = await store.getTopic("es", "noun-gender-number");
    expect(Object.keys(onlyRu.transfer)).toEqual(["ru"]);

    const withPrereq = await store.getTopic("es", "articles");
    expect(withPrereq.requires).toEqual([{ id: "noun-gender-number", title: "Noun gender and plural", status: "assumed" }]);
  });
});

describe("set_topic_status", () => {
  beforeEach(async () => {
    await freshDb();
    await importPlan();
    await importSeed();
  });
  afterEach(() => dispose());

  it("moves forward freely, reports unmet prerequisites, and refuses to go back without allow_regress", async () => {
    const r = await store.setTopicStatus("es", "preterite-er-ir", "current");
    expect(r).toEqual({ topic_id: "preterite-er-ir", previous: "planned", status: "current", unmet_requires: [] });

    // Prerequisites that are not covered are reported, and the change is made anyway.
    await store.setTopicStatus("es", "preterite-indefinido-ar", "planned", undefined, true);
    const early = await store.setTopicStatus("es", "preterite-er-ir", "current");
    expect(early.unmet_requires).toEqual(["preterite-indefinido-ar"]);
    expect((await store.getTopic("es", "preterite-er-ir")).status).toBe("current");

    await store.setTopicStatus("es", "preterite-er-ir", "introduced");
    await expect(store.setTopicStatus("es", "preterite-er-ir", "current")).rejects.toThrow(/allow_regress/);
    await expect(store.setTopicStatus("es", "preterite-er-ir", "planned")).rejects.toThrow(/allow_regress/);
    const back = await store.setTopicStatus("es", "preterite-er-ir", "planned", undefined, true);
    expect(back).toMatchObject({ previous: "introduced", status: "planned" });
  });

  it("rejects unknown topics and unknown sessions, and records the session as the source", async () => {
    await expect(store.setTopicStatus("es", "no-such-topic", "current")).rejects.toThrow(/Unknown topic_id/);
    await expect(store.setTopicStatus("es", "usted-formal", "current", "s_nope")).rejects.toThrow(/Unknown session_id/);
    const sid = (await store.saveSession({ lang: "es", title: "Lesson 14" })).id;
    await store.setTopicStatus("es", "usted-formal", "current", sid);
    const row = await db.prepare("SELECT source FROM learner_topics WHERE topic_id = 'usted-formal'").first<{ source: string }>();
    expect(row!.source).toBe(`session:${sid}`);
  });

  it("allows assumed only inside a placement session", async () => {
    await expect(store.setTopicStatus("es", "usted-formal", "assumed")).rejects.toThrow(/placement/);
    const lesson = (await store.saveSession({ lang: "es", title: "Lesson 14" })).id;
    await expect(store.setTopicStatus("es", "usted-formal", "assumed", lesson)).rejects.toThrow(/placement/);
    const placement = (await store.saveSession({ lang: "es", title: "Placement test", kind: "placement" })).id;
    const r = await store.setTopicStatus("es", "usted-formal", "assumed", placement);
    expect(r.status).toBe("assumed");
    const row = await db.prepare("SELECT source FROM learner_topics WHERE topic_id = 'usted-formal'").first<{ source: string }>();
    expect(row!.source).toBe(`session:${placement}`);
  });
});

describe("checkpoints", () => {
  beforeEach(freshDb);
  afterEach(() => dispose());

  it("records a result and reports the module's progress", async () => {
    await importPlan();
    await importSeed();
    const sid = (await store.saveSession({ lang: "es", title: "Check A1.03" })).id;
    const r = await store.recordCheckpoint("es", "A1.03", true, sid, "all good");
    expect(r.module).toMatchObject({ module_id: "A1.03", covered: 1, total: 1, checkpoint: { passed: true } });
    // everything in it is covered but nothing is mastered yet, so the module stays open
    expect(r.module.closed).toBe(false);
    await expect(store.recordCheckpoint("es", "A9.99", true)).rejects.toThrow(/Unknown module_id/);
    await expect(store.recordCheckpoint("es", "A1.03", true, "s_nope")).rejects.toThrow(/Unknown session_id/);
  });
});

describe("error types per language", () => {
  beforeEach(async () => {
    await freshDb();
    await importPlan();
  });
  afterEach(() => dispose());

  it("accepts accent for es, rejects por-para for de, still accepts old values", async () => {
    const es = await store.upsertItem("es", "lemma", "mañana");
    const de = await store.upsertItem("de", "lemma", "Tisch");
    await store.logAttempt({ itemId: es, correct: false, errorType: "accent" });
    await store.logAttempt({ itemId: es, correct: false, errorType: "por-para" });
    await store.logAttempt({ itemId: es, correct: false, errorType: "ser-estar" });
    await store.logAttempt({ itemId: de, correct: false, errorType: "accent" });
    await store.logAttempt({ itemId: de, correct: false, errorType: "gender" });
    await expect(store.logAttempt({ itemId: de, correct: false, errorType: "por-para" })).rejects.toThrow(/not valid for "de"/);
    await expect(store.logAttempt({ itemId: es, correct: false, errorType: "made-up" })).rejects.toThrow(/Valid:/);
  });

  it("does not check error types when none are configured", async () => {
    const open = new D1Store(db, "owner", "UTC");
    const id = await open.upsertItem("es", "lemma", "hablar");
    await expect(open.logAttempt({ itemId: id, correct: false, errorType: "anything" })).resolves.toBeDefined();
  });
});

describe("profile", () => {
  beforeEach(freshDb);
  afterEach(() => dispose());

  it("has defaults and changes only the fields given", async () => {
    expect(await store.getProfile()).toEqual({ ui_lang: "en", known_langs: [], variety: null, packs: ["core"] });
    await store.setProfile({ ui_lang: "ru", known_langs: ["ru", "de"], variety: "es-ES" });
    await store.setProfile({ packs: ["core", "running"] });
    await store.setProfile({ variety: null });
    expect(await store.getProfile()).toEqual({ ui_lang: "ru", known_langs: ["ru", "de"], variety: null, packs: ["core", "running"] });
  });
});
