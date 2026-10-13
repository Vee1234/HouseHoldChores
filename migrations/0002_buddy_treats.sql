-- Treats are earned one per completed go; this counts how many have been eaten.
ALTER TABLE members ADD COLUMN treats_fed INTEGER NOT NULL DEFAULT 0;
