-- Multi-user. Every learner table gets user_id as the leading key column. The syllabus_* tables stay shared.
-- Existing data becomes the data of the user "owner", who signs in with the MCP_SECRET worker secret.
-- Not re-runnable on its own (tables are rebuilt); the wrangler migrations ledger applies it once.
-- SQLite cannot add a column to a primary key, so each learner table is rebuilt and its rows are copied.

-- token_hash = SHA-256 (hex) of the user's token. NULL = no token, the user cannot sign in (the owner uses MCP_SECRET).
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE,
  created_at TEXT NOT NULL
);
INSERT INTO users (id, token_hash, created_at) VALUES ('owner', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

CREATE TABLE items_new (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  lang TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('lemma','form','grammar_point','collocation')),
  label TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, id)
);
INSERT INTO items_new (user_id, id, lang, type, label, data_json, created_at)
  SELECT 'owner', id, lang, type, label, data_json, created_at FROM items;
DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX idx_items_lang_type ON items(user_id, lang, type);

CREATE TABLE edges_new (
  user_id TEXT NOT NULL,
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('form_of','requires','contrasts_with','collocates','part_of')),
  PRIMARY KEY (user_id, src, dst, type)
);
INSERT INTO edges_new (user_id, src, dst, type) SELECT 'owner', src, dst, type FROM edges;
DROP TABLE edges;
ALTER TABLE edges_new RENAME TO edges;
CREATE INDEX idx_edges_dst ON edges(user_id, dst);

CREATE TABLE attempts_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  correct INTEGER NOT NULL,
  error_type TEXT,
  context TEXT,
  session_id TEXT
);
INSERT INTO attempts_new (id, user_id, item_id, ts, correct, error_type, context, session_id)
  SELECT id, 'owner', item_id, ts, correct, error_type, context, session_id FROM attempts;
DROP TABLE attempts;
ALTER TABLE attempts_new RENAME TO attempts;
CREATE INDEX idx_attempts_item_ts ON attempts(user_id, item_id, ts);
CREATE INDEX idx_attempts_session ON attempts(user_id, session_id);

CREATE TABLE item_srs_new (
  user_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','learning','known')),
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  streak INTEGER NOT NULL DEFAULT 0,
  streak_days INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id)
);
INSERT INTO item_srs_new (user_id, item_id, status, interval_days, due_at, streak, streak_days)
  SELECT 'owner', item_id, status, interval_days, due_at, streak, streak_days FROM item_srs;
DROP TABLE item_srs;
ALTER TABLE item_srs_new RENAME TO item_srs;
CREATE INDEX idx_item_srs_due ON item_srs(user_id, due_at);

CREATE TABLE sessions_new (
  user_id TEXT NOT NULL,
  id TEXT NOT NULL,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lesson',
  title TEXT NOT NULL,
  plan TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  score REAL,
  next_step TEXT,
  PRIMARY KEY (user_id, id)
);
INSERT INTO sessions_new (user_id, id, lang, kind, title, plan, started_at, ended_at, summary, score, next_step)
  SELECT 'owner', id, lang, kind, title, plan, started_at, ended_at, summary, score, next_step FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE INDEX idx_sessions_lang_started ON sessions(user_id, lang, started_at);

CREATE TABLE course_state_new (
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, lang)
);
INSERT INTO course_state_new (user_id, lang, data_json, updated_at)
  SELECT 'owner', lang, data_json, updated_at FROM course_state;
DROP TABLE course_state;
ALTER TABLE course_state_new RENAME TO course_state;

CREATE TABLE learner_profile_new (
  user_id TEXT PRIMARY KEY,
  ui_lang TEXT NOT NULL,
  known_langs_json TEXT NOT NULL,
  variety TEXT,
  packs_json TEXT NOT NULL
);
INSERT INTO learner_profile_new (user_id, ui_lang, known_langs_json, variety, packs_json)
  SELECT 'owner', ui_lang, known_langs_json, variety, packs_json FROM learner_profile;
DROP TABLE learner_profile;
ALTER TABLE learner_profile_new RENAME TO learner_profile;

CREATE TABLE learner_topics_new (
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('planned','seen_via_error','current','introduced','assumed')),
  changed_at TEXT NOT NULL,
  lesson INTEGER,
  source TEXT,
  note TEXT,
  PRIMARY KEY (user_id, lang, topic_id)
);
INSERT INTO learner_topics_new (user_id, lang, topic_id, status, changed_at, lesson, source, note)
  SELECT 'owner', lang, topic_id, status, changed_at, lesson, source, note FROM learner_topics;
DROP TABLE learner_topics;
ALTER TABLE learner_topics_new RENAME TO learner_topics;

CREATE TABLE learner_checkpoints_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  lang TEXT NOT NULL,
  module_id TEXT NOT NULL,
  session_id TEXT,
  passed INTEGER NOT NULL,
  notes TEXT,
  ts TEXT NOT NULL
);
INSERT INTO learner_checkpoints_new (id, user_id, lang, module_id, session_id, passed, notes, ts)
  SELECT id, 'owner', lang, module_id, session_id, passed, notes, ts FROM learner_checkpoints;
DROP TABLE learner_checkpoints;
ALTER TABLE learner_checkpoints_new RENAME TO learner_checkpoints;
CREATE INDEX idx_learner_checkpoints_module ON learner_checkpoints(user_id, lang, module_id, ts);
