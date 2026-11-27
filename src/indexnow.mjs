// IndexNow push. Google ignores this protocol, but Bing/Copilot, Yandex, Naver,
// and Seznam use it, and a brand-new domain has no crawl history to fall back
// on. The cron compares the newest reset timestamp with the last one it pushed,
// so a reset costs one request rather than one per tick.

import { SITE_ORIGIN } from "./seo-data.mjs";
import { LANG_CODES } from "./seo-data.mjs";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const STATE_KEY = "indexnow_last_reset";
const ATTEMPT_KEY = "indexnow_last_attempt";
// IndexNow rate-limits aggressively, and Workers share egress IPs, so a 429 is
// expected. Retrying on every cron tick keeps the limit tripped; a failure now
// schedules the next attempt 15 minutes out instead.
const RETRY_AFTER_MS = 15 * 60 * 1000;

/**
 * Remember a failed attempt so the next tick does not hammer the endpoint.
 * @param {object} db
 */
async function recordAttempt(db) {
  try {
    await db
      .prepare(
        "INSERT INTO site_state (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      )
      .bind(ATTEMPT_KEY, String(Date.now()))
      .run();
  } catch (error) {
    console.error("indexnow_attempt_write_failed", error?.message || "unknown");
  }
}

/**
 * @param {object} db
 */
async function clearAttempt(db) {
  try {
    await db.prepare("DELETE FROM site_state WHERE key = ?").bind(ATTEMPT_KEY).run();
  } catch (error) {
    console.error("indexnow_attempt_clear_failed", error?.message || "unknown");
  }
}

/**
 * @param {object} env
 * @returns {string[]} URLs worth announcing for new reset data
 */
export function indexNowUrls() {
  const urls = [`${SITE_ORIGIN}/`];
  for (const code of LANG_CODES) {
    if (code === "en") continue;
    urls.push(`${SITE_ORIGIN}/${code}`, `${SITE_ORIGIN}/${code}/history`);
  }
  urls.push(`${SITE_ORIGIN}/history`);
  return urls;
}

/**
 * Ping IndexNow when (and only when) a new reset has appeared.
 * @param {object} env
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<{status: string, detail?: string}>}
 */
export async function pingIndexNow(env, fetchImpl = fetch) {
  const key = env?.INDEXNOW_KEY;
  const db = env?.DB;
  if (!key || !db) return { status: "skipped", detail: "not configured" };

  let latest;
  try {
    latest = await db.prepare("SELECT MAX(timestamp) AS ts FROM resets").first();
  } catch {
    return { status: "skipped", detail: "resets table unavailable" };
  }
  const ts = latest?.ts;
  if (!ts) return { status: "skipped", detail: "no resets" };

  try {
    const state = await db
      .prepare("SELECT value FROM site_state WHERE key = ?")
      .bind(STATE_KEY)
      .first();
    if (state?.value === ts) return { status: "unchanged" };
    const attempt = await db
      .prepare("SELECT value FROM site_state WHERE key = ?")
      .bind(ATTEMPT_KEY)
      .first();
    const lastAttempt = Number(attempt?.value || 0);
    if (lastAttempt > 0 && Date.now() - lastAttempt < RETRY_AFTER_MS) {
      return { status: "backoff" };
    }
  } catch (error) {
    // Silence here would disable IndexNow forever if 0007 never ran, with no
    // signal anywhere. One log line makes that misconfiguration findable.
    console.error("indexnow_state_unavailable", error?.message || "unknown");
    return { status: "skipped", detail: "site_state unavailable" };
  }

  const keyLocation = `${SITE_ORIGIN}/${key}.txt`;
  let response;
  try {
    response = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      // The cron also drains user-facing alerts; a hung endpoint must not
      // hold that up for the whole invocation budget.
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        host: new URL(SITE_ORIGIN).host,
        key,
        keyLocation,
        urlList: indexNowUrls(),
      }),
    });
  } catch (error) {
    console.error("indexnow_failed", error?.message || "network");
    await recordAttempt(db);
    return { status: "error", detail: "network" };
  }

  // 200/202 mean accepted; 422 means the key file did not match, which is a
  // real misconfiguration worth logging.
  if (!(response.ok || response.status === 202)) {
    console.error("indexnow_rejected", response.status);
    await recordAttempt(db);
    return { status: "error", detail: `HTTP ${response.status}` };
  }

  await clearAttempt(db);
  try {
    await db
      .prepare(
        "INSERT INTO site_state (key, value) VALUES (?, ?) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')",
      )
      .bind(STATE_KEY, ts)
      .run();
  } catch (error) {
    console.error("indexnow_state_write_failed", error?.message || "unknown");
  }

  return { status: "sent" };
}
