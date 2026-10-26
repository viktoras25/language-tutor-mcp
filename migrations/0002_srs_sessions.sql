-- Everything here is IF NOT EXISTS or a guarded UPDATE, so re-running is safe.

CREATE TABLE IF NOT EXISTS item_srs (
  item_id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','learning','known')),
  interval_days INTEGER NOT NULL DEFAULT 0,
  due_at TEXT,
  streak INTEGER NOT NULL DEFAULT 0,
  streak_days INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'lesson',
  title TEXT NOT NULL,
  plan TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  score REAL,
  next_step TEXT
);

CREATE TABLE IF NOT EXISTS course_state (
  lang TEXT PRIMARY KEY,
  data_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_item_srs_due ON item_srs(due_at);
CREATE INDEX IF NOT EXISTS idx_sessions_lang_started ON sessions(lang, started_at);

-- Legacy ts was SQLite "YYYY-MM-DD HH:MM:SS". Make it canonical ISO so string order == time order.
UPDATE attempts SET ts = replace(ts, ' ', 'T') || '.000Z' WHERE ts NOT LIKE '%T%';
