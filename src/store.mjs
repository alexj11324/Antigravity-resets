import { SEED_RESETS } from "./seed-data.mjs";

const PRESENCE_TTL_MS = 90 * 1000;
const seedQuotesByTweetId = new Map(SEED_RESETS.map(({ tweetId, quoteText }) => [tweetId, quoteText]));

/**
 * Original post text for a seeded announcement, by source tweet id. Existing
 * deployments predate storing quote_text, so the translation backfill resolves
 * the source from here instead of forcing a data migration.
 * @param {string} tweetId
 * @returns {string|null}
 */
export function seedQuoteFor(tweetId) {
  return seedQuotesByTweetId.get(tweetId) || null;
}

function rowToReset(row) {
  let models = ["All Antigravity models"];
  let summary = { en: row.summary_en };
  let judgeSummary = null;
  let textI18n = null;
  try {
    const parsedModels = JSON.parse(row.models_json || "[]");
    if (Array.isArray(parsedModels) && parsedModels.length > 0) {
      models = parsedModels;
    }
  } catch {
    // keep default
  }
  try {
    const parsedI18n = JSON.parse(row.summary_i18n_json || "{}");
    if (parsedI18n && typeof parsedI18n === "object") {
      summary = { en: row.summary_en, ...parsedI18n };
    }
  } catch {
    // keep default
  }
  try {
    const parsedText = JSON.parse(row.text_i18n_json || "null");
    if (parsedText && typeof parsedText === "object") {
      const clean = {};
      for (const [locale, value] of Object.entries(parsedText)) {
        if (typeof value === "string" && value.trim()) clean[locale] = value;
      }
      textI18n = Object.keys(clean).length > 0 ? clean : null;
    }
  } catch {
    textI18n = null;
  }
  if (row.judge_summary_json) {
    try {
      judgeSummary = JSON.parse(row.judge_summary_json);
    } catch {
      judgeSummary = null;
    }
  }

  return {
    id: row.id,
    tweetId: row.tweet_id || null,
    timestamp: row.timestamp,
    type: row.type,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    models,
    url: row.url,
    quoteText: row.quote_text?.trim() ? row.quote_text : seedQuotesByTweetId.get(row.tweet_id) ?? null,
    textI18n,
    summary,
    judgeSummary,
    thanksCount: Number(row.thanks_count || 0),
    source: row.source || "seed",
  };
}

export async function ensureSeeded(db) {
  if (!db) return;
  const countRow = await db
    .prepare("SELECT COUNT(*) AS count FROM resets")
    .first();
  if (Number(countRow?.count || 0) > 0) return;

  const stmt = db.prepare(
    `INSERT OR IGNORE INTO resets
      (id, tweet_id, timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, quote_text, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const item of SEED_RESETS) {
    await stmt
      .bind(
        item.id,
        item.tweetId,
        item.timestamp,
        item.type,
        item.authorHandle,
        item.authorName,
        JSON.stringify(item.models),
        item.url,
        item.summary.en,
        JSON.stringify(item.summary),
        null,
        item.thanksCount,
        item.quoteText ?? null,
        item.source,
      )
      .run();
  }
}

export async function listResets(db, { type = null, limit = null } = {}) {
  if (!db) {
    let items = [...SEED_RESETS].sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
    if (type === "regular" || type === "banked") {
      items = items.filter((r) => r.type === type);
    }
    if (limit && limit > 0) {
      items = items.slice(0, limit);
    }
    return items;
  }

  await ensureSeeded(db);

  let sql = "SELECT * FROM resets";
  const bindings = [];
  if (type === "regular" || type === "banked") {
    sql += " WHERE type = ?";
    bindings.push(type);
  }
  sql += " ORDER BY timestamp DESC";
  if (limit && limit > 0) {
    sql += " LIMIT ?";
    bindings.push(limit);
  }

  const prepared = db.prepare(sql);
  const res = bindings.length > 0 ? await prepared.bind(...bindings).all() : await prepared.all();
  return (res.results || []).map(rowToReset);
}

function rowToAnnouncement(row) {
  if (!row) return null;
  let summary = { en: row.quote_text };
  let updates = [];
  let judgeSummary = null;
  try {
    const parsedI18n = JSON.parse(row.summary_i18n_json || "{}");
    if (parsedI18n && typeof parsedI18n === "object") {
      summary = { en: row.quote_text, ...parsedI18n };
    }
  } catch {
    // keep default
  }
  try {
    const parsedUpdates = JSON.parse(row.updates_json || "[]");
    if (Array.isArray(parsedUpdates)) updates = parsedUpdates;
  } catch {
    updates = [];
  }
  if (row.judge_summary_json) {
    try {
      judgeSummary = JSON.parse(row.judge_summary_json);
    } catch {
      judgeSummary = null;
    }
  }
  return {
    id: row.id,
    tweetId: row.tweet_id || null,
    announcedAt: row.announced_at,
    expectedBy: row.expected_by || null,
    type: row.type,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    url: row.url,
    quoteText: row.quote_text,
    updates,
    summary,
    judgeSummary,
    telegramMessageId: row.telegram_message_id || null,
    status: row.status || "expected",
  };
}

export async function getActiveExpectedReset(db) {
  if (!db) return null;
  try {
    const row = await db
      .prepare(
        "SELECT * FROM announced_resets WHERE status IN ('expected', 'possible') ORDER BY announced_at DESC LIMIT 1",
      )
      .first();
    return rowToAnnouncement(row);
  } catch {
    return null;
  }
}

export async function setAnnouncementTelegramMessageId(db, announcementId, messageId) {
  if (!db || !announcementId || !messageId) return;
  try {
    await db
      .prepare("UPDATE announced_resets SET telegram_message_id = ? WHERE id = ?")
      .bind(String(messageId), announcementId)
      .run();
  } catch {
    // non-fatal
  }
}

export async function recordWebhookEventAndResets(
  db,
  {
    eventHash,
    signatureScheme,
    eventType,
    primaryTweet,
    classifiedAs = null,
    judgeResult = null,
    classifiedResets = [],
    announcedResets = [],
    rawPayload,
  },
) {
  if (!db) {
    throw new Error("Durable D1 binding (env.DB) is not configured");
  }
  await ensureSeeded(db);

  const classLabel =
    classifiedAs || classifiedResets[0]?.type || (announcedResets[0] ? "expected" : null);
  const eventRes = await db
    .prepare(
      `INSERT OR IGNORE INTO x_webhook_events
        (event_hash, signature_scheme, event_type, tweet_id, author_handle, classified_as, judge_result_json, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      eventHash,
      signatureScheme,
      eventType,
      primaryTweet?.tweetId || null,
      primaryTweet?.authorHandle || null,
      classLabel,
      judgeResult ? JSON.stringify(judgeResult) : null,
      rawPayload,
    )
    .run();
  const eventInserted = (eventRes?.meta?.changes ?? 0) > 0;

  const inserted = [];
  const insertReset = db.prepare(
    `INSERT OR IGNORE INTO resets
      (id, tweet_id, timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, source, quote_text)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const item of classifiedResets) {
    const res = await insertReset
      .bind(
        item.id,
        item.tweetId,
        item.timestamp,
        item.type,
        item.authorHandle,
        item.authorName,
        JSON.stringify(item.models),
        item.url,
        item.summary.en,
        JSON.stringify(item.summary),
        item.judgeSummary ? JSON.stringify(item.judgeSummary) : null,
        0,
        item.source || "x_webhook_joint_ai",
        item.quoteText ?? "",
      )
      .run();
    const changes = res?.meta?.changes ?? 0;
    if (changes > 0) {
      inserted.push(item);
      // Automatically mark any earlier pending expected/possible reset announcements as confirmed.
      try {
        await db
          .prepare(
            "UPDATE announced_resets SET status = 'confirmed', confirmed_reset_id = ? WHERE status IN ('expected', 'possible') AND announced_at <= ?",
          )
          .bind(item.id, item.timestamp)
          .run();
      } catch {
        // non-fatal if table not yet migrated
      }
    }
  }

  const insertedAnnouncements = [];
  if (announcedResets.length > 0) {
    const insertAnnouncement = db.prepare(
      `INSERT OR IGNORE INTO announced_resets
        (id, tweet_id, announced_at, expected_by, type, author_handle, author_name, url, quote_text, updates_json, summary_i18n_json, judge_summary_json, status, telegram_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    );
    for (const ann of announcedResets) {
      const annStatus = ann.status === "possible" ? "possible" : "expected";

      // If a second `possible` watch hint arrives while an active `possible` watch exists,
      // append it as an `Update:` block on the existing watch (matching Codex Resets Alert).
      if (annStatus === "possible") {
        // Updates live inside the first watch's JSON, including after confirmation.
        // Check that history before considering a new active watch on redelivery.
        const seen = await db
          .prepare(
            `SELECT id FROM announced_resets
             WHERE tweet_id = ? OR EXISTS (
               SELECT 1 FROM json_each(announced_resets.updates_json) AS watch_update
               WHERE json_extract(watch_update.value, '$.tweetId') = ?
             ) LIMIT 1`,
          )
          .bind(ann.tweetId, ann.tweetId)
          .first();
        if (seen) continue;

        const existingRaw = await db
          .prepare(
            "SELECT * FROM announced_resets WHERE status = 'possible' ORDER BY announced_at DESC LIMIT 1",
          )
          .first();
        const existing = rowToAnnouncement(existingRaw);
        if (existing) {
          const alreadyHas =
            existing.tweetId === ann.tweetId ||
            existing.updates.some((u) => u.tweetId === ann.tweetId);
          if (alreadyHas) continue;

          // Append against the current row in SQLite, not the earlier read:
          // concurrent webhook updates must not erase one another's quotes.
          const update = {
            tweetId: ann.tweetId,
            announcedAt: ann.announcedAt,
            authorHandle: ann.authorHandle,
            authorName: ann.authorName,
            url: ann.url,
            quoteText: ann.quoteText,
          };
          const updatedRaw = await db
            .prepare(
              `UPDATE announced_resets SET
                updates_json = json_insert(updates_json, '$[#]', json(?)),
                expected_by = COALESCE(?, expected_by), url = ?, announced_at = ?,
                telegram_revision = telegram_revision + 1
               WHERE id = ? AND status = 'possible' AND NOT EXISTS (
                 SELECT 1 FROM json_each(announced_resets.updates_json) AS watch_update
                 WHERE json_extract(watch_update.value, '$.tweetId') = ?
               ) RETURNING *`,
            )
            .bind(JSON.stringify(update), ann.expectedBy || null, ann.url,
              ann.announcedAt, existing.id, ann.tweetId)
            .first();
          if (updatedRaw) {
            insertedAnnouncements.push({ ...rowToAnnouncement(updatedRaw), isUpdate: true });
          }
          continue;
        }
      }

      const res = await insertAnnouncement
        .bind(
          ann.id,
          ann.tweetId,
          ann.announcedAt,
          ann.expectedBy || null,
          ann.type,
          ann.authorHandle,
          ann.authorName,
          ann.url,
          ann.quoteText,
          JSON.stringify(ann.updates || []),
          JSON.stringify(ann.summary || { en: ann.quoteText }),
          ann.judgeSummary ? JSON.stringify(ann.judgeSummary) : null,
          annStatus,
        )
        .run();
      if ((res?.meta?.changes ?? 0) > 0) {
        insertedAnnouncements.push({
          ...ann,
          status: annStatus,
          updates: ann.updates || [],
          isUpdate: false,
        });
      }
    }
  }

  return { inserted, insertedAnnouncements, eventInserted };
}

export async function listReviewEvents(db, limit = 25) {
  if (!db) return [];
  const res = await db
    .prepare(
      "SELECT event_hash, received_at, tweet_id, author_handle, classified_as, judge_result_json FROM x_webhook_events WHERE classified_as IN ('needs_review', 'mixed_needs_review') ORDER BY received_at DESC LIMIT ?",
    )
    .bind(limit)
    .all();

  const items = [];
  const seenTweetIds = new Set();

  for (const row of res.results || []) {
    let judgeResult = null;
    try {
      judgeResult = row.judge_result_json ? JSON.parse(row.judge_result_json) : null;
    } catch {
      judgeResult = null;
    }

    const reviewEntries = Array.isArray(judgeResult)
      ? judgeResult.filter((entry) => entry?.status === "needs_review")
      : [];

    if (reviewEntries.length > 0) {
      for (const entry of reviewEntries) {
        const tid = entry.tweetId || row.tweet_id || null;
        if (tid && seenTweetIds.has(tid)) continue;
        if (tid) seenTweetIds.add(tid);
        items.push({
          eventHash: row.event_hash,
          receivedAt: row.received_at,
          tweetId: tid,
          authorHandle: entry.authorHandle || row.author_handle,
          classifiedAs: "needs_review",
          batchClassification: row.classified_as,
          tweet: entry.tweet || null,
          report: entry.report || null,
          judgeResult,
        });
        if (items.length >= limit) return items;
      }
    } else {
      const tid = row.tweet_id || null;
      if (tid && seenTweetIds.has(tid)) continue;
      if (tid) seenTweetIds.add(tid);
      items.push({
        eventHash: row.event_hash,
        receivedAt: row.received_at,
        tweetId: tid,
        authorHandle: row.author_handle,
        classifiedAs: row.classified_as,
        batchClassification: row.classified_as,
        tweet: null,
        report: null,
        judgeResult,
      });
      if (items.length >= limit) return items;
    }
  }

  return items;
}

export async function incrementThanks(db, resetId = null, delta = 1) {
  const n = Math.trunc(Number(delta) || 1);
  const step = Math.max(-1, Math.min(50, n === 0 ? 1 : n));
  if (!db) {
    const target = resetId
      ? SEED_RESETS.find((r) => r.id === resetId)
      : SEED_RESETS[0];
    if (!target) return null;
    target.thanksCount = Math.max(0, (target.thanksCount || 0) + step);
    return { id: target.id, thanksCount: target.thanksCount };
  }

  await ensureSeeded(db);
  let targetId = resetId;
  if (!targetId) {
    const latest = await db
      .prepare("SELECT id FROM resets ORDER BY timestamp DESC LIMIT 1")
      .first();
    targetId = latest?.id;
  }
  if (!targetId) return null;

  await db
    .prepare(
      "UPDATE resets SET thanks_count = MAX(0, thanks_count + ?) WHERE id = ?",
    )
    .bind(step, targetId)
    .run();

  const updated = await db
    .prepare("SELECT id, thanks_count FROM resets WHERE id = ?")
    .bind(targetId)
    .first();

  if (!updated) return null;
  return { id: updated.id, thanksCount: Number(updated.thanks_count) };
}

export async function recordPresence(db, sessionId) {
  if (!db) {
    return { online: null };
  }

  const now = Date.now();
  const cutoff = now - PRESENCE_TTL_MS;

  if (sessionId && typeof sessionId === "string" && sessionId.length <= 80) {
    await db
      .prepare(
        `INSERT INTO presence_sessions (session_id, last_seen)
         VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET last_seen = excluded.last_seen`,
      )
      .bind(sessionId, now)
      .run();
  }

  await db
    .prepare("DELETE FROM presence_sessions WHERE last_seen < ?")
    .bind(cutoff)
    .run();

  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM presence_sessions WHERE last_seen >= ?")
    .bind(cutoff)
    .first();

  const active = Number(row?.count || 0);
  return { online: active };
}

export async function getOnlineCount(db) {
  if (!db) return null;
  const cutoff = Date.now() - PRESENCE_TTL_MS;
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM presence_sessions WHERE last_seen >= ?")
    .bind(cutoff)
    .first();
  return Number(row?.count || 0);
}

export async function addEmailSubscription(db, { email, locale = "en", confirmed = 0 }) {
  const normalized = email.trim().toLowerCase();
  if (!db) {
    return { email: normalized, stored: false, mode: "preview" };
  }
  // An unauthenticated caller may create a pending row, but must not be able to
  // change the locale of an already-confirmed address, and can never clear the
  // confirmed flag. Confirmation only ever moves 0 -> 1.
  await db
    .prepare(
      `INSERT INTO email_subscriptions (email, locale, confirmed)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         locale = CASE
           WHEN email_subscriptions.confirmed = 1 THEN email_subscriptions.locale
           ELSE excluded.locale
         END,
         confirmed = MAX(email_subscriptions.confirmed, excluded.confirmed)`,
    )
    .bind(normalized, locale, confirmed)
    .run();
  return { email: normalized, stored: true, confirmed };
}

export async function confirmEmailSubscription(db, email) {
  const normalized = email.trim().toLowerCase();
  if (!db) {
    return { email: normalized, confirmed: false, mode: "preview" };
  }
  const res = await db
    .prepare("UPDATE email_subscriptions SET confirmed = 1 WHERE email = ?")
    .bind(normalized)
    .run();
  return { email: normalized, confirmed: (res?.meta?.changes ?? 0) > 0 };
}

export async function listEmailSubscribers(db) {
  if (!db) return [];
  // Only confirmed addresses receive alerts: unconfirmed rows are addresses
  // somebody else typed into the form.
  const res = await db
    .prepare(
      "SELECT email, locale FROM email_subscriptions WHERE confirmed = 1 ORDER BY created_at ASC",
    )
    .all();
  return (res.results || []).map((r) => ({ email: r.email, locale: r.locale || "en" }));
}

export async function removeEmailSubscription(db, email) {
  const normalized = email.trim().toLowerCase();
  if (!db) {
    return { email: normalized, removed: false, mode: "preview" };
  }
  const res = await db
    .prepare("DELETE FROM email_subscriptions WHERE email = ?")
    .bind(normalized)
    .run();
  return { email: normalized, removed: (res?.meta?.changes ?? 0) > 0 };
}

export async function resolveReviewEvent(
  db,
  {
    eventHash,
    tweetId,
    action,
    type = "regular",
    summary = null,
    models = null,
  },
) {
  if (!db) {
    throw new Error("Durable D1 binding (env.DB) is not configured");
  }
  await ensureSeeded(db);

  const row = await db
    .prepare(
      "SELECT event_hash, tweet_id, author_handle, classified_as, judge_result_json FROM x_webhook_events WHERE event_hash = ?",
    )
    .bind(eventHash)
    .first();

  if (!row) return null;

  let judgeResult = [];
  try {
    const parsed = row.judge_result_json ? JSON.parse(row.judge_result_json) : [];
    judgeResult = Array.isArray(parsed) ? parsed : [];
  } catch {
    judgeResult = [];
  }

  const targetIdx = judgeResult.findIndex(
    (entry) =>
      entry?.status === "needs_review" &&
      (!tweetId || String(entry.tweetId) === String(tweetId)),
  );
  if (targetIdx === -1) return { notFoundPending: true };

  const entry = judgeResult[targetIdx];
  const resolvedTweetId = entry.tweetId || row.tweet_id;
  const resolvedHandle = entry.authorHandle || row.author_handle || "@_mohansolo";
  const resolvedTweet = entry.tweet || {};

  let publishedReset = null;
  if (action === "approve") {
    const resetType = type === "banked" ? "banked" : "regular";
    const flashSummary = entry.report?.flash?.summaryI18n;
    const finalSummary =
      summary && typeof summary === "object" && summary.en
        ? summary
        : flashSummary && flashSummary.en
          ? flashSummary
          : { en: resolvedTweet.text || "Official Antigravity quota reset." };
    const finalModels =
      Array.isArray(models) && models.length > 0
        ? models
        : Array.isArray(entry.report?.flash?.models) && entry.report.flash.models.length > 0
          ? entry.report.flash.models
          : ["Gemini"];
    const resetItem = {
      id: `x-${resolvedTweetId}`,
      tweetId: resolvedTweetId,
      timestamp: new Date().toISOString(),
      type: resetType,
      authorHandle: resolvedHandle,
      authorName: resolvedHandle,
      models: finalModels,
      url:
        resolvedTweet.url ||
        `https://x.com/${resolvedHandle.replace(/^@/, "")}/status/${resolvedTweetId}`,
      summary: finalSummary,
      thanksCount: 0,
      source: "admin_review_approved",
      judgeSummary: {
        consensus: "admin_approved",
        resolvedFrom: entry.report?.consensus || "needs_review",
      },
    };

    const insertRes = await db
      .prepare(
        `INSERT OR IGNORE INTO resets
          (id, tweet_id, timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        resetItem.id,
        resetItem.tweetId,
        resetItem.timestamp,
        resetItem.type,
        resetItem.authorHandle,
        resetItem.authorName,
        JSON.stringify(resetItem.models),
        resetItem.url,
        resetItem.summary.en,
        JSON.stringify(resetItem.summary),
        JSON.stringify(resetItem.judgeSummary),
        0,
        resetItem.source,
      )
      .run();

    if ((insertRes?.meta?.changes ?? 0) > 0) {
      publishedReset = resetItem;
    }
  }

  judgeResult[targetIdx] = {
    ...entry,
    status: action === "approve" ? "resolved_approved" : "resolved_dismissed",
    resolvedAt: new Date().toISOString(),
  };

  const remainingPending = judgeResult.filter((e) => e?.status === "needs_review").length;
  const hasApproved = judgeResult.some(
    (e) => e?.status === "approved" || e?.status === "resolved_approved",
  );
  const nextClass =
    remainingPending > 0
      ? hasApproved
        ? "mixed_needs_review"
        : "needs_review"
      : hasApproved
        ? type === "banked"
          ? "banked"
          : "regular"
        : "dismissed";

  await db
    .prepare(
      "UPDATE x_webhook_events SET classified_as = ?, judge_result_json = ? WHERE event_hash = ?",
    )
    .bind(nextClass, JSON.stringify(judgeResult), eventHash)
    .run();

  return {
    eventHash,
    tweetId: resolvedTweetId,
    action: action === "approve" ? "approved" : "dismissed",
    reset: publishedReset,
    remainingPending,
    classifiedAs: nextClass,
  };
}

export async function addPushSubscription(db, { endpoint, p256dh, auth, locale = "en" }) {
  if (!db) {
    return { stored: false, mode: "preview" };
  }
  await db
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, locale)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, locale = excluded.locale`,
    )
    .bind(endpoint, p256dh, auth, locale)
    .run();
  return { stored: true };
}

export async function createManualReset(db, item) {
  if (!db) {
    throw new Error("Durable D1 binding (env.DB) is not configured");
  }
  await ensureSeeded(db);
  await db
    .prepare(
      `INSERT INTO resets
        (id, tweet_id, timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      item.id,
      item.tweetId || null,
      item.timestamp,
      item.type,
      item.authorHandle,
      item.authorName,
      JSON.stringify(item.models || ["All Antigravity models"]),
      item.url,
      item.summary.en,
      JSON.stringify(item.summary),
      null,
      0,
      "admin",
    )
    .run();
  return item;
}
