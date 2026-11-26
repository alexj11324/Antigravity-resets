import { formatConfirmedTelegramHtml, formatExpectedTelegramHtml } from "./x-webhook.mjs";

const LEASE_MS = 60_000;
const REQUEST_TIMEOUT_MS = 15_000;

// A send that may have reached Telegram must never be retried automatically:
// sendMessage has no idempotency key. Edits to a known message are idempotent.
async function claimNext(db, now) {
  await db.prepare(`UPDATE telegram_outbox SET status = 'cancelled',
      last_error = 'announcement_closed', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE status = 'pending' AND kind = 'announcement' AND EXISTS (
      SELECT 1 FROM announced_resets WHERE id = entity_id AND status IN ('confirmed', 'expired')
    )`).run();
  const expired = await db.prepare(`UPDATE telegram_outbox SET
      status = CASE WHEN action = 'edit' THEN 'pending' ELSE 'ambiguous' END,
      last_error = 'worker_lease_expired', lease_until = NULL, claim_token = NULL
    WHERE status = 'sending' AND lease_until <= ? RETURNING seq, kind, entity_id, status`).bind(now).all();
  for (const row of expired.results || []) {
    console.error(JSON.stringify({ event: 'telegram_outbox_lease_expired', ...row }));
  }
  const token = crypto.randomUUID();
  return db.prepare(`UPDATE telegram_outbox SET status = 'sending',
      attempts = attempts + 1, lease_until = ?, claim_token = ?,
      action = CASE WHEN kind = 'announcement' AND
        (SELECT telegram_message_id FROM announced_resets WHERE id = entity_id) IS NOT NULL
        THEN 'edit' ELSE 'send' END,
      telegram_message_id = CASE WHEN kind = 'announcement' THEN
        (SELECT telegram_message_id FROM announced_resets WHERE id = entity_id) ELSE NULL END
    WHERE seq = (
      SELECT current.seq FROM telegram_outbox AS current
      WHERE current.status = 'pending' AND current.next_attempt_at <= ?
        AND (current.kind <> 'announcement' OR EXISTS (SELECT 1 FROM announced_resets
          WHERE id = current.entity_id AND status IN ('possible', 'expected')))
        AND NOT EXISTS (SELECT 1 FROM telegram_outbox AS earlier
          WHERE earlier.kind = current.kind AND earlier.entity_id = current.entity_id
            AND earlier.seq < current.seq AND earlier.status IN ('pending', 'sending', 'ambiguous'))
        AND NOT EXISTS (SELECT 1 FROM telegram_outbox WHERE status = 'sending')
      ORDER BY current.seq LIMIT 1
    ) AND status = 'pending' RETURNING *`).bind(now + LEASE_MS, token, now).first();
}

async function complete(db, row, messageId) {
  const result = await db.prepare(`UPDATE telegram_outbox SET status = 'sent',
    telegram_message_id = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    lease_until = NULL, last_error = NULL
    WHERE seq = ? AND status = 'sending' AND claim_token = ?`)
    .bind(String(messageId), row.seq, row.claim_token).run();
  return (result?.meta?.changes || 0) > 0;
}

async function defer(db, row, status, reason, now, delaySeconds = null) {
  const delay = delaySeconds ?? Math.min(3600, 30 * 2 ** Math.min(row.attempts - 1, 7));
  const updated = await db.prepare(`UPDATE telegram_outbox SET
      status = CASE WHEN ? = 'pending' AND kind = 'announcement' AND EXISTS (
        SELECT 1 FROM announced_resets WHERE id = entity_id AND status IN ('confirmed', 'expired')
      ) THEN 'cancelled' ELSE ? END, last_error = ?,
      next_attempt_at = ?, lease_until = NULL, claim_token = NULL
    WHERE seq = ? AND status = 'sending' AND claim_token = ? RETURNING status`)
    .bind(status, status, reason, now + delay * 1000, row.seq, row.claim_token).first();
  status = updated?.status || 'superseded';
  const level = status === 'ambiguous' || status === 'failed' ? 'error' : 'warn';
  console[level](JSON.stringify({ event: 'telegram_outbox_delivery', seq: row.seq,
    kind: row.kind, entityId: row.entity_id, status, reason }));
  return status;
}

async function deliver(env, row, fetchImpl, now) {
  let html;
  try {
    const payload = JSON.parse(row.payload_json);
    const siteUrl = (env.SITE_URL || 'https://antigravity-resets.com').replace(/\/+$/, '');
    html = row.kind === 'reset'
      ? formatConfirmedTelegramHtml(payload, siteUrl)
      : formatExpectedTelegramHtml(payload, siteUrl);
  } catch {
    return defer(env.DB, row, 'failed', 'invalid_payload', now);
  }
  if (row.kind === 'announcement') {
    const announcement = await env.DB.prepare('SELECT status FROM announced_resets WHERE id = ?')
      .bind(row.entity_id).first();
    if (!announcement || !['possible', 'expected'].includes(announcement.status)) {
      return defer(env.DB, row, 'cancelled', 'announcement_closed', now);
    }
  }
  const editing = row.action === 'edit';
  const method = editing ? 'editMessageText' : 'sendMessage';
  let response;
  let result;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID,
        ...(editing ? { message_id: Number(row.telegram_message_id) || row.telegram_message_id } : {}),
        text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    result = await response.json();
  } catch {
    const status = editing ? 'pending' : 'ambiguous';
    return defer(env.DB, row, status, 'transport_or_invalid_response', now);
  }
  const messageId = editing ? row.telegram_message_id : result?.result?.message_id;
  const notModified = editing && result?.ok === false && result?.error_code === 400
    && /message is not modified/i.test(result?.description || '');
  if ((response.ok && result?.ok === true && messageId != null) || notModified) {
    const completed = await complete(env.DB, row, messageId);
    if (!completed) {
      console.warn(JSON.stringify({ event: 'telegram_outbox_late_acknowledgement', seq: row.seq,
        messageId: String(messageId) }));
      return 'superseded';
    }
    console.log(JSON.stringify({ event: 'telegram_outbox_sent', seq: row.seq,
      kind: row.kind, entityId: row.entity_id, action: row.action, messageId: String(messageId) }));
    return 'sent';
  }
  // Only an explicit Telegram API rejection proves that sendMessage did not
  // succeed. An HTTP 5xx from a proxy without this body remains ambiguous.
  if (result?.ok === false && Number.isInteger(result.error_code)) {
    const code = result.error_code;
    const retryable = code === 429 || code >= 500;
    const retryAfter = Number(result.parameters?.retry_after);
    return defer(env.DB, row, retryable ? 'pending' : 'failed', `telegram_api_${code}`, now,
      retryable && Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(86400, retryAfter) : null);
  }
  const status = editing ? 'pending' : 'ambiguous';
  return defer(env.DB, row, status, `unconfirmed_response_${response.status}`, now);
}

export async function drainTelegramOutbox(env, { fetchImpl = env?.__fetchImpl || fetch,
  now = Date.now, limit = 10 } = {}) {
  if (env?.DB?._supportsTelegramOutbox === false) return { unsupportedPreview: true };
  if (!env?.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return { unconfigured: true };
  const counts = { sent: 0, pending: 0, ambiguous: 0, failed: 0, superseded: 0, cancelled: 0 };
  try {
    for (let i = 0; i < limit; i++) {
      const time = typeof now === 'function' ? now() : now;
      const row = await claimNext(env.DB, time);
      if (!row) break;
      counts[await deliver(env, row, fetchImpl, time)]++;
    }
    return counts;
  } catch {
    // A post-send D1 failure leaves the claim durable. Lease recovery above
    // holds uncertain sends, while safe edits can run again on the next cron.
    console.error(JSON.stringify({ event: 'telegram_outbox_drain_failed' }));
    return { ...counts, error: true };
  }
}
