import { drainTelegramOutbox } from "./telegram-outbox.mjs";
import {
  parseWebhookPayload,
  parseWatchedHandles,
} from "./reset-classifier.mjs";
import { judgeResetTweet } from "./joint-judge.mjs";
import {
  deliverEmail,
  emailTransport,
  unsubscribeSecret,
  unsubscribeToken,
  unsubscribeUrl,
} from "./api.mjs";
import {
  listEmailSubscribers,
  recordWebhookEventAndResets,
} from "./store.mjs";

const WEBHOOK_PATH = "/api/webhooks/x";
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const KNOWN_X_AUTHORS_BY_ID = new Map([
  ["1086145626633494528", { username: "_mohansolo", name: "Varun Mohan" }],
]);

function json(body, status = 200, headers = {}) {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...headers },
  });
}

function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function readBody(request) {
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shortAuthorSignature(authorName, authorHandle) {
  const handle = String(authorHandle || "").replace(/^@/, "").toLowerCase();
  if (handle === "_mohansolo") return "Varun";
  if (handle === "_anshulr") return "Anshul";
  if (handle === "antigravity") return "Antigravity";
  if (authorName && typeof authorName === "string") {
    return authorName.trim().split(/\s+/)[0];
  }
  return handle || "Antigravity";
}

export function formatExpectedUtcLabel(isoTimestamp) {
  if (!isoTimestamp) return null;
  const d = new Date(isoTimestamp);
  if (Number.isNaN(d.getTime())) return null;
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const mon = months[d.getUTCMonth()];
  const day = d.getUTCDate();
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${mon} ${day}, ${hh}:${mm} UTC`;
}

function siteDisplayHost(siteUrl) {
  try {
    return new URL(siteUrl).host;
  } catch {
    return "antigravity-resets.com";
  }
}

function telegramSourceQuote(item) {
  // Model summaries explain the event on the website; only original post text
  // belongs inside an attributed Telegram quote. Preserve its exact wording.
  if (typeof item.quoteText !== "string" || !item.quoteText.trim()) return [];
  const sig = shortAuthorSignature(item.authorName, item.authorHandle);
  return [`<blockquote>${escapeHtml(item.quoteText)}</blockquote>`, `- ${escapeHtml(sig)}`];
}

function telegramMessageWithQuotes(heading, quoteBlocks, footer) {
  const html = [heading, ...quoteBlocks, "", footer].join("\n");
  // Counting serialized HTML is conservative: Telegram limits text to 4096
  // characters after entity parsing. Keep the source link rather than alter a quote.
  return html.length <= 4096 ? html : [heading, "", footer].join("\n");
}

export function formatConfirmedTelegramHtml(reset, siteUrl = "https://antigravity-resets.com") {
  const host = siteDisplayHost(siteUrl);
  const heading =
    reset.type === "banked"
      ? "Antigravity banked reset confirmed"
      : "Antigravity reset confirmed";
  const quote = telegramSourceQuote(reset);
  return telegramMessageWithQuotes(
    `✅ <b>${escapeHtml(heading)}</b>`,
    quote.length ? ["", ...quote] : [],
    `<a href="${escapeHtml(reset.url)}">View on X</a> · Tracked by <a href="${escapeHtml(siteUrl)}">${escapeHtml(host)}</a>`,
  );
}

export function formatExpectedTelegramHtml(
  announcement,
  siteUrl = "https://antigravity-resets.com",
) {
  const host = siteDisplayHost(siteUrl);
  const etaLabel = formatExpectedUtcLabel(announcement.expectedBy);
  const isWatch = announcement.status === "possible";
  const heading = isWatch
    ? etaLabel
      ? `⚠️ <b>Possible Antigravity reset by ${escapeHtml(etaLabel)}</b>`
      : `⚠️ <b>Possible Antigravity reset</b>`
    : etaLabel
      ? `🗓 <b>Antigravity reset expected by ${escapeHtml(etaLabel)}</b>`
      : `🗓 <b>Antigravity reset expected time to be announced</b>`;

  const quote = telegramSourceQuote(announcement);
  const blocks = quote.length ? ["", ...quote] : [];

  const updates = Array.isArray(announcement.updates) ? announcement.updates : [];
  for (const upd of updates) {
    const updateQuote = telegramSourceQuote(upd);
    if (updateQuote.length) blocks.push("", "<i>Update:</i>", ...updateQuote);
  }

  const footerText = isWatch
    ? `<a href="${escapeHtml(announcement.url)}">View on X</a> · Track this watch on <a href="${escapeHtml(siteUrl)}">${escapeHtml(host)}</a>`
    : `<a href="${escapeHtml(announcement.url)}">View on X</a> · Track the announced reset on <a href="${escapeHtml(siteUrl)}">${escapeHtml(host)}</a>`;

  return telegramMessageWithQuotes(heading, blocks, footerText);
}

async function notifyEmailSubscribers(env, reset, fetchImpl = fetch, { isExpected = false } = {}) {
  if (!emailTransport(env) || !env?.DB) return;
  const siteUrl = (env.SITE_URL || "https://antigravity-resets.com").replace(/\/+$/, "");
  const etaLabel = isExpected ? formatExpectedUtcLabel(reset.expectedBy) : null;
  const kind = reset.type === "banked" ? "Antigravity banked reset" : "Antigravity reset";
  const subject = isExpected
    ? etaLabel
      ? `${kind} expected by ${etaLabel}`
      : `${kind} expected soon`
    : `${kind} confirmed`;

  let subscribers = [];
  try {
    subscribers = await listEmailSubscribers(env.DB);
  } catch {
    return;
  }
  for (const sub of subscribers) {
    const localized =
      reset.summary?.[sub.locale] ||
      reset.summary?.en ||
      reset.quoteText ||
      "Official Antigravity quota reset.";
    // Signed link: the unsubscribe endpoint rejects anything without a token.
    const unsubSecret = unsubscribeSecret(env);
    const unsubToken = unsubSecret
      ? await unsubscribeToken(unsubSecret, sub.email.toLowerCase())
      : "";
    const unsubUrl = unsubToken
      ? unsubscribeUrl(env, sub.email, unsubToken)
      : `${siteUrl}/api/v1/unsubscribe`;
    try {
      await deliverEmail(
        env,
        {
          to: sub.email,
          subject,
          text: `${subject}\n\n"${localized}"\n\nView on X: ${reset.url}\nLive tracker: ${siteUrl}\n\nUnsubscribe: ${unsubUrl}`,
        },
        fetchImpl,
      );
    } catch (err) {
      console.error(
        JSON.stringify({ event: "email_notify_failed", message: String(err) }),
      );
    }
  }
}

async function notifyAdminNeedsReview(env, { eventHash, item }, fetchImpl = fetch) {
  const botToken = env?.ADMIN_TELEGRAM_BOT_TOKEN || env?.TELEGRAM_BOT_TOKEN;
  const adminChatId = env?.ADMIN_TELEGRAM_CHAT_ID;
  if (!botToken || !adminChatId) return;

  const siteUrl = (env?.SITE_URL || "https://antigravity-resets.com").replace(/\/+$/, "");
  const t = item.tweet || {};
  const r = item.report || {};
  const dec = r.decisions;
  const fl = r.flash;
  const arb = r.arbitrator;

  const parentLine = t.isReply
    ? t.parentTweet
      ? `Parent (${t.parentTweet.authorHandle || "unknown"}): ${t.parentTweet.text}`
      : "Parent: UNAVAILABLE"
    : null;
  const quotedLine = t.quotedTweet
    ? `Quoted (${t.quotedTweet.authorHandle || "unknown"}): ${t.quotedTweet.text}`
    : null;

  const tier1Line = `Tier-1: Decisions(${dec?.ok ? `r=${dec.resetProb?.toFixed(2)}, rev=${dec.reviewProb?.toFixed(2)}, ${dec.type}` : "err"}) | Flash(${fl?.ok ? `r=${fl.isReset}, rev=${fl.needsReview}, ${fl.type}` : "err"})`;
  const tier2Line = arb
    ? `Tier-2 (${arb.model || "arbitrator"}): ${arb.ok ? `${arb.decision} (${arb.confidence?.toFixed(2)}) - ${arb.reason}` : `err: ${arb.error}`}`
    : null;

  const lines = [
    "[REVIEW NEEDED] Antigravity Resets",
    `Author: ${item.authorHandle} | Reason: ${r.consensus || "needs_review"}`,
    "",
    `Post: ${t.text || "(empty)"}`,
    parentLine,
    quotedLine,
    "",
    tier1Line,
    tier2Line,
    "",
    `Source: ${t.url || "n/a"}`,
    `Review API: ${siteUrl}/api/v1/admin/review`,
    `Resolve ref: eventHash=${eventHash} | tweetId=${item.tweetId}`,
  ].filter((line) => line !== null);

  try {
    await fetchImpl(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: adminChatId,
        text: lines.join("\n"),
        disable_web_page_preview: true,
      }),
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: "admin_telegram_notify_failed", message: String(err) }),
    );
  }
}

export async function handleXWebhook(request, env, ctx) {
  const url = new URL(request.url);
  if (url.pathname !== WEBHOOK_PATH) {
    return json({ error: "Not found" }, 404);
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405, { Allow: "GET, POST" });
  }

  // X recommends the app's OAuth 2.0 client secret. The API Secret Key
  // remains supported for OAuth 1.0 integrations. Never use a bearer token.
  if (request.method === "GET") {
    const token = url.searchParams.get("crc_token");
    if (!token) return json({ error: "Missing crc_token" }, 400);
    const secret = env?.X_OAUTH2_CLIENT_SECRET || env?.X_API_KEY_SECRET;
    if (!secret) return json({ error: "Webhook signing secret unavailable" }, 503);
    const signature = await crypto.subtle.sign(
      "HMAC",
      await importKey(secret),
      encoder.encode(token),
    );
    const base64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
    return json({ response_token: `sha256=${base64}` });
  }

  // Prefer the OAuth 2.0 header when present; an invalid preferred signature
  // must not fall back to a legacy signature. Verify the exact raw bytes.
  const oauth2 = request.headers.get("X-Twitter-Webhooks-Signature-OAuth2");
  const signature = oauth2 ?? request.headers.get("X-Twitter-Webhooks-Signature");
  const signatureScheme = oauth2 !== null ? "oauth2" : "oauth1";
  const match = signature?.match(/^sha256=([A-Za-z0-9+/]{43}=)$/);
  if (!match) return json({ error: "Invalid webhook signature" }, 401);
  const secret = oauth2 !== null ? env?.X_OAUTH2_CLIENT_SECRET : env?.X_API_KEY_SECRET;
  if (!secret) return json({ error: "Webhook signing secret unavailable" }, 503);
  const body = await readBody(request);
  if (body === null) return json({ error: "Webhook payload too large" }, 413);
  const signatureBytes = Uint8Array.from(atob(match[1]), (value) => value.charCodeAt(0));
  const valid = await crypto.subtle.verify(
    "HMAC",
    await importKey(secret),
    signatureBytes,
    body,
  );
  if (!valid) return json({ error: "Invalid webhook signature" }, 401);

  // Do not acknowledge and discard events when durable storage is unavailable.
  if (!env?.DB) {
    console.warn(JSON.stringify({ event: "x_webhook_processing_unconfigured" }));
    return json({ error: "Webhook event processing is not configured" }, 503, {
      "Retry-After": "60",
    });
  }

  const rawText = decoder.decode(body);
  let payload;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return json({ error: "Malformed JSON payload" }, 400);
  }

  const eventHash = await sha256Hex(body);
  const parsed = parseWebhookPayload(payload, { knownAuthorsById: KNOWN_X_AUTHORS_BY_ID });
  const tweets = parsed.tweets;
  const eventType = parsed.eventType;

  if (parsed.errors.length > 0) {
    console.error(
      JSON.stringify({
        event: "x_webhook_parse_error",
        eventHash,
        eventType,
        errors: parsed.errors,
      }),
    );
    try {
      await recordWebhookEventAndResets(env.DB, {
        eventHash,
        signatureScheme,
        eventType,
        primaryTweet: null,
        classifiedAs: "parse_error",
        judgeResult: { parseErrors: parsed.errors },
        classifiedResets: [],
        rawPayload: rawText,
      });
    } catch (storeErr) {
      console.error(
        JSON.stringify({
          event: "x_webhook_parse_error_store_failed",
          message: String(storeErr),
        }),
      );
    }
    return json(
      {
        ok: false,
        error: "Failed to parse declared post.create webhook payload",
        eventHash,
        eventType,
        tweetsSeen: tweets.length,
        diagnostics: parsed.errors,
      },
      422,
    );
  }

  const watchedHandles = parseWatchedHandles(env.WATCHED_X_HANDLES);
  const fetchImpl = env.__fetchImpl || fetch;

  const evaluations = await Promise.all(
    tweets.map(async (rawTweet) => {
      const verdict = await judgeResetTweet(rawTweet, { watchedHandles, env, fetchImpl });
      return {
        tweet: verdict.tweet || rawTweet,
        verdict,
      };
    }),
  );

  // If any watched tweet hit a retryable upstream judge failure,
  // return 503 Retry-After so X redelivers instead of silently dropping it.
  const retryable = evaluations.find((e) => e.verdict.status === "retryable_error");
  if (retryable) {
    console.warn(
      JSON.stringify({
        event: "x_webhook_judge_retryable_failure",
        tweetId: retryable.tweet.tweetId,
        report: retryable.verdict.report,
      }),
    );
    return json(
      {
        error: "Joint AI judge temporarily unavailable",
        consensus: retryable.verdict.report?.consensus || "unconfigured",
      },
      503,
      { "Retry-After": "60" },
    );
  }

  const classifiedResets = evaluations
    .filter((e) => e.verdict.status === "approved" && e.verdict.reset)
    .map((e) => e.verdict.reset);

  const announcedResets = evaluations
    .filter(
      (e) =>
        (e.verdict.status === "expected" || e.verdict.status === "possible") &&
        e.verdict.announcement,
    )
    .map((e) => e.verdict.announcement);

  const needsReviewCount = evaluations.filter(
    (e) => e.verdict.status === "needs_review",
  ).length;

  const overallClass =
    (classifiedResets.length > 0 || announcedResets.length > 0) && needsReviewCount > 0
      ? "mixed_needs_review"
      : classifiedResets.length > 0
        ? classifiedResets[0].type
        : announcedResets.length > 0
          ? announcedResets[0].status === "possible"
            ? "possible"
            : "expected"
          : needsReviewCount > 0
            ? "needs_review"
            : "rejected";

  const judgeResult = evaluations.map((e) => ({
    tweetId: e.tweet.tweetId,
    authorHandle: e.tweet.authorHandle,
    status: e.verdict.status,
    tweet: {
      tweetId: e.tweet.tweetId,
      authorHandle: e.tweet.authorHandle,
      text: e.tweet.text,
      url: e.tweet.url,
      isReply: e.tweet.isReply,
      replyToTweetId: e.tweet.replyToTweetId || null,
      parentTweet: e.tweet.parentTweet || null,
      quotedTweet: e.tweet.quotedTweet || null,
    },
    report: e.verdict.report,
  }));

  try {
    const { inserted, insertedAnnouncements, eventInserted } =
      await recordWebhookEventAndResets(env.DB, {
        eventHash,
        signatureScheme,
        eventType,
        primaryTweet: evaluations[0]?.tweet || tweets[0] || null,
        classifiedAs: overallClass,
        judgeResult,
        classifiedResets,
        announcedResets,
        rawPayload: rawText,
      });

    if (ctx?.waitUntil) {
      ctx.waitUntil(drainTelegramOutbox(env, { fetchImpl }));
      if (inserted.length > 0) {
        for (const reset of inserted) {
          ctx.waitUntil(notifyEmailSubscribers(env, reset, fetchImpl));
        }
      }
      if (insertedAnnouncements.length > 0) {
        for (const ann of insertedAnnouncements) {
          ctx.waitUntil(
            notifyEmailSubscribers(env, ann, fetchImpl, { isExpected: true }),
          );
        }
      }
      if (eventInserted && needsReviewCount > 0) {
        for (const item of judgeResult.filter((j) => j.status === "needs_review")) {
          ctx.waitUntil(notifyAdminNeedsReview(env, { eventHash, item }, fetchImpl));
        }
      }
    }

    return json({
      ok: true,
      eventHash,
      eventType,
      tweetsSeen: tweets.length,
      resetsRecorded: inserted.length,
      expectedRecorded: insertedAnnouncements.length,
      needsReview: needsReviewCount,
      classification: overallClass,
    });
  } catch (err) {
    console.error(
      JSON.stringify({ event: "x_webhook_store_failed", message: String(err) }),
    );
    return json({ error: "Failed to persist webhook event" }, 503, {
      "Retry-After": "60",
    });
  }
}

export default {
  fetch: handleXWebhook,
};
