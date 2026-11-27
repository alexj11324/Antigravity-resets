-- The existing notification snapshots are the event source. Store X delivery
-- separately so publishing cannot change Telegram delivery or webhook writes.
CREATE TABLE x_post_deliveries (
  event_seq INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'retry', 'failed', 'ambiguous')),
  claim_token TEXT,
  lease_until INTEGER,
  retry_at INTEGER,
  post_id TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
