-- Machine translation of each announcement's original post text, keyed by
-- locale. NULL means "not translated yet": the every-minute cron backfills a
-- couple of rows per run, so new resets pick up translations without slowing
-- the webhook path.
ALTER TABLE resets ADD COLUMN text_i18n_json TEXT;

-- Last attempt, successful or not. Without it, a post the model keeps failing
-- on would be retried every minute forever and burn an API call each time.
ALTER TABLE resets ADD COLUMN translation_attempted_at TEXT;
