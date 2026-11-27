-- Small key/value table for cross-tick state that is not tied to a reset row.
-- First use: remembering the last reset timestamp pushed to IndexNow, so the
-- cron pings search engines once per new announcement instead of every minute.
CREATE TABLE IF NOT EXISTS site_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
