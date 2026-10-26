-- Stage 1 of the syllabus: the (immutable) plan, one learner's progress through it, and the `part_of` edge type.
-- Not re-runnable on its own (the edges table is rebuilt); the wrangler migrations ledger applies it once.

-- SQLite cannot alter a CHECK constraint, so rebuild edges with the extra type. Existing rows are copied as they are.
CREATE TABLE edges_new (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('form_of','requires','contrasts_with','collocates','part_of')),
  PRIMARY KEY (src, dst, type)
);
INSERT INTO edges_new (src, dst, type) SELECT src, dst, type FROM edges;
DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);

-- ---------- The plan (written only by the import script, never by tools) ----------
-- Texts are plain English strings: the model translates them for the learner (learner_profile.ui_lang).

CREATE TABLE syllabus_meta (
  lang TEXT PRIMARY KEY,
  version_json TEXT NOT NULL,
  variety TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  imported_at TEXT NOT NULL
);

-- Modules and can-do statements are shared by all languages.
CREATE TABLE syllabus_modules (
  id TEXT PRIMARY KEY,
  level TEXT NOT NULL,
  ord INTEGER NOT NULL,
  title TEXT NOT NULL,
  domains_json TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE syllabus_can_do (
  id TEXT PRIMARY KEY,
  module_id TEXT NOT NULL,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX idx_syllabus_can_do_module ON syllabus_can_do(module_id);

-- A topic's server item is <lang>:grammar_point:<id>. ord = position in the source files (deterministic tie-break).
CREATE TABLE syllabus_topics (
  lang TEXT NOT NULL,
  id TEXT NOT NULL,
  module_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('grammar','chunk','orthography')),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  examples_json TEXT NOT NULL,
  traps_json TEXT NOT NULL,
  transfer_json TEXT,
  error_tags_json TEXT NOT NULL,
  variety_note TEXT,
  ord INTEGER NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0,
  replaced_by TEXT,
  PRIMARY KEY (lang, id)
);
CREATE INDEX idx_syllabus_topics_module ON syllabus_topics(lang, module_id);

-- Source of truth for prerequisites. The same pairs are mirrored as `requires` edges between items.
CREATE TABLE syllabus_requires (
  lang TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  requires_id TEXT NOT NULL,
  PRIMARY KEY (lang, topic_id, requires_id)
);

-- scope is "core" or a language code.
CREATE TABLE syllabus_errors (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  text TEXT NOT NULL,
  legacy INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, id)
);

CREATE TABLE syllabus_lexicon (
  lang TEXT NOT NULL,
  id TEXT NOT NULL,
  lemma TEXT NOT NULL,
  pos TEXT NOT NULL,
  gender TEXT,
  gloss TEXT NOT NULL,
  module_id TEXT NOT NULL,
  pack TEXT NOT NULL,
  deprecated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lang, id)
);

-- ---------- One learner (stage 1) ----------

CREATE TABLE learner_profile (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  ui_lang TEXT NOT NULL,
  known_langs_json TEXT NOT NULL,
  variety TEXT,
  packs_json TEXT NOT NULL
);

-- No row = planned. `planned` is stored only after an explicit move back.
CREATE TABLE learner_topics (
  lang TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','seen_via_error','current','introduced','assumed')),
  changed_at TEXT NOT NULL,
  lesson INTEGER,
  source TEXT,
  note TEXT,
  PRIMARY KEY (lang, topic_id)
);

CREATE TABLE learner_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lang TEXT NOT NULL,
  module_id TEXT NOT NULL,
  session_id TEXT,
  passed INTEGER NOT NULL,
  notes TEXT,
  ts TEXT NOT NULL
);
CREATE INDEX idx_learner_checkpoints_module ON learner_checkpoints(lang, module_id, ts);
