// Turns a compiled syllabus (build/<lang>.json from tools/validate.py) and a learner seed into SQL statements.
// No imports and no database access: the same statements are run in tests and written to a .sql file for
// `wrangler d1 execute`. Every statement is an upsert, so running an import twice leaves the data unchanged.

export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params: SqlValue[];
}

export interface CompiledModule {
  id: string;
  level: string;
  order: number;
  title: string;
  domains: string[];
  can_do: { id: string; text: string }[];
  checkpoint: { text: string };
  deprecated?: boolean;
}

export interface CompiledTopic {
  id: string;
  module: string;
  kind: string;
  requires: string[];
  title: string;
  summary: string;
  examples: string[];
  traps: string[];
  transfer?: Record<string, string>; // keyed by the language the hint is for
  variety_note?: string;
  error_tags: string[];
  deprecated?: boolean;
  replaced_by?: string;
}

export interface CompiledSyllabus {
  lang: string;
  variety: string;
  modules: CompiledModule[];
  topics: CompiledTopic[];
  versions: { modules: number; topics: number; errors: number };
  error_defs: { scope: string; id: string; text: string; legacy?: boolean }[];
  lexicon: {
    id: string;
    lemma: string;
    pos: string;
    gender?: string;
    gloss: string;
    module: string;
    pack: string;
    deprecated?: boolean;
  }[];
}

export interface LearnerSeed {
  lang: string;
  learner: string;
  profile: { ui_lang: string; known_langs: string[]; variety?: string; packs: string[] };
  topics: Record<string, { status: string; date?: string; lesson?: number; source?: string; note?: string }>;
  part_of: Record<string, string>; // existing item id -> topic id
  discrepancies?: string[];
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function flag(value: boolean | undefined): number {
  return value === true ? 1 : 0;
}

function topicItemId(lang: string, topicId: string): string {
  return `${lang}:grammar_point:${topicId}`;
}

// Plan import. contentHash identifies the compiled file; importedAt only changes when the content did.
export function buildSyllabusImport(plan: CompiledSyllabus, contentHash: string, importedAt: string): Statement[] {
  const lang = plan.lang;
  const out: Statement[] = [];

  out.push({
    sql: `INSERT INTO syllabus_meta (lang, version_json, variety, content_hash, imported_at) VALUES (?1, ?2, ?3, ?4, ?5)
          ON CONFLICT(lang) DO UPDATE SET version_json = excluded.version_json, variety = excluded.variety,
            imported_at = CASE WHEN syllabus_meta.content_hash = excluded.content_hash
                               THEN syllabus_meta.imported_at ELSE excluded.imported_at END,
            content_hash = excluded.content_hash`,
    params: [lang, json(plan.versions), plan.variety, contentHash, importedAt],
  });

  for (const m of plan.modules) {
    out.push({
      sql: `INSERT INTO syllabus_modules (id, level, ord, title, domains_json, checkpoint, deprecated)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(id) DO UPDATE SET level = excluded.level, ord = excluded.ord, title = excluded.title,
              domains_json = excluded.domains_json, checkpoint = excluded.checkpoint,
              deprecated = excluded.deprecated`,
      params: [m.id, m.level, m.order, m.title, json(m.domains), m.checkpoint.text, flag(m.deprecated)],
    });
    let position = 0;
    for (const c of m.can_do) {
      out.push({
        sql: `INSERT INTO syllabus_can_do (id, module_id, ord, text) VALUES (?1, ?2, ?3, ?4)
              ON CONFLICT(id) DO UPDATE SET module_id = excluded.module_id, ord = excluded.ord,
                text = excluded.text`,
        params: [c.id, m.id, position, c.text],
      });
      position += 1;
    }
  }

  // Prerequisites are replaced as a whole, so a change in the plan cannot leave a stale pair behind.
  out.push({ sql: "DELETE FROM syllabus_requires WHERE lang = ?1", params: [lang] });
  let order = 0;
  for (const t of plan.topics) {
    out.push({
      sql: `INSERT INTO syllabus_topics (lang, id, module_id, kind, title, summary, examples_json, traps_json,
              transfer_json, error_tags_json, variety_note, ord, deprecated, replaced_by)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            ON CONFLICT(lang, id) DO UPDATE SET module_id = excluded.module_id, kind = excluded.kind,
              title = excluded.title, summary = excluded.summary,
              examples_json = excluded.examples_json, traps_json = excluded.traps_json,
              transfer_json = excluded.transfer_json, error_tags_json = excluded.error_tags_json,
              variety_note = excluded.variety_note, ord = excluded.ord, deprecated = excluded.deprecated,
              replaced_by = excluded.replaced_by`,
      params: [
        lang,
        t.id,
        t.module,
        t.kind,
        t.title,
        t.summary,
        json(t.examples),
        json(t.traps),
        t.transfer === undefined ? null : json(t.transfer),
        json(t.error_tags),
        t.variety_note ?? null,
        order,
        flag(t.deprecated),
        t.replaced_by ?? null,
      ],
    });
    order += 1;
    for (const r of t.requires) {
      out.push({
        sql: "INSERT INTO syllabus_requires (lang, topic_id, requires_id) VALUES (?1, ?2, ?3)",
        params: [lang, t.id, r],
      });
    }
  }

  for (const e of plan.error_defs) {
    out.push({
      sql: `INSERT INTO syllabus_errors (scope, id, text, legacy) VALUES (?1, ?2, ?3, ?4)
            ON CONFLICT(scope, id) DO UPDATE SET text = excluded.text, legacy = excluded.legacy`,
      params: [e.scope, e.id, e.text, flag(e.legacy)],
    });
  }

  for (const w of plan.lexicon) {
    out.push({
      sql: `INSERT INTO syllabus_lexicon (lang, id, lemma, pos, gender, gloss, module_id, pack, deprecated)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            ON CONFLICT(lang, id) DO UPDATE SET lemma = excluded.lemma, pos = excluded.pos, gender = excluded.gender,
              gloss = excluded.gloss, module_id = excluded.module_id, pack = excluded.pack,
              deprecated = excluded.deprecated`,
      params: [lang, w.id, w.lemma, w.pos, w.gender ?? null, w.gloss, w.module, w.pack, flag(w.deprecated)],
    });
  }

  // Every topic is an item (grammar_point, label = topic id). Existing items keep their data and attempts:
  // the two syllabus fields are merged into data with a JSON merge patch, nothing else is touched.
  for (const t of plan.topics) {
    out.push({
      sql: `INSERT INTO items (id, lang, type, label, data_json) VALUES (?1, ?2, 'grammar_point', ?3, ?4)
            ON CONFLICT(id) DO UPDATE SET data_json = json_patch(COALESCE(items.data_json, '{}'), excluded.data_json)`,
      params: [topicItemId(lang, t.id), lang, t.id, json({ syllabus_module: t.module, syllabus_kind: t.kind })],
    });
  }
  // Mirror of syllabus_requires between items, so get_context shows prerequisites as neighbors.
  // Direction as elsewhere: src requires dst.
  for (const t of plan.topics) {
    for (const r of t.requires) {
      out.push({
        sql: "INSERT OR IGNORE INTO edges (src, dst, type) VALUES (?1, ?2, 'requires')",
        params: [topicItemId(lang, t.id), topicItemId(lang, r)],
      });
    }
  }
  return out;
}

// "2026-10-15" -> "2026-10-15T00:00:00.000Z"
function seedTimestamp(date: string | undefined, fallback: string): string {
  if (date === undefined) return fallback;
  return date.length === 10 ? `${date}T00:00:00.000Z` : date;
}

// Seed import. Meant to run once: it never overwrites a profile or a topic status that already exists,
// so running it again after real lessons cannot undo progress.
export function buildSeedImport(seed: LearnerSeed, importedAt: string): Statement[] {
  const out: Statement[] = [];
  out.push({
    sql: `INSERT INTO learner_profile (id, ui_lang, known_langs_json, variety, packs_json) VALUES (1, ?1, ?2, ?3, ?4)
          ON CONFLICT(id) DO NOTHING`,
    params: [seed.profile.ui_lang, json(seed.profile.known_langs), seed.profile.variety ?? null, json(seed.profile.packs)],
  });
  for (const topicId of Object.keys(seed.topics)) {
    const t = seed.topics[topicId];
    out.push({
      sql: `INSERT INTO learner_topics (lang, topic_id, status, changed_at, lesson, source, note)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(lang, topic_id) DO NOTHING`,
      params: [seed.lang, topicId, t.status, seedTimestamp(t.date, importedAt), t.lesson ?? null, t.source ?? "seed", t.note ?? null],
    });
  }
  // item --part_of--> topic. Skipped for an item that does not exist, so nothing dangling is created.
  for (const itemId of Object.keys(seed.part_of)) {
    out.push({
      sql: `INSERT OR IGNORE INTO edges (src, dst, type)
            SELECT ?1, ?2, 'part_of' WHERE EXISTS (SELECT 1 FROM items WHERE id = ?1)`,
      params: [itemId, topicItemId(seed.lang, seed.part_of[itemId])],
    });
  }
  return out;
}

function literal(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return String(value);
  return `'${value.replace(/'/g, "''")}'`;
}

// Puts the parameters into the statement text (?1, ?2 ... -> literals). One pass over the SQL, so a literal
// that happens to contain "?2" is never replaced a second time.
export function renderStatement(statement: Statement): string {
  const compact = statement.sql.replace(/\s+/g, " ").trim();
  const filled = compact.replace(/\?(\d+)/g, (_match: string, n: string) => literal(statement.params[Number(n) - 1]));
  return filled + ";";
}

export function renderSql(statements: Statement[]): string {
  const lines: string[] = [];
  for (const s of statements) lines.push(renderStatement(s));
  return lines.join("\n") + "\n";
}
