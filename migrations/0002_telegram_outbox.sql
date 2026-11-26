-- Durable public Telegram delivery. Triggers commit each snapshot in the same
-- SQLite transaction as the source change; no historical messages are backfilled.
ALTER TABLE resets ADD COLUMN quote_text TEXT;
ALTER TABLE announced_resets ADD COLUMN telegram_revision INTEGER NOT NULL DEFAULT 0;

CREATE TABLE telegram_outbox (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('reset', 'announcement')),
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'ambiguous', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  claim_token TEXT,
  action TEXT CHECK (action IN ('send', 'edit')),
  telegram_message_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  completed_at TEXT
);
CREATE INDEX idx_telegram_outbox_pending ON telegram_outbox(status, next_attempt_at, seq);
CREATE INDEX idx_telegram_outbox_entity ON telegram_outbox(kind, entity_id, seq);

CREATE TRIGGER telegram_reset_insert AFTER INSERT ON resets
WHEN NEW.source LIKE 'x_webhook%' AND NEW.quote_text IS NOT NULL
BEGIN
  INSERT INTO telegram_outbox(kind, entity_id, payload_json)
  VALUES ('reset', NEW.id, json_object(
    'id', NEW.id, 'type', NEW.type, 'authorHandle', NEW.author_handle,
    'authorName', NEW.author_name, 'url', NEW.url, 'quoteText', NEW.quote_text,
    'summary', json_object('en', NEW.summary_en)));
END;

CREATE TRIGGER telegram_announcement_insert AFTER INSERT ON announced_resets
WHEN NEW.telegram_revision > 0
BEGIN
  INSERT INTO telegram_outbox(kind, entity_id, payload_json)
  VALUES ('announcement', NEW.id, json_object(
    'id', NEW.id, 'type', NEW.type, 'status', NEW.status,
    'authorHandle', NEW.author_handle, 'authorName', NEW.author_name,
    'url', NEW.url, 'quoteText', NEW.quote_text, 'expectedBy', NEW.expected_by,
    'updates', json(NEW.updates_json)));
END;

CREATE TRIGGER telegram_announcement_update
AFTER UPDATE OF telegram_revision ON announced_resets
WHEN NEW.telegram_revision > OLD.telegram_revision
BEGIN
  INSERT INTO telegram_outbox(kind, entity_id, payload_json)
  VALUES ('announcement', NEW.id, json_object(
    'id', NEW.id, 'type', NEW.type, 'status', NEW.status,
    'authorHandle', NEW.author_handle, 'authorName', NEW.author_name,
    'url', NEW.url, 'quoteText', NEW.quote_text, 'expectedBy', NEW.expected_by,
    'updates', json(NEW.updates_json)));
END;

-- Completing or reconciling a delivered watch and saving its message ID are one
-- atomic statement, including when done through the operator D1 console.
CREATE TRIGGER telegram_announcement_delivered AFTER UPDATE OF status ON telegram_outbox
WHEN NEW.kind = 'announcement' AND NEW.status = 'sent'
  AND NEW.telegram_message_id IS NOT NULL
BEGIN
  UPDATE announced_resets SET telegram_message_id = NEW.telegram_message_id
  WHERE id = NEW.entity_id;
END;
