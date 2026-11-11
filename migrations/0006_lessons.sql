-- v0.5: partial credit per attempt, 0..1 (legacy rows: credit = correct)
ALTER TABLE attempts ADD COLUMN credit REAL;
UPDATE attempts SET credit = correct;
