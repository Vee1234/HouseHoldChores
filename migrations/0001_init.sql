CREATE TABLE households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  join_code TEXT NOT NULL UNIQUE,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  created_at INTEGER NOT NULL
);

-- One row per signed-in device; only a hash of each secret is stored.
CREATE TABLE device_tokens (
  token_hash TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL,
  color TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX members_household ON members(household_id);

-- The chore library. `per` says what `minutes` is measured against:
-- each = every time it is done, day/week/month = a rough total for that period.
CREATE TABLE chores (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  emoji TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  per TEXT NOT NULL CHECK (per IN ('each', 'day', 'week', 'month')),
  times_per_week INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX chores_household ON chores(household_id);

-- A board is either the default template (week = 'template') or one week's
-- copy of it (week = the Monday, 'YYYY-MM-DD').
CREATE TABLE weeks (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  modified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (household_id, week)
);

CREATE TABLE board_items (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  week TEXT NOT NULL,
  chore_id TEXT NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  position REAL NOT NULL,
  times_per_week INTEGER NOT NULL
);
CREATE INDEX board_items_week ON board_items(household_id, week);

CREATE TABLE completions (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  done_at INTEGER NOT NULL
);
CREATE INDEX completions_item ON completions(item_id);

CREATE TABLE announcements (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  author_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  day TEXT NOT NULL,
  text TEXT NOT NULL,
  color TEXT NOT NULL,
  notified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX announcements_day ON announcements(household_id, day);

-- member_id NULL means the reminder is for everyone.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT REFERENCES members(id) ON DELETE CASCADE,
  created_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  title TEXT NOT NULL,
  due_at INTEGER NOT NULL,
  repeat TEXT NOT NULL CHECK (repeat IN ('none', 'daily', 'weekdays', 'weekly', 'monthly')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX reminders_due ON reminders(active, due_at);

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX push_member ON push_subscriptions(member_id);
