-- Consecutive translation failures drive the retry backoff. A flat one-hour
-- wait after a transient model error kept a single announcement untranslated
-- for an hour; the backfill now retries in 30 seconds and only backs off when
-- the same row keeps failing.
ALTER TABLE resets ADD COLUMN translation_failures INTEGER NOT NULL DEFAULT 0;
