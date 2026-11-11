-- v0.5: a lesson can be delivered (pending) before the learner answers it
ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'graded' CHECK (status IN ('pending', 'graded', 'abandoned'));
ALTER TABLE sessions ADD COLUMN delivered_at TEXT;
ALTER TABLE sessions ADD COLUMN notes TEXT;
UPDATE sessions SET status = 'abandoned' WHERE score IS NULL AND summary IS NULL AND NOT EXISTS (SELECT 1 FROM attempts a WHERE a.user_id = sessions.user_id AND a.session_id = sessions.id);
