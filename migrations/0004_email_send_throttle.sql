-- Mail throttling needs to count sends, not row creations.
--
-- `created_at` is immutable on conflict, so it could never represent "when did
-- we last mail this address", and counting rows per hour missed repeat submits
-- entirely. Track the actual send time per address and keep an atomic hourly
-- reservation counter.

ALTER TABLE email_subscriptions ADD COLUMN confirmation_sent_at TEXT;

CREATE TABLE IF NOT EXISTS email_send_log (
  window_start TEXT PRIMARY KEY,
  sent INTEGER NOT NULL DEFAULT 0
);
