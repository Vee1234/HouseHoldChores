-- Optional time of day ("HH:MM", for chores on set days) and an optional
-- "only after this other chore is done" constraint, on rules and week copies.
ALTER TABLE template_rules ADD COLUMN time TEXT;
ALTER TABLE template_rules ADD COLUMN after_chore_id TEXT REFERENCES chores(id) ON DELETE SET NULL;
ALTER TABLE board_items ADD COLUMN time TEXT;
ALTER TABLE board_items ADD COLUMN after_chore_id TEXT REFERENCES chores(id) ON DELETE SET NULL;

-- Remembers which scheduled notifications have gone out, so each is sent once.
CREATE TABLE notification_log (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);
