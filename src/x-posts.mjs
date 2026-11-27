import { SITE_ORIGIN } from "./seo-data.mjs";

const X_API = "https://api.x.com";
const PUBLISHER = "agy_resets";
const REQUEST_TIMEOUT_MS = 7_000;
const MAX_POSTS_PER_DRAIN = 3;
const LEASE_MS = 60_000;
const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SOURCE_URL = /^https:\/\/(?:x|twitter)\.com\/([\w]{1,15}|i\/web)\/status\/([0-9]{1,19})$/i;
const encoder = new TextEncoder();

// These requests use fixed endpoints and JSON bodies, so the OAuth signature
// includes only the OAuth parameters.
function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) =>
    "%" + char.charCodeAt(0).toString(16).toUpperCase());
}

async function signedRequest(credentials, fetchImpl, method, path, payload, now) {
  const url = X_API + path;
  const params = {
    oauth_consumer_key: credentials.apiKey,
    oauth_nonce: crypto.randomUUID(),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(now / 1000)),
    oauth_token: credentials.accessToken,
    oauth_version: "1.0",
  };
  const normalized = Object.keys(params).sort()
    .map((key) => `${key}=${encode(params[key])}`).join("&");
  const base = [method, url, normalized].map(encode).join("&");
  const signingKey = `${encode(credentials.apiSecret)}&${encode(credentials.accessSecret)}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(signingKey),
    { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(base));
  params.oauth_signature = btoa(String.fromCharCode(...new Uint8Array(signature)));

  const authorization = "OAuth " + Object.entries(params)
    .map(([name, value]) => `${name}="${encode(value)}"`).join(", ");
  return fetchImpl(url, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: payload
      ? { Authorization: authorization, "Content-Type": "application/json" }
      : { Authorization: authorization },
    body: payload && JSON.stringify(payload),
  });
}

async function nextEvent(db, startAt, now) {
  return db.prepare(`SELECT event.seq, event.kind, event.entity_id, event.payload_json
    FROM telegram_outbox AS event
    LEFT JOIN x_post_deliveries AS delivery ON delivery.event_seq = event.seq
    WHERE event.created_at >= ?
      AND NOT EXISTS (
        SELECT 1 FROM x_post_deliveries WHERE status = 'retry' AND retry_at > ?
      )
      AND (delivery.event_seq IS NULL OR delivery.status = 'retry')
      AND (
        (event.kind = 'reset' AND EXISTS (
          SELECT 1 FROM resets WHERE id = event.entity_id AND julianday(timestamp) >= julianday(?)
        ))
        OR (event.kind = 'announcement'
          AND json_extract(event.payload_json, '$.status') = 'expected'
          AND EXISTS (
            SELECT 1 FROM announced_resets WHERE id = event.entity_id AND status = 'expected'
              AND julianday(announced_at) >= julianday(?)
          ))
      )
    ORDER BY event.seq LIMIT 1`).bind(startAt, now, startAt, startAt).first();
}

async function claimEvent(db, event, now) {
  const token = crypto.randomUUID();
  const claim = await db.prepare(`INSERT INTO x_post_deliveries (event_seq, status, claim_token, lease_until)
    SELECT ?, 'sending', ?, ?
    WHERE ? = 'reset' OR EXISTS (
      SELECT 1 FROM announced_resets WHERE id = ? AND status = 'expected'
    )
    ON CONFLICT(event_seq) DO UPDATE SET
      status = 'sending', claim_token = excluded.claim_token, lease_until = excluded.lease_until,
      retry_at = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE x_post_deliveries.status = 'retry' AND x_post_deliveries.retry_at <= ?
    RETURNING claim_token`).bind(event.seq, token, now + LEASE_MS, event.kind, event.entity_id, now).first();
  return claim?.claim_token;
}

async function finish(db, event, token, status, { reason = null, retryAt = null, postId = null } = {}) {
  const result = await db.prepare(`UPDATE x_post_deliveries
    SET status = ?, post_id = ?, last_error = ?, retry_at = ?, lease_until = NULL, claim_token = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE event_seq = ? AND status = 'sending' AND claim_token = ?`)
    .bind(status, postId, reason, retryAt, event.seq, token).run();
  if (!result.meta.changes) {
    console.error(JSON.stringify({ event: "x_post_late_result", seq: event.seq, status, postId }));
    return { status: "superseded" };
  }
  console[status === "sent" ? "log" : "warn"](
    JSON.stringify({ event: "x_post_delivery", seq: event.seq, status, reason, postId }),
  );
  return { status, postId };
}

function postBody(event) {
  const payload = JSON.parse(event.payload_json);
  const match = SOURCE_URL.exec(payload.url);
  if (!match || match[1].toLowerCase() === PUBLISHER) return null;
  const source = `https://x.com/${match[1]}/status/${match[2]}`;
  const kind = payload.type === "banked" ? "Antigravity banked quota reset" : "Antigravity quota reset";
  const headline = event.kind === "reset"
    ? `✅ ${kind} confirmed.`
    : `🗓️ ${kind} expected. Execution has not been confirmed.`;
  return { text: `${headline}\n\n${SITE_ORIGIN}/\n${source}` };
}

function rateLimitRetryAt(response, now) {
  const after = Number(response.headers.get("retry-after"));
  const reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
  return Math.max(now + 60_000, Number.isFinite(after) ? now + after * 1000 : now,
    Number.isFinite(reset) ? reset : now);
}

async function deliver(db, event, credentials, fetchImpl, now) {
  const payload = postBody(event);
  const token = await claimEvent(db, event, now());
  if (!token) return { status: "superseded" };
  if (!payload) return finish(db, event, token, "failed", { reason: "invalid_source" });

  let response;
  let postId;
  try {
    response = await signedRequest(credentials, fetchImpl, "POST", "/2/tweets", payload, now());
    if (response.status === 201) postId = (await response.json()).data?.id;
  } catch {
    return finish(db, event, token, "ambiguous", { reason: "unknown_response" });
  }
  if (typeof postId === "string" && /^[0-9]{1,19}$/.test(postId)) {
    return finish(db, event, token, "sent", { postId });
  }
  if (response.status === 429) {
    return finish(db, event, token, "retry", {
      reason: "http_429", retryAt: rateLimitRetryAt(response, now()),
    });
  }
  const rejected = response.status >= 400 && response.status < 500 && response.status !== 408;
  return finish(db, event, token, rejected ? "failed" : "ambiguous", { reason: `http_${response.status}` });
}

export async function drainXPosts(env, { fetchImpl = env?.__fetchImpl || fetch, now = Date.now } = {}) {
  const credentials = {
    apiKey: env?.X_POST_API_KEY,
    apiSecret: env?.X_POST_API_KEY_SECRET,
    accessToken: env?.X_POST_ACCESS_TOKEN,
    accessSecret: env?.X_POST_ACCESS_TOKEN_SECRET,
  };
  const start = UTC_TIMESTAMP.test(env?.X_POSTS_START_AT) ? Date.parse(env.X_POSTS_START_AT) : NaN;
  if (!env?.DB || !Number.isFinite(start) || !Object.values(credentials).every(Boolean)) {
    return { status: "unconfigured" };
  }
  try {
    const db = env.DB;
    await db.prepare(`UPDATE x_post_deliveries
      SET status = 'ambiguous', last_error = 'lease_expired', claim_token = NULL, lease_until = NULL,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status = 'sending' AND lease_until <= ?`).bind(now()).run();
    const startAt = new Date(start).toISOString();
    let event = await nextEvent(db, startAt, now());
    if (!event) return { status: "idle" };

    const identity = await signedRequest(credentials, fetchImpl, "GET", "/2/users/me", null, now());
    const user = identity.ok ? (await identity.json()).data : null;
    if (user?.username?.toLowerCase() !== PUBLISHER) {
      console.error(JSON.stringify({ event: "x_post_identity_failed", httpStatus: identity.status }));
      return { status: "identity_failed", error: true };
    }
    let result;
    // Keep the identity check and all sends inside the webhook's waitUntil window.
    for (let i = 0; i < MAX_POSTS_PER_DRAIN && event; i++) {
      result = await deliver(db, event, credentials, fetchImpl, now);
      if (result.status !== "sent") return result;
      event = await nextEvent(db, startAt, now());
    }
    return result;
  } catch {
    console.error(JSON.stringify({ event: "x_post_drain_failed" }));
    return { status: "error", error: true };
  }
}
