import { OFFICIAL_ACCOUNTS, computeStats } from "./seed-data.mjs";
import {
  addEmailSubscription,
  addPushSubscription,
  confirmEmailSubscription,
  createManualReset,
  getActiveExpectedReset,
  getOnlineCount,
  incrementThanks,
  listResets,
  listReviewEvents,
  recordPresence,
  removeEmailSubscription,
  resolveReviewEvent,
} from "./store.mjs";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...CORS_HEADERS,
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Dedicated secret for email link tokens.
 *
 * Deliberately does NOT fall back to X_OAUTH2_CLIENT_SECRET. Reusing the
 * webhook signing key here would turn the subscribe endpoint into an HMAC
 * oracle over that key: a caller controls the message (the address) and reads
 * the signature back. No secret means the feature is unavailable, not
 * silently weaker.
 */
export function unsubscribeSecret(env) {
  return env?.EMAIL_UNSUBSCRIBE_SECRET || "";
}

/**
 * Deterministic per-address token. Derived, never stored, so existing
 * subscribers get a working link without a migration.
 * @param {string} secret
 * @param {string} email already normalized to lowercase
 */
export async function hmacToken(secret, message) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function unsubscribeToken(secret, email) {
  return hmacToken(secret, `unsubscribe:\n${email}`);
}

/**
 * Confirmation tokens carry a prefix so a confirmation link can never be
 * replayed as an unsubscribe link, or the reverse.
 */
async function confirmEmailToken(secret, email) {
  return hmacToken(secret, `confirm:${email}`);
}

function htmlPage(status, message) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Antigravity Resets</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem;line-height:1.6"><h1 style="font-size:1.35rem">Antigravity Resets</h1><p>${message}</p><p><a href="https://antigravity-resets.com/">Back to the tracker</a></p></body></html>`,
    {
      status,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    },
  );
}

async function sendConfirmationEmail(env, email, token) {
  const site = (env?.SITE_URL || "https://antigravity-resets.com").replace(/\/+$/, "");
  const confirmUrl = `${site}/api/v1/confirm?email=${encodeURIComponent(email)}&token=${token}`;
  await deliverEmail(env, {
    to: email,
    subject: "Confirm your Antigravity reset alerts",
    html:
      "<p>Someone (hopefully you) asked Antigravity Resets to email reset alerts to this address.</p>" +
      `<p><a href="${confirmUrl}">Confirm subscription</a></p>` +
      "<p>If this was not you, ignore this email and nothing will be sent.</p>",
  });
}

function confirmFormPage(email, token) {
  const action = `/api/v1/confirm?email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}`;
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Confirm your subscription</title></head><body style="font-family:system-ui,-apple-system,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1.25rem;line-height:1.6"><h1 style="font-size:1.35rem">Antigravity Resets</h1><p>Confirm that you want reset alerts sent to <strong>${escapeXml(email)}</strong>.</p><form method="post" action="${action}"><button type="submit" style="font:inherit;font-weight:700;padding:10px 18px;border:2px solid #26201a;border-radius:10px;background:#ffd84d;cursor:pointer">Confirm subscription</button></form><p style="color:#5c5347">If this was not you, close this page and nothing will be sent.</p></body></html>`,
    {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
        "Referrer-Policy": "no-referrer",
      },
    },
  );
}

async function verifyConfirmLink(url, env) {
  const secret = unsubscribeSecret(env);
  if (!secret) {
    return { status: 503, error: "Email confirmation is not configured on this deployment." };
  }
  const email = (url.searchParams.get("email") || "").trim();
  const token = (url.searchParams.get("token") || "").trim();
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return { status: 400, error: "This confirmation link is incomplete." };
  }
  const expected = await confirmEmailToken(secret, email.toLowerCase());
  if (!token || !timingSafeEqual(token, expected)) {
    return { status: 403, error: "This confirmation link is invalid. Please subscribe again." };
  }
  return { email, token };
}

/** Which outbound transport this deployment has, if any. */
export function emailTransport(env) {
  if (env?.EMAIL && typeof env.EMAIL.send === "function") return "cloudflare";
  if (env?.RESEND_API_KEY && env?.RESEND_FROM_EMAIL) return "resend";
  return "";
}

/**
 * Send one message through whichever transport is configured.
 *
 * Cloudflare Email Sending (the `send_email` binding) is preferred when
 * present: on Workers Paid it is 3,000/month with no daily cap. Resend stays as
 * the fallback for deployments that have not onboarded that binding.
 *
 * @param {object} env
 * @param {{to: string, subject: string, html?: string, text?: string, from?: string}} message
 * @param {typeof fetch} [fetchImpl] injectable for tests
 */
export async function deliverEmail(env, message, fetchImpl = fetch) {
  const transport = emailTransport(env);
  if (transport === "cloudflare") {
    await env.EMAIL.send({
      to: message.to,
      from:
        message.from ||
        env.EMAIL_FROM ||
        env.RESEND_FROM_EMAIL ||
        "alerts@antigravity-resets.com",
      subject: message.subject,
      ...(message.html ? { html: message.html } : {}),
      ...(message.text ? { text: message.text } : {}),
    });
    return;
  }
  if (transport === "resend") {
    const res = await fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: message.from || env.RESEND_FROM_EMAIL,
        to: [message.to],
        subject: message.subject,
        ...(message.html ? { html: message.html } : {}),
        ...(message.text ? { text: message.text } : {}),
      }),
    });
    if (!res.ok) throw new Error(`resend ${res.status}`);
    return;
  }
  throw new Error("No email transport configured");
}

export function unsubscribeUrl(env, email, token) {
  const site = (env?.SITE_URL || "https://antigravity-resets.com").replace(/\/+$/, "");
  return `${site}/api/v1/unsubscribe?email=${encodeURIComponent(email)}&token=${token}`;
}

function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Enforce the size cap while reading, not after. `request.text()` buffers the
 * whole body first, so a client could force arbitrary memory use before the
 * 413. Content-Length is checked up front and the stream is abandoned the
 * moment the byte budget is exceeded.
 */
async function readJsonBody(request, maxBytes = 64 * 1024) {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { error: "Payload too large", status: 413 };
  }
  if (!request.body) return { data: {} };

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { error: "Payload too large", status: 413 };
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }

  if (total === 0) return { data: {} };
  const text = new TextDecoder().decode(concatChunks(chunks, total));
  try {
    return { data: JSON.parse(text) };
  } catch {
    return { error: "Invalid JSON body", status: 400 };
  }
}

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatCompactAge(isoTimestamp) {
  if (!isoTimestamp) return "unknown";
  const diffMin = Math.max(0, Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 60000));
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export async function handleApiRequest(request, env) {
  const url = new URL(request.url);
  const { pathname } = url;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // GET /feed.xml | /rss.xml | /api/v1/feed.xml — public RSS 2.0 feed of verified resets
  if (
    (pathname === "/feed.xml" || pathname === "/rss.xml" || pathname === "/api/v1/feed.xml") &&
    request.method === "GET"
  ) {
    const siteUrl = (env?.SITE_URL || "https://antigravity-resets.com").replace(/\/+$/, "");
    const resets = await listResets(env?.DB, { limit: 30 });
    const itemsXml = resets
      .map((r) => {
        const label = r.type === "banked" ? "Banked Reset" : "Regular Reset";
        const pubDate = new Date(r.timestamp).toUTCString();
        return [
          "    <item>",
          `      <title>${escapeXml(`Antigravity ${label} (${r.authorHandle})`)}</title>`,
          `      <link>${escapeXml(r.url)}</link>`,
          `      <guid isPermaLink="false">${escapeXml(r.id)}</guid>`,
          `      <pubDate>${escapeXml(pubDate)}</pubDate>`,
          `      <description>${escapeXml(r.quoteText || "")}</description>`,
          "    </item>",
        ].join("\n");
      })
      .join("\n");

    const rss = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<rss version="2.0">',
      "  <channel>",
      "    <title>Antigravity Resets</title>",
      `    <link>${escapeXml(siteUrl)}</link>`,
      "    <description>Official Google Antigravity Gemini quota reset announcements.</description>",
      "    <language>en</language>",
      itemsXml,
      "  </channel>",
      "</rss>",
    ].join("\n");

    return new Response(rss, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // GET /api/v1/badge.svg — embeddable live SVG status badge
  if (pathname === "/api/v1/badge.svg" && request.method === "GET") {
    const resets = await listResets(env?.DB, { limit: 1 });
    const latest = resets[0] || null;
    const valueText = latest ? formatCompactAge(latest.timestamp) : "none";
    const labelText = "antigravity reset";
    const labelW = 114;
    const valueW = Math.max(66, valueText.length * 8 + 18);
    const totalW = labelW + valueW;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="22" role="img" aria-label="${escapeXml(labelText)}: ${escapeXml(valueText)}"><rect width="${totalW}" height="22" rx="6" fill="#26201a"/><rect x="1.5" y="1.5" width="${labelW - 1.5}" height="19" rx="4.5" fill="#fffdf7"/><rect x="${labelW}" y="1.5" width="${valueW - 1.5}" height="19" rx="4.5" fill="#ffd94a"/><text x="${labelW / 2}" y="14.5" fill="#26201a" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10.5" font-weight="700" text-anchor="middle">${escapeXml(labelText)}</text><text x="${labelW + valueW / 2}" y="14.5" fill="#26201a" font-family="ui-monospace,SFMono-Regular,Menlo,monospace" font-size="10.5" font-weight="700" text-anchor="middle">${escapeXml(valueText)}</text></svg>`;
    return new Response(svg, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "image/svg+xml; charset=utf-8",
        "Cache-Control": "public, max-age=60",
      },
    });
  }

  // GET /api/v1/status — public keyless live reset status
  if (pathname === "/api/v1/status" && request.method === "GET") {
    const [resets, online, upcomingReset] = await Promise.all([
      listResets(env?.DB),
      getOnlineCount(env?.DB),
      getActiveExpectedReset(env?.DB),
    ]);
    const stats = computeStats(resets);
    return json(
      {
        service: "antigravity-resets",
        watchedAccounts: [OFFICIAL_ACCOUNTS.leadHandle, OFFICIAL_ACCOUNTS.teamHandle],
        latest: stats.latest,
        upcomingReset,
        stats: {
          totalResets: stats.total,
          avgIntervalDays: stats.avgIntervalDays,
          longestWaitDays: stats.longestWaitDays,
          regularCount: stats.regularCount,
          bankedCount: stats.bankedCount,
        },
        thanksCount: stats.latest?.thanksCount ?? 0,
        onlineCount: online,
        storage: env?.DB ? "d1" : "seed",
        generatedAt: new Date().toISOString(),
      },
      200,
      { "Cache-Control": "public, max-age=15" },
    );
  }

  // GET /api/v1/resets — full reset history
  if (pathname === "/api/v1/resets" && request.method === "GET") {
    const typeParam = url.searchParams.get("type");
    const limitParam = Number(url.searchParams.get("limit"));
    const limit =
      Number.isInteger(limitParam) && limitParam > 0 && limitParam <= 200
        ? limitParam
        : null;
    const resets = await listResets(env?.DB, {
      type: typeParam === "regular" || typeParam === "banked" ? typeParam : null,
      limit,
    });
    const stats = computeStats(resets);
    return json(
      {
        count: resets.length,
        stats: {
          totalResets: stats.total,
          avgIntervalDays: stats.avgIntervalDays,
          longestWaitDays: stats.longestWaitDays,
        },
        resets,
      },
      200,
      { "Cache-Control": "public, max-age=15" },
    );
  }

  // POST /api/v1/thanks — increment reaction count (supports rapid multi-tap batches)
  if (pathname === "/api/v1/thanks" && request.method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const { resetId = null, delta = 1 } = parsed.data;
    const clamped = Math.max(-1, Math.min(50, Math.trunc(Number(delta) || 1)));
    const updated = await incrementThanks(env?.DB, resetId, clamped);
    if (!updated) return json({ error: "Reset not found" }, 404);
    return json({ ok: true, ...updated });
  }

  // POST /api/v1/presence — lightweight online viewer heartbeat
  if (pathname === "/api/v1/presence" && request.method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const result = await recordPresence(env?.DB, parsed.data.sessionId);
    return json({ ok: true, onlineCount: result.online });
  }

  // POST /api/v1/subscribe/email — subscribe to reset alerts
  if (pathname === "/api/v1/subscribe/email" && request.method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const email = typeof parsed.data.email === "string" ? parsed.data.email.trim() : "";
    const locale = typeof parsed.data.locale === "string" ? parsed.data.locale.slice(0, 10) : "en";
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return json({ error: "Invalid email address" }, 400);
    }

    const normalized = email.trim().toLowerCase();
    const secret = unsubscribeSecret(env);
    const transport = emailTransport(env);

    // Fail closed. No dedicated secret means no signed links; no transport means
    // nothing can ever be delivered. Either way an address stored here could
    // never be verified or served, so do not accept it.
    if (!secret || !transport) {
      return json({ error: "Email alerts are not available right now" }, 503);
    }

    // Abuse controls. Without these the endpoint is an open relay that will
    // mail any address a stranger types in.
    if (env?.DB) {
      const existing = await env.DB.prepare(
        "SELECT confirmed, confirmation_sent_at FROM email_subscriptions WHERE email = ?",
      )
        .bind(normalized)
        .first();

      if (Number(existing?.confirmed) === 1) {
        // Already active. Sending another confirmation would only be noise.
        return json({ ok: true, pendingConfirmation: false }, 200);
      }

      // Fast reject for a repeat submit, before any write. It keeps the common
      // abuse path -- posting one address over and over -- at zero cost and
      // zero rows. Advisory only: the conditional UPDATE below decides.
      const cooldownCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      if (existing?.confirmation_sent_at && existing.confirmation_sent_at >= cooldownCutoff) {
        return json({ ok: true, pendingConfirmation: true }, 202);
      }
    }

    // Spend the shared hourly budget before creating any state. A request
    // refused here mails nothing, so it must leave no trace: no pending row and
    // no cooldown. Creating the row first let an exhausted hour keep growing
    // email_subscriptions without bound, since only before-the-budget writes
    // create rows and the reservation is what caps them.
    let windowStart = "";
    if (env?.DB) {
      // Conditional increment, not a row count: repeat submits used to slip past
      // a count, and the increment stays correct under concurrency.
      windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO email_send_log (window_start, sent) VALUES (?, 0)",
      )
        .bind(windowStart)
        .run();
      const reservation = await env.DB.prepare(
        "UPDATE email_send_log SET sent = sent + 1 WHERE window_start = ? AND sent < 100",
      )
        .bind(windowStart)
        .run();
      if (Number(reservation?.meta?.changes || 0) === 0) {
        return json({ error: "Too many subscription attempts right now" }, 429);
      }
    }

    // The row must exist before the claim below; a first-time address has none.
    await addEmailSubscription(env?.DB, { email: normalized, locale, confirmed: 0 });

    if (env?.DB) {
      // The claim is the authority, not the advisory read above: two concurrent
      // requests can both pass the read and both reach here. Only the request
      // that wins the row dispatches mail.
      const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const claim = await env.DB.prepare(
        "UPDATE email_subscriptions SET confirmation_sent_at = ? " +
          "WHERE email = ? AND (confirmation_sent_at IS NULL OR confirmation_sent_at < ?)",
      )
        .bind(new Date().toISOString(), normalized, cutoff)
        .run();
      if (Number(claim?.meta?.changes || 0) === 0) {
        // Lost a race with a request for the same address. This one mails
        // nothing, so it must not spend shared budget: refund the slot.
        await env.DB.prepare(
          "UPDATE email_send_log SET sent = sent - 1 WHERE window_start = ? AND sent > 0",
        )
          .bind(windowStart)
          .run();
        return json({ ok: true, pendingConfirmation: true }, 202);
      }
    }

    const token = await confirmEmailToken(secret, normalized);
    try {
      await sendConfirmationEmail(env, normalized, token);
    } catch {
      // The row stays pending; the visitor can submit again once the cooldown
      // lapses. We keep the claim so a failing mailer cannot be hammered.
      return json({ error: "Could not send the confirmation email" }, 502);
    }

    // 202: accepted, not active. The signed links live only in the mail, so this
    // endpoint never hands a token to an unauthenticated caller.
    return json({ ok: true, pendingConfirmation: true }, 202);
  }

  // GET /api/v1/confirm — renders the confirmation page. Deliberately does NOT
  // change state: mail clients and security scanners prefetch links, and a
  // state-changing GET would let them complete the opt-in on the user's behalf.
  if (pathname === "/api/v1/confirm" && request.method === "GET") {
    const check = await verifyConfirmLink(url, env);
    if (check.error) return htmlPage(check.status, check.error);
    return confirmFormPage(check.email, check.token);
  }

  // POST /api/v1/confirm — the only place a subscription becomes active.
  if (pathname === "/api/v1/confirm" && request.method === "POST") {
    const check = await verifyConfirmLink(url, env);
    if (check.error) return htmlPage(check.status, check.error);
    await confirmEmailSubscription(env?.DB, check.email);
    return htmlPage(
      200,
      "You are subscribed. Antigravity reset alerts will arrive at this address, and every alert email includes a one-click unsubscribe link.",
    );
  }

  // POST /api/v1/subscribe/push — store Web Push subscription
  if (pathname === "/api/v1/subscribe/push" && request.method === "POST") {
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const { endpoint, keys, locale = "en" } = parsed.data;
    if (
      typeof endpoint !== "string" ||
      !endpoint.startsWith("https://") ||
      typeof keys?.p256dh !== "string" ||
      typeof keys?.auth !== "string"
    ) {
      return json({ error: "Invalid push subscription payload" }, 400);
    }
    const result = await addPushSubscription(env?.DB, {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      locale: typeof locale === "string" ? locale.slice(0, 10) : "en",
    });
    return json({ ok: true, ...result }, 201);
  }

  // GET / POST /api/v1/unsubscribe — remove an email alert subscription.
  // Requires the per-address HMAC token issued at subscribe time: without it a
  // plain image tag or link could unsubscribe any address (CSRF), and the
  // response must not disclose whether that address was subscribed at all.
  if (
    pathname === "/api/v1/unsubscribe" &&
    (request.method === "POST" || request.method === "GET")
  ) {
    const secret = unsubscribeSecret(env);
    if (!secret) {
      return json({ error: "Unsubscribe is not configured" }, 503);
    }

    let email = "";
    let token = "";
    if (request.method === "GET") {
      email = (url.searchParams.get("email") || "").trim();
      token = (url.searchParams.get("token") || "").trim();
    } else {
      const parsed = await readJsonBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      email = typeof parsed.data.email === "string" ? parsed.data.email.trim() : "";
      token = typeof parsed.data.token === "string" ? parsed.data.token.trim() : "";
    }
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return json({ error: "Invalid email address" }, 400);
    }

    const expected = await unsubscribeToken(secret, email.toLowerCase());
    if (!token || !timingSafeEqual(token, expected)) {
      return json({ error: "Invalid or missing unsubscribe token" }, 403);
    }

    await removeEmailSubscription(env?.DB, email);
    // Generic response on purpose: revealing `removed` would let anyone probe
    // whether a given address is subscribed.
    return json({ ok: true });
  }

  // POST /api/v1/admin/review/resolve — approve or dismiss a pending needs_review item
  if (pathname === "/api/v1/admin/review/resolve" && request.method === "POST") {
    const token = env?.ADMIN_API_TOKEN;
    if (!token) {
      return json({ error: "Admin API token is not configured" }, 503);
    }
    const authHeader = request.headers.get("Authorization") || "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqual(provided, token)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!env?.DB) {
      return json({ error: "Durable storage is not configured" }, 503);
    }
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const { eventHash, tweetId = null, action, type = "regular", summary = null, models = null } =
      parsed.data;
    if (!eventHash || (action !== "approve" && action !== "dismiss")) {
      return json({ error: "Provide eventHash and action (approve|dismiss)" }, 400);
    }
    if (action === "approve" && type !== "regular" && type !== "banked") {
      return json({ error: "Provide valid type (regular|banked)" }, 400);
    }
    const resolved = await resolveReviewEvent(env.DB, {
      eventHash,
      tweetId,
      action,
      type,
      summary,
      models,
    });
    if (!resolved || resolved.notFoundPending) {
      return json({ error: "Pending review item not found" }, 404);
    }
    return json({ ok: true, ...resolved });
  }

  // GET /api/v1/admin/review — list webhook disagreements held for human review
  if (pathname === "/api/v1/admin/review" && request.method === "GET") {
    const token = env?.ADMIN_API_TOKEN;
    if (!token) {
      return json({ error: "Admin API token is not configured" }, 503);
    }
    const authHeader = request.headers.get("Authorization") || "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqual(provided, token)) {
      return json({ error: "Unauthorized" }, 401);
    }
    const items = await listReviewEvents(env?.DB, 25);
    return json({ count: items.length, items });
  }

  // POST /api/v1/admin/resets — authenticated manual announcement entry
  if (pathname === "/api/v1/admin/resets" && request.method === "POST") {
    const token = env?.ADMIN_API_TOKEN;
    if (!token) {
      return json({ error: "Admin API token is not configured" }, 503);
    }
    const authHeader = request.headers.get("Authorization") || "";
    const provided = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
    if (!timingSafeEqual(provided, token)) {
      return json({ error: "Unauthorized" }, 401);
    }
    if (!env?.DB) {
      return json({ error: "Durable storage is not configured" }, 503);
    }
    const parsed = await readJsonBody(request);
    if (parsed.error) return json({ error: parsed.error }, parsed.status);
    const {
      id,
      tweetId = null,
      timestamp = new Date().toISOString(),
      type = "regular",
      authorHandle = OFFICIAL_ACCOUNTS.leadHandle,
      authorName = OFFICIAL_ACCOUNTS.leadName,
      models = ["Gemini"],
      url: postUrl = OFFICIAL_ACCOUNTS.leadUrl,
      summary,
    } = parsed.data;

    if ((type !== "regular" && type !== "banked") || !summary?.en) {
      return json({ error: "Provide valid type (regular|banked) and summary.en" }, 400);
    }

    const record = await createManualReset(env.DB, {
      id: id || `manual-${Date.now()}`,
      tweetId,
      timestamp: new Date(timestamp).toISOString(),
      type,
      authorHandle,
      authorName,
      models,
      url: postUrl,
      summary,
    });
    return json({ ok: true, reset: record }, 201);
  }

  return json({ error: "Not found" }, 404);
}
