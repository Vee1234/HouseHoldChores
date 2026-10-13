-- Named templates replace the single default plan. A template holds one rule
-- per chore: how often it happens and who it's assigned to.

CREATE TABLE templates (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX templates_household ON templates(household_id);

-- kind = 'anytime' (times_per_week goes, any days) or 'days' (the weekdays in
-- the `days` bitmask, Monday = 1 … Sunday = 64). Either way the rule only
-- applies every `every_weeks` weeks, counted from `anchor_week`.
CREATE TABLE template_rules (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  chore_id TEXT NOT NULL REFERENCES chores(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('anytime', 'days')),
  times_per_week INTEGER NOT NULL DEFAULT 1,
  days INTEGER NOT NULL DEFAULT 0,
  every_weeks INTEGER NOT NULL DEFAULT 1,
  anchor_week TEXT NOT NULL,
  position REAL NOT NULL,
  UNIQUE (template_id, chore_id)
);

CREATE TABLE rule_assignees (
  rule_id TEXT NOT NULL REFERENCES template_rules(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (rule_id, member_id)
);

-- The template the household is using now. Switching applies from that day on.
ALTER TABLE households ADD COLUMN active_template_id TEXT;

-- Week copies get the same shape as rules. Assignees move to their own table
-- so a chore can be shared; board_items.member_id is no longer used.
ALTER TABLE board_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'anytime';
ALTER TABLE board_items ADD COLUMN days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE board_items ADD COLUMN every_weeks INTEGER NOT NULL DEFAULT 1;

CREATE TABLE item_assignees (
  item_id TEXT NOT NULL REFERENCES board_items(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (item_id, member_id)
);
CREATE INDEX item_assignees_member ON item_assignees(member_id);

-- Which template each week was copied from.
ALTER TABLE weeks ADD COLUMN template_id TEXT;

-- The calendar day a tick belongs to (for day-scheduled chores, the scheduled day).
ALTER TABLE completions ADD COLUMN day TEXT;

-- ---- move existing data across ----------------------------------------------

INSERT INTO templates (id, household_id, name, created_at)
SELECT 'tpl-' || id, id, 'Our usual week', created_at FROM households;

UPDATE households SET active_template_id = 'tpl-' || id;

-- The old plan could hold the same chore twice (for different people); those
-- merge into one shared rule.
INSERT INTO template_rules (id, template_id, chore_id, kind, times_per_week, days, every_weeks, anchor_week, position)
SELECT 'rule-' || MIN(bi.id), 'tpl-' || bi.household_id, bi.chore_id, 'anytime', MAX(bi.times_per_week), 0, 1,
       '2000-01-03', MIN(bi.position)
FROM board_items bi
WHERE bi.week = 'template'
GROUP BY bi.household_id, bi.chore_id;

INSERT OR IGNORE INTO rule_assignees (rule_id, member_id)
SELECT r.id, bi.member_id
FROM board_items bi
JOIN template_rules r ON r.template_id = 'tpl-' || bi.household_id AND r.chore_id = bi.chore_id
WHERE bi.week = 'template' AND bi.member_id IS NOT NULL;

INSERT INTO item_assignees (item_id, member_id)
SELECT id, member_id FROM board_items WHERE week != 'template' AND member_id IS NOT NULL;

UPDATE completions SET day = date(done_at / 1000, 'unixepoch');

DELETE FROM board_items WHERE week = 'template';
DELETE FROM weeks WHERE week = 'template';
