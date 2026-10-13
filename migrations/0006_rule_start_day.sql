-- Optional first day a template chore happens. Before then it isn't on the board;
-- in its first week it only covers that day on. NULL = no start restriction.
ALTER TABLE template_rules ADD COLUMN start_day TEXT;
