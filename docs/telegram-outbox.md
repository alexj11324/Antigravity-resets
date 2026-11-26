# Public Telegram delivery

Run the test suite with Node 22.13 or later (the SQLite test adapter uses
`node:sqlite`; verified locally with Node 24). The `npm run dev` source-storage
preview remains compatible with Node 20; public Telegram outbox delivery and
cron acceptance use `npm run dev:worker` with Wrangler local D1, where the real
SQLite triggers run. The memory preview does not send public Telegram.

Apply `0002_telegram_outbox.sql` before deploying the Worker. It starts empty;
existing resets and announcements are not resent. Triggers queue snapshots in
exactly the transaction that changes a reset or watch. New-writer markers
(`resets.quote_text IS NOT NULL`, incrementing `announced_resets.telegram_revision`)
prevent the previous Worker from enqueuing jobs while it still sends directly,
including a rollback. Watch content updates append atomically to avoid losing
simultaneous source quotes.

`drainTelegramOutbox(env)` runs after each persisted webhook, including replay.
Configure the Worker scheduled handler to call it every minute. It claims one
request at a time, records successful Telegram message IDs, and edits an existing
watch message for later snapshots. An unresolved watch snapshot blocks later
snapshots of that watch; unrelated messages keep flowing. Pending announcements
are cancelled when their source becomes confirmed or expired; a definitive
in-flight failure after closure also cannot return the job to delivery.

Explicit Telegram API 429 and 5xx rejections retry after `retry_after` or bounded
backoff. Permanent rejections remain `failed`. Edits may safely retry transport
failures; `message is not modified` confirms the requested text is already there.
Failed edits never silently create replacement posts. Sends with a transport
failure, malformed/unknown response, or expired in-flight lease remain
`ambiguous`, because Telegram offers no send idempotency key.

## Inspect and reconcile through authenticated D1 access

Use the existing authenticated D1 console or `wrangler d1 execute` for the
Worker's bound database. First inspect durable delivery records:

```sql
SELECT seq, kind, entity_id, status, attempts, action, telegram_message_id,
       last_error, next_attempt_at, created_at
FROM telegram_outbox WHERE status <> 'sent' ORDER BY seq;
```

Inspect the actual Telegram channel before changing an ambiguous record. If the
message was delivered, replace the example sequence and message ID below with
the observed values. Saving a watch's ID happens atomically through a trigger,
so later watch updates edit that same message:

```sql
UPDATE telegram_outbox
SET status = 'sent', telegram_message_id = 'OBSERVED_MESSAGE_ID',
    last_error = 'operator_confirmed_delivered',
    completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    lease_until = NULL, claim_token = NULL
WHERE seq = EXAMPLE_SEQUENCE AND status = 'ambiguous';
```

Only after positively confirming that Telegram did not deliver the original
send, release that record for delivery on the next cron:

```sql
UPDATE telegram_outbox
SET status = 'pending', next_attempt_at = 0,
    last_error = 'operator_confirmed_not_sent', lease_until = NULL, claim_token = NULL
WHERE seq = EXAMPLE_SEQUENCE AND status = 'ambiguous';
```

Absence of a local acknowledgement alone does not prove non-delivery. Inspect
permanent failures, fix the reported bot/chat/request issue, then reset the
specific `failed` row to `pending` with `next_attempt_at = 0` using the same guarded
UPDATE pattern. New sends and confirmed deliveries require no manual action.
