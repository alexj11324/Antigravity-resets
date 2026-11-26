import { OFFICIAL_ACCOUNTS, computeStats } from "./seed-data.mjs";
import {
  addEmailSubscription,
  addPushSubscription,
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

async function readJsonBody(request, maxBytes = 64 * 1024) {
  const text = await request.text();
  if (text.length > maxBytes) {
    return { error: "Payload too large", status: 413 };
  }
  if (!text) return { data: {} };
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
          `      <description>${escapeXml(r.summary?.en || "")}</description>`,
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
    const result = await addEmailSubscription(env?.DB, { email, locale });
    return json({ ok: true, ...result }, 201);
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

  // GET / POST /api/v1/unsubscribe — remove email alert subscription
  if (
    pathname === "/api/v1/unsubscribe" &&
    (request.method === "POST" || request.method === "GET")
  ) {
    let email = "";
    if (request.method === "GET") {
      email = (url.searchParams.get("email") || "").trim();
    } else {
      const parsed = await readJsonBody(request);
      if (parsed.error) return json({ error: parsed.error }, parsed.status);
      email = typeof parsed.data.email === "string" ? parsed.data.email.trim() : "";
    }
    if (!email || !EMAIL_RE.test(email) || email.length > 254) {
      return json({ error: "Invalid email address" }, 400);
    }
    const result = await removeEmailSubscription(env?.DB, email);
    return json({ ok: true, ...result });
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
