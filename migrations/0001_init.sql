-- Antigravity Resets Cloudflare D1 schema
-- Apply locally:  npm run db:migrate:local
-- Apply remotely: npm run db:migrate:remote

CREATE TABLE IF NOT EXISTS resets (
  id TEXT PRIMARY KEY,
  tweet_id TEXT UNIQUE,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('regular', 'banked')),
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  models_json TEXT NOT NULL DEFAULT '[]',
  url TEXT NOT NULL,
  summary_en TEXT NOT NULL,
  summary_i18n_json TEXT NOT NULL DEFAULT '{}',
  judge_summary_json TEXT,
  thanks_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'seed',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_resets_timestamp ON resets (timestamp DESC);

CREATE TABLE IF NOT EXISTS announced_resets (
  id TEXT PRIMARY KEY,
  tweet_id TEXT UNIQUE,
  announced_at TEXT NOT NULL,
  expected_by TEXT,
  type TEXT NOT NULL CHECK (type IN ('regular', 'banked')),
  author_handle TEXT NOT NULL,
  author_name TEXT NOT NULL,
  url TEXT NOT NULL,
  quote_text TEXT NOT NULL,
  updates_json TEXT NOT NULL DEFAULT '[]',
  summary_i18n_json TEXT NOT NULL DEFAULT '{}',
  judge_summary_json TEXT,
  telegram_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'expected' CHECK (status IN ('possible', 'expected', 'confirmed', 'expired')),
  confirmed_reset_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_announced_status_at ON announced_resets (status, announced_at DESC);

CREATE TABLE IF NOT EXISTS x_webhook_events (
  event_hash TEXT PRIMARY KEY,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  signature_scheme TEXT NOT NULL,
  event_type TEXT NOT NULL,
  tweet_id TEXT,
  author_handle TEXT,
  classified_as TEXT,
  judge_result_json TEXT,
  raw_payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_x_events_received ON x_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_x_events_class ON x_webhook_events (classified_as);

CREATE TABLE IF NOT EXISTS email_subscriptions (
  email TEXT PRIMARY KEY,
  locale TEXT NOT NULL DEFAULT 'en',
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  locale TEXT NOT NULL DEFAULT 'en',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS presence_sessions (
  session_id TEXT PRIMARY KEY,
  last_seen INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence_sessions (last_seen);
