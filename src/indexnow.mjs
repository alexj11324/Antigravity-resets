// Search-engine push. Google ignores IndexNow, but Bing/Copilot, Yandex, Naver,
// and Seznam use it, and a brand-new domain has no crawl history to fall back
// on. The cron compares the newest reset timestamp with the last one it pushed,
// so a reset costs one request rather than one per tick.
//
// Two transports, in order of reliability:
// 1. Bing Webmaster SubmitUrlbatch, when BING_WEBMASTER_API_KEY is set. It is
//    authenticated against a verified site and has its own quota, so it does
//    not depend on anonymous-IP reputation.
// 2. Anonymous IndexNow. api.indexnow.org rate-limits the shared Workers egress
//    pool (429 TooManyRequests, no Retry-After), so this is best-effort.

import { SITE_ORIGIN } from "./seo-data.mjs";
import { LANG_CODES } from "./seo-data.mjs";

const ENDPOINT = "https://api.indexnow.org/indexnow";
const BING_ENDPOINT = "https://ssl.bing.com/webmaster/api.svc/json/SubmitUrlbatch";
const STATE_KEY = "indexnow_last_reset";
const ATTEMPT_KEY = "indexnow_last_attempt";
// The 429 body ("you have sent too many requests") carries no Retry-After, so
// pick a spacing that stays well under a per-IP limit: at most one attempt an
// hour, while a new reset after a success still pushes immediately.
const RETRY_AFTER_MS = 60 * 60 * 1000;

/**
 * Bing Webmaster takes its key as a query parameter, so any string that may be
 * logged — an error message or a response body — must be scrubbed first.
 * @param {unknown} value
 * @returns {string}
 */
export function redactApiKey(value) {
  return String(value ?? "").replace(/apikey=[^&\s"']+/gi, "apikey=<redacted>");
}

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
  const bingKey = env?.BING_WEBMASTER_API_KEY;
  const db = env?.DB;
  if ((!key && !bingKey) || !db) return { status: "skipped", detail: "not configured" };

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

  const urlList = indexNowUrls();
  // The trailing slash on siteUrl must match how the site is verified in Bing
  // Webmaster Tools; the apex with a trailing slash is that form.
  const request = bingKey
    ? {
        channel: "bing-webmaster",
        endpoint: `${BING_ENDPOINT}?apikey=${encodeURIComponent(bingKey)}`,
        body: JSON.stringify({ siteUrl: `${SITE_ORIGIN}/`, urlList }),
      }
    : {
        channel: "indexnow",
        endpoint: ENDPOINT,
        body: JSON.stringify({
          host: new URL(SITE_ORIGIN).host,
          key,
          keyLocation: `${SITE_ORIGIN}/${key}.txt`,
          urlList,
        }),
      };

  let response;
  try {
    response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      // The cron also drains user-facing alerts; a hung endpoint must not
      // hold that up for the whole invocation budget.
      signal: AbortSignal.timeout(10000),
      body: request.body,
    });
  } catch (error) {
    // error.message can embed the request URL on some runtimes, and the BWT
    // URL carries the API key. Log the class name instead of the message.
    console.error("indexnow_failed", request.channel, error?.name || "network");
    await recordAttempt(db);
    return { status: "error", detail: "network" };
  }

  // 200/202 mean accepted; 422 means the key file did not match, which is a
  // real misconfiguration worth logging.
  if (!(response.ok || response.status === 202)) {
    // The body usually says why (rate limited, key not found). Log a bounded
    // slice so a persistent rejection is diagnosable from the cron logs.
    let body = "";
    try {
      body = redactApiKey((await response.text()).slice(0, 200));
    } catch {
      body = "";
    }
    console.error(
      "indexnow_rejected",
      request.channel,
      response.status,
      `retry-after=${response.headers.get("retry-after") || "none"}`,
      body,
    );
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

  return { status: "sent", detail: request.channel };
}
