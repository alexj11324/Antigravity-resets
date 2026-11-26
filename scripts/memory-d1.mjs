// Lightweight in-memory D1-compatible shim for local development and automated testing.

export function createMemoryD1() {
  const resets = new Map(); // id -> row
  const resetsByTweetId = new Map(); // tweet_id -> id
  const announcedResets = new Map(); // id -> row
  const announcedByTweetId = new Map(); // tweet_id -> id
  const webhookEvents = new Map(); // event_hash -> row
  const emailSubs = new Map(); // email -> row
  const pushSubs = new Map(); // endpoint -> row
  const presence = new Map(); // session_id -> last_seen

  function execute(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();

    if (/^SELECT COUNT\(\*\) AS count FROM resets$/i.test(q)) {
      return { first: { count: resets.size }, results: [{ count: resets.size }] };
    }

    if (/^INSERT OR IGNORE INTO resets/i.test(q) || /^INSERT INTO resets/i.test(q)) {
      const [
        id,
        tweet_id,
        timestamp,
        type,
        author_handle,
        author_name,
        models_json,
        url,
        summary_en,
        summary_i18n_json,
        judge_summary_json,
        thanks_count,
        source,
        quote_text,
      ] = params;

      const ignore = /^INSERT OR IGNORE/i.test(q);
      if (resets.has(id) || (tweet_id && resetsByTweetId.has(tweet_id))) {
        if (ignore) return { meta: { changes: 0 } };
        throw new Error("UNIQUE constraint failed");
      }
      const row = {
        id,
        tweet_id,
        timestamp,
        type,
        author_handle,
        author_name,
        models_json,
        url,
        summary_en,
        summary_i18n_json,
        judge_summary_json,
        thanks_count: Number(thanks_count || 0),
        source,
        quote_text: quote_text ?? null,
      };
      resets.set(id, row);
      if (tweet_id) resetsByTweetId.set(tweet_id, id);
      return { meta: { changes: 1 } };
    }

    if (/^SELECT \* FROM resets/i.test(q)) {
      let rows = Array.from(resets.values());
      let pIdx = 0;
      if (/WHERE type = \?/i.test(q)) {
        const type = params[pIdx++];
        rows = rows.filter((r) => r.type === type);
      }
      rows.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      if (/LIMIT \?/i.test(q)) {
        const limit = Number(params[pIdx++]);
        rows = rows.slice(0, limit);
      }
      return { results: rows, first: rows[0] || null };
    }

    if (/^SELECT id FROM resets ORDER BY timestamp DESC LIMIT 1$/i.test(q)) {
      const rows = Array.from(resets.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      );
      const first = rows[0] ? { id: rows[0].id } : null;
      return { first, results: first ? [first] : [] };
    }

    if (/^UPDATE resets SET thanks_count = MAX\(0, thanks_count \+ \?\) WHERE id = \?$/i.test(q)) {
      const [delta, id] = params;
      const row = resets.get(id);
      if (!row) return { meta: { changes: 0 } };
      row.thanks_count = Math.max(0, Number(row.thanks_count) + Number(delta));
      return { meta: { changes: 1 } };
    }

    if (/^SELECT id, thanks_count FROM resets WHERE id = \?$/i.test(q)) {
      const row = resets.get(params[0]);
      const first = row ? { id: row.id, thanks_count: row.thanks_count } : null;
      return { first, results: first ? [first] : [] };
    }

    if (/^INSERT OR IGNORE INTO announced_resets/i.test(q)) {
      const [
        id,
        tweet_id,
        announced_at,
        expected_by,
        type,
        author_handle,
        author_name,
        url,
        quote_text,
        updates_json,
        summary_i18n_json,
        judge_summary_json,
        status,
      ] = params;
      if (announcedResets.has(id) || (tweet_id && announcedByTweetId.has(tweet_id))) {
        return { meta: { changes: 0 } };
      }
      const row = {
        id,
        tweet_id,
        announced_at,
        expected_by: expected_by || null,
        type,
        author_handle,
        author_name,
        url,
        quote_text,
        updates_json: updates_json || "[]",
        summary_i18n_json,
        judge_summary_json,
        telegram_message_id: null,
        status: status || "expected",
        confirmed_reset_id: null,
      };
      row.telegram_revision = /telegram_revision/i.test(q) ? 1 : 0;
      announcedResets.set(id, row);
      if (tweet_id) announcedByTweetId.set(tweet_id, id);
      return { meta: { changes: 1 } };
    }

    if (/^SELECT \* FROM announced_resets WHERE status IN \('expected', 'possible'\)/i.test(q)) {
      const rows = Array.from(announcedResets.values())
        .filter((r) => r.status === "expected" || r.status === "possible")
        .sort((a, b) => new Date(b.announced_at).getTime() - new Date(a.announced_at).getTime());
      return { first: rows[0] || null, results: rows };
    }

    if (/^SELECT \* FROM announced_resets WHERE status = 'possible'/i.test(q)) {
      const rows = Array.from(announcedResets.values())
        .filter((r) => r.status === "possible")
        .sort((a, b) => new Date(b.announced_at).getTime() - new Date(a.announced_at).getTime());
      return { first: rows[0] || null, results: rows };
    }

    if (/^SELECT id FROM announced_resets WHERE tweet_id = \? OR EXISTS/i.test(q)) {
      const row = Array.from(announcedResets.values()).find((item) =>
        item.tweet_id === params[0] ||
        JSON.parse(item.updates_json || "[]").some((update) => update.tweetId === params[1]));
      const first = row ? { id: row.id } : null;
      return { first, results: first ? [first] : [] };
    }

    if (/^UPDATE announced_resets SET updates_json = json_insert/i.test(q)) {
      const [updateJson, expectedBy, url, announcedAt, id, tweetId] = params;
      const row = announcedResets.get(id);
      const updates = row ? JSON.parse(row.updates_json || "[]") : [];
      if (!row || row.status !== "possible" || updates.some((update) => update.tweetId === tweetId)) {
        return { first: null, meta: { changes: 0 } };
      }
      row.updates_json = JSON.stringify([...updates, JSON.parse(updateJson)]);
      row.expected_by = expectedBy || row.expected_by || null;
      row.url = url;
      row.announced_at = announcedAt;
      row.telegram_revision = (row.telegram_revision || 0) + 1;
      return { first: { ...row }, meta: { changes: 1 } };
    }

    if (/^UPDATE announced_resets SET updates_json = \?, expected_by = \?, url = \?, announced_at = \? WHERE id = \?$/i.test(q)) {
      const [updates_json, expected_by, url, announced_at, id] = params;
      const row = announcedResets.get(id);
      if (!row) return { meta: { changes: 0 } };
      row.updates_json = updates_json;
      row.expected_by = expected_by || null;
      row.url = url;
      row.announced_at = announced_at;
      return { meta: { changes: 1 } };
    }

    if (/^UPDATE announced_resets SET telegram_message_id = \? WHERE id = \?$/i.test(q)) {
      const [msgId, id] = params;
      const row = announcedResets.get(id);
      if (!row) return { meta: { changes: 0 } };
      row.telegram_message_id = msgId ? String(msgId) : null;
      return { meta: { changes: 1 } };
    }

    if (/^UPDATE announced_resets SET status = 'confirmed', confirmed_reset_id = \? WHERE status IN \('expected', 'possible'\) AND announced_at <= \?$/i.test(q)) {
      const [confirmedId, confirmedTs] = params;
      const cutoff = new Date(confirmedTs).getTime();
      let changes = 0;
      for (const row of announcedResets.values()) {
        if (
          (row.status === "expected" || row.status === "possible") &&
          new Date(row.announced_at).getTime() <= cutoff
        ) {
          row.status = "confirmed";
          row.confirmed_reset_id = confirmedId;
          changes += 1;
        }
      }
      return { meta: { changes } };
    }

    if (/^INSERT OR IGNORE INTO x_webhook_events/i.test(q)) {
      const [
        event_hash,
        signature_scheme,
        event_type,
        tweet_id,
        author_handle,
        classified_as,
        judge_result_json,
        raw_payload,
      ] = params;
      if (webhookEvents.has(event_hash)) {
        return { meta: { changes: 0 } };
      }
      webhookEvents.set(event_hash, {
        event_hash,
        received_at: new Date().toISOString(),
        signature_scheme,
        event_type,
        tweet_id,
        author_handle,
        classified_as,
        judge_result_json,
        raw_payload,
      });
      return { meta: { changes: 1 } };
    }

    if (
      /FROM x_webhook_events WHERE classified_as (?:= 'needs_review'|IN \('needs_review', 'mixed_needs_review'\))/i.test(
        q,
      )
    ) {
      const limit = Number(params[0] || 25);
      const rows = Array.from(webhookEvents.values())
        .filter(
          (e) =>
            e.classified_as === "needs_review" ||
            e.classified_as === "mixed_needs_review",
        )
        .sort((a, b) => b.received_at.localeCompare(a.received_at))
        .slice(0, limit);
      return { results: rows, first: rows[0] || null };
    }

    if (/^INSERT INTO presence_sessions/i.test(q)) {
      const [session_id, last_seen] = params;
      presence.set(session_id, Number(last_seen));
      return { meta: { changes: 1 } };
    }

    if (/^DELETE FROM presence_sessions WHERE last_seen < \?$/i.test(q)) {
      const cutoff = Number(params[0]);
      let removed = 0;
      for (const [k, v] of presence.entries()) {
        if (v < cutoff) {
          presence.delete(k);
          removed++;
        }
      }
      return { meta: { changes: removed } };
    }

    if (/^SELECT COUNT\(\*\) AS count FROM presence_sessions WHERE last_seen >= \?$/i.test(q)) {
      const cutoff = Number(params[0]);
      let count = 0;
      for (const v of presence.values()) {
        if (v >= cutoff) count++;
      }
      return { first: { count }, results: [{ count }] };
    }

    if (
      /^SELECT event_hash, tweet_id, author_handle, classified_as, judge_result_json FROM x_webhook_events WHERE event_hash = \?$/i.test(
        q,
      )
    ) {
      const row = webhookEvents.get(params[0]) || null;
      return { first: row, results: row ? [row] : [] };
    }

    if (
      /^UPDATE x_webhook_events SET classified_as = \?, judge_result_json = \? WHERE event_hash = \?$/i.test(
        q,
      )
    ) {
      const [classified_as, judge_result_json, event_hash] = params;
      const row = webhookEvents.get(event_hash);
      if (!row) return { meta: { changes: 0 } };
      row.classified_as = classified_as;
      row.judge_result_json = judge_result_json;
      return { meta: { changes: 1 } };
    }

    if (/^SELECT email, locale FROM email_subscriptions/i.test(q)) {
      const rows = Array.from(emailSubs.values());
      return { results: rows, first: rows[0] || null };
    }

    if (/^DELETE FROM email_subscriptions WHERE email = \?$/i.test(q)) {
      const existed = emailSubs.delete(params[0]);
      return { meta: { changes: existed ? 1 : 0 } };
    }

    if (/^INSERT INTO email_subscriptions/i.test(q)) {
      const [email, locale] = params;
      emailSubs.set(email, { email, locale });
      return { meta: { changes: 1 } };
    }

    if (/^INSERT INTO push_subscriptions/i.test(q)) {
      const [endpoint, p256dh, auth, locale] = params;
      pushSubs.set(endpoint, { endpoint, p256dh, auth, locale });
      return { meta: { changes: 1 } };
    }

    throw new Error(`Unsupported memory D1 query: ${q}`);
  }

  function makeStatement(sql, bound = []) {
    return {
      bind(...args) {
        return makeStatement(sql, args);
      },
      async first() {
        return execute(sql, bound).first ?? null;
      },
      async all() {
        return { results: execute(sql, bound).results ?? [] };
      },
      async run() {
        return { success: true, meta: execute(sql, bound).meta ?? { changes: 0 } };
      },
    };
  }

  return {
    prepare(sql) {
      return makeStatement(sql);
    },
    // This adapter previews source storage only. Use Wrangler local D1 for
    // durable Telegram triggers, claims, delivery, and scheduled retries.
    _supportsTelegramOutbox: false,
    _tables: { resets, announcedResets, webhookEvents, emailSubs, pushSubs, presence },
  };
}
