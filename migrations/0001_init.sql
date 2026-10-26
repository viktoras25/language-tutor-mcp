CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  lang TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('lemma','form','grammar_point','collocation')),
  label TEXT NOT NULL,
  data_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edges (
  src TEXT NOT NULL,
  dst TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('form_of','requires','contrasts_with','collocates')),
  PRIMARY KEY (src, dst, type)
);

CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  correct INTEGER NOT NULL,
  error_type TEXT,
  context TEXT
);

CREATE INDEX IF NOT EXISTS idx_items_lang_type ON items(lang, type);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst);
CREATE INDEX IF NOT EXISTS idx_attempts_item_ts ON attempts(item_id, ts);
