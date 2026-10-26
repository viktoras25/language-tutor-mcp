-- Not re-runnable on its own (SQLite has no ADD COLUMN IF NOT EXISTS); the wrangler migrations ledger applies it once.
ALTER TABLE attempts ADD COLUMN session_id TEXT;
CREATE INDEX IF NOT EXISTS idx_attempts_session ON attempts(session_id);
