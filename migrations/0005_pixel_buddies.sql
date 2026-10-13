-- Each person's pixel-art buddy. Existing people get the closest match to
-- their emoji; `emoji` stays in step for text-only places like notifications.
ALTER TABLE members ADD COLUMN buddy TEXT NOT NULL DEFAULT 'bear';

UPDATE members SET buddy = CASE emoji
  WHEN '🐰' THEN 'bunny'
  WHEN '🦊' THEN 'fox'
  WHEN '🐱' THEN 'cat'
  WHEN '🐸' THEN 'frog'
  WHEN '🐥' THEN 'chick'
  WHEN '🐶' THEN 'dog'
  WHEN '🐹' THEN 'bunny'
  WHEN '🐼' THEN 'bear'
  WHEN '🐨' THEN 'elephant'
  WHEN '🐮' THEN 'dog'
  WHEN '🦄' THEN 'deer'
  WHEN '🦉' THEN 'chick'
  WHEN '🐝' THEN 'chick'
  WHEN '🦔' THEN 'fox'
  WHEN '🐢' THEN 'frog'
  ELSE 'bear'
END;

UPDATE members SET emoji = CASE buddy
  WHEN 'bunny' THEN '🐰'
  WHEN 'fox' THEN '🦊'
  WHEN 'cat' THEN '🐱'
  WHEN 'frog' THEN '🐸'
  WHEN 'chick' THEN '🐥'
  WHEN 'dog' THEN '🐶'
  WHEN 'elephant' THEN '🐘'
  WHEN 'deer' THEN '🦌'
  ELSE '🐻'
END;
