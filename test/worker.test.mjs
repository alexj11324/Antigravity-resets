import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import worker from "../src/index.mjs";
import { createMemoryD1 } from "../scripts/memory-d1.mjs";

const OAUTH2_SECRET = "test_oauth2_client_secret_value";
const LEGACY_SECRET = "test_legacy_api_key_secret_value";
const ADMIN_TOKEN = "test_admin_bearer_token";
const GEMINI_KEY = "test_gemini_api_key";

function sign(secret, body) {
  const hmac = crypto.createHmac("sha256", secret).update(body).digest("base64");
  return `sha256=${hmac}`;
}

function makeMockJointFetch({
  decisionsResponse,
  flashResponse,
  decisionsFail = false,
  flashFail = false,
}) {
  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    if (String(url).includes("/v1beta/decisions")) {
      if (decisionsFail) {
        return new Response(JSON.stringify({ error: { message: "Upstream 503" } }), { status: 503 });
      }
      return Response.json(decisionsResponse);
    }
    if (String(url).includes("/v1/interactions")) {
      if (flashFail) {
        return new Response(JSON.stringify({ error: { message: "Flash timeout" } }), { status: 504 });
      }
      return Response.json({
        id: "int_test_001",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(flashResponse) }],
          },
        ],
        usage: { total_input_tokens: 180, total_output_tokens: 95, total_tokens: 275 },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };
  return { mockFetch, calls };
}

test("GET /api/webhooks/x responds to CRC challenge using OAuth2 secret", async () => {
  const token = "crc_challenge_token_123";
  const req = new Request(`https://antigravity-resets.com/api/webhooks/x?crc_token=${token}`);
  const res = await worker.fetch(req, { X_OAUTH2_CLIENT_SECRET: OAUTH2_SECRET });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.response_token, sign(OAUTH2_SECRET, token));
});

test("POST /api/webhooks/x rejects invalid OAuth2 signature without falling back to legacy signature", async () => {
  const raw = JSON.stringify({ tweet_create_events: [] });
  const req = new Request("https://antigravity-resets.com/api/webhooks/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Twitter-Webhooks-Signature-OAuth2": sign("wrong_secret", raw),
      "X-Twitter-Webhooks-Signature": sign(LEGACY_SECRET, raw),
    },
    body: raw,
  });
  const res = await worker.fetch(req, {
    X_OAUTH2_CLIENT_SECRET: OAUTH2_SECRET,
    X_API_KEY_SECRET: LEGACY_SECRET,
    DB: createMemoryD1(),
  });
  assert.equal(res.status, 401);
});

test("POST /api/webhooks/x returns 503 Retry-After when durable DB is unconfigured", async () => {
  const raw = JSON.stringify({ tweet_create_events: [] });
  const req = new Request("https://antigravity-resets.com/api/webhooks/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Twitter-Webhooks-Signature-OAuth2": sign(OAUTH2_SECRET, raw),
    },
    body: raw,
  });
  const res = await worker.fetch(req, { X_OAUTH2_CLIENT_SECRET: OAUTH2_SECRET });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("Joint Judge (Decisions API + Gemini 3.8 Flash Interactions API) approves banked reset idempotently", async () => {
  const db = createMemoryD1();
  const { mockFetch, calls } = makeMockJointFetch({
    decisionsResponse: {
      answers: {
        is_quota_reset: { type: "noul", noul: 0.97, confidence: 0.97 },
        is_active_now: { type: "noul", noul: 0.94, confidence: 0.94 },
        reset_type: {
          type: "choice",
          choice: "banked",
          confidence: 0.93,
          probabilities: { regular: 0.06, banked: 0.93, other: 0.01 },
        },
      },
      usage: { total_input_tokens: 140, total_output_tokens: 0, total_tokens: 140 },
    },
    flashResponse: {
      is_reset: true,
      type: "banked",
      confidence: 0.96,
      models: ["Gemini 4 Neon"],
      reason: "Official lead announced a live claimable banked quota reset for all Antigravity users.",
      summary_i18n: {
        en: "Banked resets are now live! Claim your banked Gemini quota reset in Antigravity whenever you need it.",
        "zh-CN": "留存重置（Banked Resets）正式上线！现在可在 Antigravity 中按需随时领取你的 Gemini 配额重置。",
        "zh-TW": "留存重置（Banked Resets）正式上線！現在可在 Antigravity 中按需隨時領取你的 Gemini 配額重置。",
        ja: "Banked resets が公開されました。必要なときに Antigravity から Gemini クォータリセットを適用できます。",
        ko: "Banked resets가 출시되었습니다. 필요할 때 Antigravity에서 Gemini 할당량 리셋을 바로 사용하세요.",
      },
    },
  });

  const payload = {
    tweet_create_events: [
      {
        id_str: "2126999999999999001",
        created_at: "Fri Nov 27 18:00:00 +0000 2026",
        text: "Banked resets are now live! Claim your banked Gemini quota reset in Antigravity whenever you need it.",
        user: { screen_name: "_mohansolo", name: "Varun Mohan" },
      },
      {
        id_str: "2126999999999999002",
        created_at: "Fri Nov 27 18:01:00 +0000 2026",
        text: "Did Antigravity reset quota today?",
        user: { screen_name: "random_user", name: "Random Dev" },
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const makeReq = () =>
    new Request("https://antigravity-resets.com/api/webhooks/x", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Twitter-Webhooks-Signature-OAuth2": sign(OAUTH2_SECRET, raw),
      },
      body: raw,
    });

  const env = {
    X_OAUTH2_CLIENT_SECRET: OAUTH2_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    DB: db,
    __fetchImpl: mockFetch,
  };

  const firstRes = await worker.fetch(makeReq(), env);
  assert.equal(firstRes.status, 200);
  const firstJson = await firstRes.json();
  assert.equal(firstJson.ok, true);
  assert.equal(firstJson.tweetsSeen, 2);
  assert.equal(firstJson.resetsRecorded, 1);
  assert.equal(firstJson.classification, "banked");

  const decCall = calls.find((c) => c.url.includes("/v1beta/decisions"));
  const flashCall = calls.find((c) => c.url.includes("/v1/interactions"));
  assert.ok(decCall, "Expected Decisions API call");
  assert.ok(flashCall, "Expected Interactions API call");
  assert.equal(decCall.headers["x-goog-api-key"], GEMINI_KEY);
  assert.equal(decCall.body.model, "gemini-decision-1");
  assert.ok(decCall.body.questions.reset_type.criteria.regular, "Expected regular choice criteria");
  assert.ok(decCall.body.questions.reset_type.criteria.banked, "Expected banked choice criteria");
  assert.equal(flashCall.headers["x-goog-api-key"], GEMINI_KEY);
  assert.equal(flashCall.headers["Api-Revision"], "2026-05-20");
  assert.equal(flashCall.body.model, "gemini-3.8-flash");
  assert.equal(flashCall.body.store, false);
  assert.equal(flashCall.body.generation_config.thinking_level, "low");

  const secondRes = await worker.fetch(makeReq(), env);
  assert.equal(secondRes.status, 200);
  assert.equal((await secondRes.json()).resetsRecorded, 0);

  const statusRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/status"),
    env,
  );
  const status = await statusRes.json();
  assert.equal(status.latest.tweetId, "2126999999999999001");
  assert.equal(status.latest.type, "banked");
  assert.equal(status.latest.source, "x_webhook_joint_ai");
  assert.equal(status.latest.judgeSummary.consensus, "unanimous");
  assert.equal(status.latest.url, "https://x.com/_mohansolo/status/2126999999999999001");
});

test("Joint Judge disagreement holds event in needs_review instead of publishing false positive", async () => {
  const db = createMemoryD1();
  const { mockFetch } = makeMockJointFetch({
    decisionsResponse: {
      answers: {
        is_quota_reset: { type: "noul", noul: 0.84, confidence: 0.84 },
        is_active_now: { type: "noul", noul: 0.78, confidence: 0.78 },
        reset_type: { type: "choice", choice: "regular", confidence: 0.8 },
      },
    },
    flashResponse: {
      is_reset: false,
      type: "other",
      confidence: 0.91,
      models: [],
      reason: "Post is a playful teaser, not a deployed reset.",
      summary_i18n: {
        en: "Teaser post.",
        "zh-CN": "预告帖。",
        "zh-TW": "預告貼文。",
        ja: "予告投稿。",
        ko: "예고 글.",
      },
    },
  });

  const payload = {
    data: [
      {
        id: "2127000000000000099",
        author_id: "42",
        created_at: "2026-11-27T02:00:00Z",
        text: "Thinking about resetting quotas if you ship something cool this weekend...",
      },
    ],
    includes: {
      users: [{ id: "42", username: "antigravity", name: "Google Antigravity" }],
    },
  };
  const raw = JSON.stringify(payload);
  const req = new Request("https://antigravity-resets.com/api/webhooks/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Twitter-Webhooks-Signature": sign(LEGACY_SECRET, raw),
    },
    body: raw,
  });

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    DB: db,
    __fetchImpl: mockFetch,
  };

  const res = await worker.fetch(req, env);
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.resetsRecorded, 0);
  assert.equal(json.needsReview, 1);
  assert.equal(json.classification, "needs_review");

  const reviewRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/admin/review", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    }),
    env,
  );
  assert.equal(reviewRes.status, 200);
  const review = await reviewRes.json();
  assert.equal(review.count, 1);
  assert.equal(review.items[0].tweetId, "2127000000000000099");
});

test("Joint Judge returns 503 Retry-After when both upstream models fail", async () => {
  const db = createMemoryD1();
  const { mockFetch } = makeMockJointFetch({
    decisionsFail: true,
    flashFail: true,
  });
  const payload = {
    tweet_create_events: [
      {
        id_str: "2127000000000000111",
        created_at: "Thu Nov 26 21:00:00 +0000 2026",
        text: "Resetting Gemini quota for everyone right now!",
        user: { screen_name: "_mohansolo", name: "Varun Mohan" },
      },
    ],
  };
  const raw = JSON.stringify(payload);
  const req = new Request("https://antigravity-resets.com/api/webhooks/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Twitter-Webhooks-Signature-OAuth2": sign(OAUTH2_SECRET, raw),
    },
    body: raw,
  });

  const res = await worker.fetch(req, {
    X_OAUTH2_CLIENT_SECRET: OAUTH2_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    DB: db,
    __fetchImpl: mockFetch,
  });
  assert.equal(res.status, 503);
  assert.equal(res.headers.get("Retry-After"), "60");
});

test("Public API serves all 17 verified X status URLs and handles batched multi-click thanks", async () => {
  const db = createMemoryD1();
  const env = { DB: db, ADMIN_API_TOKEN: ADMIN_TOKEN };

  const resetsRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/resets"),
    env,
  );
  assert.equal(resetsRes.status, 200);
  const resetsJson = await resetsRes.json();
  assert.equal(resetsJson.count, 17);
  for (const r of resetsJson.resets) {
    assert.match(
      r.url,
      /^https:\/\/x\.com\/[A-Za-z0-9_]+\/status\/\d{18,20}$/,
      `Expected verified status URL, got ${r.url}`,
    );
  }

  const statusRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/status"),
    env,
  );
  const status = await statusRes.json();
  assert.equal(status.stats.totalResets, 17);
  assert.equal(
    status.latest.url,
    "https://x.com/_mohansolo/status/2125851902009311306",
  );
  const initialThanks = status.thanksCount;

  // Batched rapid multi-click (+5)
  const thanksRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/thanks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resetId: status.latest.id, delta: 5 }),
    }),
    env,
  );
  assert.equal(thanksRes.status, 200);
  assert.equal((await thanksRes.json()).thanksCount, initialThanks + 5);

  // Email subscribe & admin reset
  const goodEmailRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/subscribe/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "dev@example.com", locale: "zh-CN" }),
    }),
    env,
  );
  assert.equal(goodEmailRes.status, 201);

  const authAdmin = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/admin/resets", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        type: "banked",
        timestamp: "2026-11-28T12:00:00Z",
        summary: { en: "Manual verified banked reset." },
      }),
    }),
    env,
  );
  assert.equal(authAdmin.status, 201);
});

test("Webhook parser preserves self-thread replies and quoted tweet context while dropping retweets", async () => {
  const { extractTweetsFromWebhookPayload } = await import("../src/reset-classifier.mjs");
  const tweets = extractTweetsFromWebhookPayload({
    tweet_create_events: [
      {
        id_str: "2128000000000000001",
        created_at: "Fri Nov 27 19:00:00 +0000 2026",
        in_reply_to_status_id_str: "2128000000000000000",
        in_reply_to_screen_name: "_mohansolo",
        text: "One more thing: resetting Gemini quota for everyone!",
        user: { screen_name: "_mohansolo", name: "Varun Mohan" },
      },
      {
        id_str: "2128000000000000002",
        created_at: "Fri Nov 27 19:01:00 +0000 2026",
        text: "Also resetting everyone's quota so you can try it now!",
        user: { screen_name: "_mohansolo", name: "Varun Mohan" },
        quoted_status: {
          text: "Gemini 4 Carbon is now live on Antigravity!",
          user: { screen_name: "antigravity", name: "Google Antigravity" },
        },
      },
      {
        id_str: "2128000000000000003",
        created_at: "Fri Nov 27 19:02:00 +0000 2026",
        text: "RT @_mohansolo: Resetting quota!",
        retweeted_status: { id_str: "2128000000000000001" },
        user: { screen_name: "antigravity", name: "Google Antigravity" },
      },
    ],
  });

  assert.equal(tweets.length, 2);
  assert.equal(tweets[0].isReply, true);
  assert.equal(tweets[0].replyToHandle, "@_mohansolo");
  assert.equal(tweets[1].quotedAuthor, "@antigravity");
  assert.match(tweets[1].quotedText, /Gemini 4 Carbon/);
});

function makeMockJointFetchWithRouter(router) {
  const calls = [];
  const telegramCalls = [];
  const emailCalls = [];

  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (urlStr.includes("api.telegram.org")) {
      telegramCalls.push({ url: urlStr, body });
      return Response.json({ ok: true, result: { message_id: telegramCalls.length } });
    }
    if (urlStr.includes("api.resend.com")) {
      emailCalls.push({ url: urlStr, body });
      return Response.json({ id: `email_${emailCalls.length}` });
    }
    calls.push({ url: urlStr, headers: init?.headers || {}, body });
    const kind = urlStr.includes("/v1beta/decisions")
      ? "decisions"
      : urlStr.includes("/v1/interactions")
        ? "flash"
        : "unknown";
    const result = router(kind, body);
    if (kind === "decisions") {
      return Response.json(result);
    }
    if (kind === "flash") {
      return Response.json({
        id: `int_test_${calls.length}`,
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [{ type: "text", text: JSON.stringify(result) }],
          },
        ],
        usage: { total_input_tokens: 200, total_output_tokens: 90, total_tokens: 290 },
      });
    }
    throw new Error(`Unexpected fetch URL: ${urlStr}`);
  };

  return { mockFetch, calls, telegramCalls, emailCalls };
}

function makeWaitUntilCtx() {
  const pending = [];
  return {
    ctx: {
      waitUntil(promise) {
        pending.push(Promise.resolve(promise));
      },
    },
    async flush() {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
}

function makeSignedWebhookRequest(payload, { secret = LEGACY_SECRET, scheme = "oauth1" } = {}) {
  const raw = JSON.stringify(payload);
  const headerName =
    scheme === "oauth2"
      ? "X-Twitter-Webhooks-Signature-OAuth2"
      : "X-Twitter-Webhooks-Signature";
  return new Request("https://webhooks.antigravity-resets.com/api/webhooks/x", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      [headerName]: sign(secret, raw),
    },
    body: raw,
  });
}

function makeOfficialActivityPostCreate({
  eventUuid = "evt-2130000000000000001",
  tweetId = "2130000000000000001",
  authorId = "1001",
  username = "_mohansolo",
  name = "Varun Mohan",
  text = "Resetting Gemini quota for all Antigravity users right now!",
  createdAt = "2026-11-28T18:00:00.000Z",
  referencedTweets = undefined,
  inReplyToTweetId = undefined,
  inReplyToUserId = undefined,
  extraUsers = [],
  extraTweets = [],
} = {}) {
  const post = {
    id: tweetId,
    author_id: authorId,
    created_at: createdAt,
    text,
    ...(referencedTweets ? { referenced_tweets: referencedTweets } : {}),
    ...(inReplyToTweetId ? { in_reply_to_tweet_id: inReplyToTweetId } : {}),
    ...(inReplyToUserId ? { in_reply_to_user_id: inReplyToUserId } : {}),
  };
  return {
    data: {
      event_uuid: eventUuid,
      created_at: createdAt,
      filter: { user_id: authorId },
      event_type: "post.create",
      tag: "posts",
      payload: post,
      includes: {
        tweets: [post, ...extraTweets],
        users: [{ id: authorId, username, name }, ...extraUsers],
      },
    },
  };
}

test("Official X Activity post.create signed replay parses data.payload + data.includes, calls both models, persists, and deduplicates redeliveries", async () => {
  const db = createMemoryD1();
  const { mockFetch, calls, telegramCalls, emailCalls } = makeMockJointFetchWithRouter(
    (kind) => {
      if (kind === "decisions") {
        return {
          answers: {
            is_quota_reset: { type: "noul", noul: 0.98, confidence: 0.98 },
            is_active_now: { type: "noul", noul: 0.97, confidence: 0.97 },
            needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
            reset_type: { type: "choice", choice: "regular", confidence: 0.99 },
          },
        };
      }
      return {
        is_reset: true,
        needs_review: false,
        type: "regular",
        confidence: 0.99,
        models: ["Gemini"],
        reason: "Official post announcing an immediate global Gemini quota reset.",
        summary_i18n: {
          en: "Resetting Gemini quota for all Antigravity users right now!",
          "zh-CN": "已立即为所有 Antigravity 用户重置 Gemini 配额！",
          "zh-TW": "已立即為所有 Antigravity 使用者重置 Gemini 配額！",
          ja: "全 Antigravity ユーザーの Gemini クォータをリセットしました。",
          ko: "모든 Antigravity 사용자의 Gemini 할당량을 지금 리셋합니다.",
        },
      };
    },
  );

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    RESEND_API_KEY: "mock_resend_key",
    RESEND_FROM_EMAIL: "alerts@antigravity-resets.com",
    DB: db,
    __fetchImpl: mockFetch,
  };

  // Seed one isolated email subscriber
  const subRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/subscribe/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "subscriber@example.com", locale: "zh-CN" }),
    }),
    env,
  );
  assert.equal(subRes.status, 201);

  const payload = makeOfficialActivityPostCreate({
    eventUuid: "evt-official-001",
    tweetId: "2130000000000000101",
    text: "Resetting Gemini quota for all Antigravity users right now!",
  });

  const wu = makeWaitUntilCtx();
  const res1 = await worker.fetch(makeSignedWebhookRequest(payload), env, wu.ctx);
  await wu.flush();
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  assert.equal(body1.ok, true);
  assert.equal(body1.eventType, "post.create");
  assert.equal(body1.tweetsSeen, 1);
  assert.equal(body1.resetsRecorded, 1);
  assert.equal(body1.needsReview, 0);
  assert.equal(body1.classification, "regular");
  assert.equal(calls.length, 2, "Both Decisions API and Gemini 3.8 Flash must be called");
  assert.equal(telegramCalls.length, 1);
  assert.equal(emailCalls.length, 1);

  // Verify persisted in D1 via public API
  const statusRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/status"),
    env,
  );
  const status = await statusRes.json();
  assert.equal(status.latest.tweetId, "2130000000000000101");
  assert.equal(status.latest.type, "regular");
  assert.equal(status.stats.totalResets, 18);

  // Duplicate delivery #1: exact same signed payload -> 0 new resets, 0 extra notifications
  const resDup1 = await worker.fetch(makeSignedWebhookRequest(payload), env, wu.ctx);
  await wu.flush();
  assert.equal(resDup1.status, 200);
  const dupBody1 = await resDup1.json();
  assert.equal(dupBody1.tweetsSeen, 1);
  assert.equal(dupBody1.resetsRecorded, 0);
  assert.equal(telegramCalls.length, 1);
  assert.equal(emailCalls.length, 1);

  // Duplicate delivery #2: same tweetId wrapped in a new event_uuid -> still 0 new resets / notifications
  const payloadNewUuid = makeOfficialActivityPostCreate({
    eventUuid: "evt-official-001-retry",
    tweetId: "2130000000000000101",
    text: "Resetting Gemini quota for all Antigravity users right now!",
  });
  const resDup2 = await worker.fetch(makeSignedWebhookRequest(payloadNewUuid), env, wu.ctx);
  await wu.flush();
  assert.equal(resDup2.status, 200);
  assert.equal((await resDup2.json()).resetsRecorded, 0);
  assert.equal(telegramCalls.length, 1);
  assert.equal(emailCalls.length, 1);

  const afterResets = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/resets"), env)
  ).json();
  assert.equal(afterResets.count, 18);
});

test("Unparseable declared post.create returns HTTP 422 with diagnostics and stores parse_error instead of silent 200", async () => {
  const db = createMemoryD1();
  const { mockFetch, calls, telegramCalls } = makeMockJointFetchWithRouter(() => {
    throw new Error("Models must not be called for unparseable post.create");
  });
  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  // Missing author username in includes.users
  const brokenPayload = {
    data: {
      event_uuid: "evt-broken-001",
      created_at: "2026-11-28T18:05:00.000Z",
      filter: { user_id: "1001" },
      event_type: "post.create",
      payload: {
        id: "2130000000000000199",
        author_id: "1001",
        text: "Resetting Gemini quota for everyone!",
      },
      includes: { users: [], tweets: [] },
    },
  };

  const wu = makeWaitUntilCtx();
  const res = await worker.fetch(makeSignedWebhookRequest(brokenPayload), env, wu.ctx);
  await wu.flush();
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.tweetsSeen, 0);
  assert.equal(body.eventType, "post.create");
  assert.equal(body.diagnostics.length, 1);
  assert.equal(body.diagnostics[0].reason, "unparseable_post_create");
  assert.ok(body.diagnostics[0].missingFields.includes("author_username"));
  assert.equal(calls.length, 0);
  assert.equal(telegramCalls.length, 0);
  assert.equal(db._tables.webhookEvents.size, 1);
  const storedEvent = Array.from(db._tables.webhookEvents.values())[0];
  assert.equal(storedEvent.classified_as, "parse_error");
});

test("Reply 'Done' passes parent post text, author, and URL separately from quoted post; explicit parent approves while missing/ambiguous parent enters needs_review without notifications", async () => {
  const db = createMemoryD1();
  const { mockFetch, calls, telegramCalls } = makeMockJointFetchWithRouter((kind, body) => {
    const input = String(body?.input || "");
    const hasExplicitParent = input.includes("reset Gemini quota for all Antigravity users");
    const hasMissingParent = input.includes("UNAVAILABLE");
    const hasVagueParent = input.includes("please do the thing");

    if (kind === "decisions") {
      if (hasExplicitParent) {
        return {
          answers: {
            is_quota_reset: { type: "noul", noul: 0.95, confidence: 0.95 },
            is_active_now: { type: "noul", noul: 0.96, confidence: 0.96 },
            needs_context_review: { type: "noul", noul: 0.02, confidence: 0.98 },
            reset_type: { type: "choice", choice: "regular", confidence: 0.97 },
          },
        };
      }
      return {
        answers: {
          is_quota_reset: { type: "noul", noul: 0.08, confidence: 0.92 },
          is_active_now: { type: "noul", noul: 0.5, confidence: 0.5 },
          needs_context_review: {
            type: "noul",
            noul: hasMissingParent || hasVagueParent ? 0.91 : 0.05,
            confidence: 0.91,
          },
          reset_type: { type: "choice", choice: "other", confidence: 0.9 },
        },
      };
    }

    if (hasExplicitParent) {
      return {
        is_reset: true,
        needs_review: false,
        type: "regular",
        confidence: 0.96,
        models: ["Gemini"],
        reason: "Varun confirmed the requested all-users Gemini quota reset.",
        summary_i18n: {
          en: "Varun Mohan confirmed a Gemini quota reset for all Antigravity users.",
          "zh-CN": "Varun Mohan 确认已为所有 Antigravity 用户重置 Gemini 配额。",
          "zh-TW": "Varun Mohan 確認已為所有 Antigravity 使用者重置 Gemini 配額。",
          ja: "Varun Mohan 氏が全 Antigravity ユーザーの Gemini クォータリセット完了を報告しました。",
          ko: "Varun Mohan이 모든 Antigravity 사용자의 Gemini 할당량 리셋 완료를 확인했습니다.",
        },
      };
    }
    return {
      is_reset: false,
      needs_review: hasMissingParent || hasVagueParent,
      type: "other",
      confidence: 0.85,
      models: [],
      reason: "Parent context is missing or unclear for terse confirmation 'Done'.",
      summary_i18n: {
        en: "Ambiguous confirmation.",
        "zh-CN": "缺少上文的简短回复。",
        "zh-TW": "缺少上文的簡短回覆。",
        ja: "文脈不足の返信。",
        ko: "문맥이 부족한 답글.",
      },
    };
  });

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  // Case 1: "Done" replying to explicit parent post + ALSO quoting another post (must be passed separately!)
  const explicitDonePayload = makeOfficialActivityPostCreate({
    eventUuid: "evt-done-explicit",
    tweetId: "2130000000000000201",
    text: "Done",
    referencedTweets: [
      { type: "replied_to", id: "2130000000000000200" },
      { type: "quoted", id: "2130000000000000198" },
    ],
    inReplyToUserId: "2002",
    extraUsers: [
      { id: "2002", username: "dev_requester", name: "Dev Requester" },
      { id: "3003", username: "antigravity", name: "Google Antigravity" },
    ],
    extraTweets: [
      {
        id: "2130000000000000200",
        author_id: "2002",
        text: "@_mohansolo Can you reset Gemini quota for all Antigravity users for the release?",
      },
      {
        id: "2130000000000000198",
        author_id: "3003",
        text: "Antigravity 2.4 changelog is live!",
      },
    ],
  });

  const wu = makeWaitUntilCtx();
  const resExplicit = await worker.fetch(
    makeSignedWebhookRequest(explicitDonePayload),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal(resExplicit.status, 200);
  const explicitJson = await resExplicit.json();
  assert.equal(explicitJson.tweetsSeen, 1);
  assert.equal(explicitJson.resetsRecorded, 1);
  assert.equal(explicitJson.classification, "regular");
  assert.equal(telegramCalls.length, 1);

  // Verify BOTH models received separate parent post (text, author, URL) and quoted post sections
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.body.input, /Replied-to parent post author: Dev Requester \(@dev_requester\)/);
    assert.match(
      call.body.input,
      /Replied-to parent post URL: https:\/\/x\.com\/dev_requester\/status\/2130000000000000200/,
    );
    assert.match(
      call.body.input,
      /Can you reset Gemini quota for all Antigravity users for the release\?/,
    );
    assert.match(call.body.input, /Quoted post author: Google Antigravity \(@antigravity\)/);
    assert.match(
      call.body.input,
      /Quoted post URL: https:\/\/x\.com\/antigravity\/status\/2130000000000000198/,
    );
    assert.match(call.body.input, /Antigravity 2\.4 changelog is live!/);
  }

  // Case 2: "Done" with MISSING parent tweet in includes -> needs_review, NO notification
  const missingParentPayload = makeOfficialActivityPostCreate({
    eventUuid: "evt-done-missing-parent",
    tweetId: "2130000000000000202",
    text: "Done",
    referencedTweets: [{ type: "replied_to", id: "2130000000000000199" }],
    inReplyToUserId: "2002",
    extraUsers: [{ id: "2002", username: "dev_requester", name: "Dev Requester" }],
    extraTweets: [],
  });
  const resMissing = await worker.fetch(
    makeSignedWebhookRequest(missingParentPayload),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal(resMissing.status, 200);
  const missingJson = await resMissing.json();
  assert.equal(missingJson.tweetsSeen, 1);
  assert.equal(missingJson.resetsRecorded, 0);
  assert.equal(missingJson.needsReview, 1);
  assert.equal(missingJson.classification, "needs_review");
  assert.equal(telegramCalls.length, 1, "Missing-parent Done must NOT notify Telegram");

  // Case 3: "Done" with VAGUE parent tweet -> needs_review, NO notification
  const vagueParentPayload = makeOfficialActivityPostCreate({
    eventUuid: "evt-done-vague-parent",
    tweetId: "2130000000000000203",
    text: "Done",
    referencedTweets: [{ type: "replied_to", id: "2130000000000000197" }],
    inReplyToUserId: "2002",
    extraUsers: [{ id: "2002", username: "dev_requester", name: "Dev Requester" }],
    extraTweets: [
      {
        id: "2130000000000000197",
        author_id: "2002",
        text: "@_mohansolo please do the thing 🙏",
      },
    ],
  });
  const resVague = await worker.fetch(
    makeSignedWebhookRequest(vagueParentPayload),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal(resVague.status, 200);
  const vagueJson = await resVague.json();
  assert.equal(vagueJson.tweetsSeen, 1);
  assert.equal(vagueJson.resetsRecorded, 0);
  assert.equal(vagueJson.needsReview, 1);
  assert.equal(vagueJson.classification, "needs_review");
  assert.equal(telegramCalls.length, 1, "Ambiguous-parent Done must NOT notify Telegram");

  // Both missing-parent and vague-parent Done items must appear in /api/v1/admin/review
  const reviewRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/admin/review", {
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    }),
    env,
  );
  const review = await reviewRes.json();
  assert.equal(review.count, 2);
  const reviewIds = review.items.map((i) => i.tweetId).sort();
  assert.deepEqual(reviewIds, ["2130000000000000202", "2130000000000000203"]);
});

test("Banked Reset live launch approves as banked while Banked Reset teaser rejects cleanly", async () => {
  const db = createMemoryD1();
  const { mockFetch, telegramCalls } = makeMockJointFetchWithRouter((kind, body) => {
    const isLive = String(body?.input || "").includes("officially live");
    if (kind === "decisions") {
      return {
        answers: {
          is_quota_reset: { type: "noul", noul: isLive ? 0.97 : 0.02, confidence: 0.97 },
          is_active_now: { type: "noul", noul: isLive ? 0.96 : 0.01, confidence: 0.96 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: isLive ? "banked" : "other", confidence: 0.98 },
        },
      };
    }
    return {
      is_reset: isLive,
      needs_review: false,
      type: isLive ? "banked" : "other",
      confidence: 0.99,
      models: isLive ? ["Gemini"] : [],
      reason: isLive ? "Live banked reset launch." : "Teaser only, not live yet.",
      summary_i18n: {
        en: isLive ? "Banked resets are officially live!" : "Teaser.",
        "zh-CN": isLive ? "Banked Resets 正式上线！" : "预告。",
        "zh-TW": isLive ? "Banked Resets 正式上線！" : "預告。",
        ja: isLive ? "Banked Resets が公開されました。" : "予告。",
        ko: isLive ? "Banked Resets가 정식 출시되었습니다." : "예고.",
      },
    };
  });

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  const wu = makeWaitUntilCtx();

  // Teaser -> rejected, 0 resets, 0 review items, 0 notifications
  const teaserPayload = makeOfficialActivityPostCreate({
    eventUuid: "evt-banked-teaser",
    tweetId: "2130000000000000301",
    text: "Working on banked resets right now so you can save a reset for later — coming soon!",
  });
  const teaserRes = await worker.fetch(makeSignedWebhookRequest(teaserPayload), env, wu.ctx);
  await wu.flush();
  assert.equal(teaserRes.status, 200);
  const teaserJson = await teaserRes.json();
  assert.equal(teaserJson.tweetsSeen, 1);
  assert.equal(teaserJson.resetsRecorded, 0);
  assert.equal(teaserJson.needsReview, 0);
  assert.equal(teaserJson.classification, "rejected");
  assert.equal(telegramCalls.length, 0);

  // Live launch -> approved as banked, persisted in D1, 1 notification
  const launchPayload = makeOfficialActivityPostCreate({
    eventUuid: "evt-banked-launch",
    tweetId: "2130000000000000302",
    text: "Banked resets are officially live! We just dropped 1 claimable banked reset into every paid Antigravity account.",
  });
  const launchRes = await worker.fetch(makeSignedWebhookRequest(launchPayload), env, wu.ctx);
  await wu.flush();
  assert.equal(launchRes.status, 200);
  const launchJson = await launchRes.json();
  assert.equal(launchJson.tweetsSeen, 1);
  assert.equal(launchJson.resetsRecorded, 1);
  assert.equal(launchJson.classification, "banked");
  assert.equal(telegramCalls.length, 1);

  const status = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)
  ).json();
  assert.equal(status.latest.tweetId, "2130000000000000302");
  assert.equal(status.latest.type, "banked");
  assert.equal(status.latest.judgeSummary.consensus, "unanimous");
});

test("Model type disagreement (regular vs banked) enters needs_review instead of picking higher confidence or marking unanimous", async () => {
  const db = createMemoryD1();
  const { mockFetch, telegramCalls } = makeMockJointFetchWithRouter((kind) => {
    if (kind === "decisions") {
      return {
        answers: {
          is_quota_reset: { type: "noul", noul: 0.98, confidence: 0.98 },
          is_active_now: { type: "noul", noul: 0.97, confidence: 0.97 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: "regular", confidence: 0.99 },
        },
      };
    }
    return {
      is_reset: true,
      needs_review: false,
      type: "banked",
      confidence: 0.78,
      models: ["Gemini"],
      reason: "Interpreted as claimable banked reset credit.",
      summary_i18n: {
        en: "Reset credit available.",
        "zh-CN": "重置额度可用。",
        "zh-TW": "重置額度可用。",
        ja: "リセット枠が利用可能です。",
        ko: "리셋 크레딧을 사용할 수 있습니다.",
      },
    };
  });

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  const payload = makeOfficialActivityPostCreate({
    eventUuid: "evt-type-disagree",
    tweetId: "2130000000000000401",
    text: "Everyone just got a fresh Antigravity Gemini reset credit in Settings!",
  });

  const wu = makeWaitUntilCtx();
  const res = await worker.fetch(makeSignedWebhookRequest(payload), env, wu.ctx);
  await wu.flush();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tweetsSeen, 1);
  assert.equal(body.resetsRecorded, 0);
  assert.equal(body.needsReview, 1);
  assert.equal(body.classification, "needs_review");
  assert.equal(telegramCalls.length, 0);

  // Confirm NOT published to public resets
  const resets = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/resets"), env)
  ).json();
  assert.equal(resets.count, 17);
  assert.equal(
    resets.resets.some((r) => r.tweetId === "2130000000000000401"),
    false,
  );

  // Confirm held in /api/v1/admin/review with consensus === "type_disagreement" (NOT unanimous)
  const review = await (
    await worker.fetch(
      new Request("https://antigravity-resets.com/api/v1/admin/review", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env,
    )
  ).json();
  assert.equal(review.count, 1);
  assert.equal(review.items[0].tweetId, "2130000000000000401");
  assert.equal(review.items[0].report.consensus, "type_disagreement");
  assert.equal(review.items[0].report.decisionsType, "regular");
  assert.equal(review.items[0].report.flashType, "banked");
});

test("Mixed batch (1 approved + 1 needs_review) persists approved reset AND exposes needs_review item via /api/v1/admin/review and review resolution", async () => {
  const db = createMemoryD1();
  const { mockFetch, telegramCalls } = makeMockJointFetchWithRouter((kind, body) => {
    const isApprovedTweet = String(body?.input || "").includes("2130000000000000501");
    if (kind === "decisions") {
      return {
        answers: {
          is_quota_reset: { type: "noul", noul: 0.97, confidence: 0.97 },
          is_active_now: { type: "noul", noul: 0.96, confidence: 0.96 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: "regular", confidence: 0.98 },
        },
      };
    }
    if (isApprovedTweet) {
      return {
        is_reset: true,
        needs_review: false,
        type: "regular",
        confidence: 0.99,
        models: ["Gemini 4 Neon"],
        reason: "Confirmed global Gemini quota reset.",
        summary_i18n: {
          en: "Resetting Gemini 4 Neon quota for all Antigravity users!",
          "zh-CN": "已为所有 Antigravity 用户重置 Gemini 4 Neon 配额！",
          "zh-TW": "已為所有 Antigravity 使用者重置 Gemini 4 Neon 配額！",
          ja: "全ユーザーの Gemini 4 Neon クォータをリセットしました。",
          ko: "모든 사용자의 Gemini 4 Neon 할당량을 리셋합니다.",
        },
      };
    }
    // Second tweet triggers type disagreement -> needs_review
    return {
      is_reset: true,
      needs_review: false,
      type: "banked",
      confidence: 0.88,
      models: ["Gemini"],
      reason: "Uncertain whether regular or banked.",
      summary_i18n: {
        en: "Bonus reset credit live.",
        "zh-CN": "额外重置额度已上线。",
        "zh-TW": "額外重置額度已上線。",
        ja: "追加リセット枠が公開されました。",
        ko: "보너스 리셋 크레딧이 출시되었습니다.",
      },
    };
  });

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  // Official batched X Activity post.create payload containing 1 approved + 1 needs_review
  const itemA = makeOfficialActivityPostCreate({
    eventUuid: "evt-mixed-a",
    tweetId: "2130000000000000501",
    text: "Resetting Gemini 4 Neon quota for all Antigravity users!",
  }).data;
  const itemB = makeOfficialActivityPostCreate({
    eventUuid: "evt-mixed-b",
    tweetId: "2130000000000000502",
    text: "Bonus reset credit is live in your Antigravity account!",
  }).data;

  const mixedPayload = { data: [itemA, itemB] };
  const wu = makeWaitUntilCtx();
  const res = await worker.fetch(makeSignedWebhookRequest(mixedPayload), env, wu.ctx);
  await wu.flush();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tweetsSeen, 2);
  assert.equal(body.resetsRecorded, 1);
  assert.equal(body.needsReview, 1);
  assert.equal(body.classification, "mixed_needs_review");
  assert.equal(telegramCalls.length, 1, "Telegram must fire ONLY for the approved reset");

  // 1) Approved tweet IS persisted in resets
  const resets = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/resets"), env)
  ).json();
  assert.equal(resets.count, 18);
  assert.equal(
    resets.resets.some((r) => r.tweetId === "2130000000000000501"),
    true,
  );
  assert.equal(
    resets.resets.some((r) => r.tweetId === "2130000000000000502"),
    false,
  );

  // 2) needs_review tweet IS retrievable from /api/v1/admin/review
  const reviewBefore = await (
    await worker.fetch(
      new Request("https://antigravity-resets.com/api/v1/admin/review", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env,
    )
  ).json();
  assert.equal(reviewBefore.count, 1);
  assert.equal(reviewBefore.items[0].tweetId, "2130000000000000502");
  assert.equal(reviewBefore.items[0].classifiedAs, "needs_review");
  assert.equal(reviewBefore.items[0].batchClassification, "mixed_needs_review");
  assert.equal(reviewBefore.items[0].report.consensus, "type_disagreement");

  // 3) Duplicate redelivery of the mixed batch must NOT duplicate resets, review items, or Telegram alerts
  const resDup = await worker.fetch(makeSignedWebhookRequest(mixedPayload), env, wu.ctx);
  await wu.flush();
  assert.equal((await resDup.json()).resetsRecorded, 0);
  assert.equal(telegramCalls.length, 1);
  const reviewAfterDup = await (
    await worker.fetch(
      new Request("https://antigravity-resets.com/api/v1/admin/review", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env,
    )
  ).json();
  assert.equal(reviewAfterDup.count, 1);

  // 4) Operator resolves the pending review item -> approves as banked -> leaves queue and appears in /api/v1/resets
  const resolveRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/admin/review/resolve", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ADMIN_TOKEN}`,
      },
      body: JSON.stringify({
        eventHash: reviewBefore.items[0].eventHash,
        tweetId: "2130000000000000502",
        action: "approve",
        type: "banked",
      }),
    }),
    env,
  );
  assert.equal(resolveRes.status, 200);
  const resolveJson = await resolveRes.json();
  assert.equal(resolveJson.remainingPending, 0);
  assert.equal(resolveJson.reset.type, "banked");

  const reviewAfterResolve = await (
    await worker.fetch(
      new Request("https://antigravity-resets.com/api/v1/admin/review", {
        headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
      }),
      env,
    )
  ).json();
  assert.equal(reviewAfterResolve.count, 0);

  const resetsAfterResolve = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/resets"), env)
  ).json();
  assert.equal(resetsAfterResolve.count, 19);
});

test("Invalid webhook signature returns 401 without calling models or writing to DB", async () => {
  const db = createMemoryD1();
  const { mockFetch, calls, telegramCalls } = makeMockJointFetchWithRouter(() => {
    throw new Error("Models must never be called on invalid signature");
  });
  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100999",
    DB: db,
    __fetchImpl: mockFetch,
  };

  const payload = makeOfficialActivityPostCreate({
    tweetId: "2130000000000000601",
  });
  const res = await worker.fetch(
    makeSignedWebhookRequest(payload, { secret: "wrong_secret", scheme: "oauth1" }),
    env,
  );
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
  assert.equal(telegramCalls.length, 0);
  assert.equal(db._tables.webhookEvents.size, 0);
});

test("Product endpoints serve RSS /feed.xml, live /api/v1/badge.svg, and email unsubscribe", async () => {
  const db = createMemoryD1();
  const env = { DB: db };

  const feedRes = await worker.fetch(new Request("https://antigravity-resets.com/feed.xml"), env);
  assert.equal(feedRes.status, 200);
  assert.match(feedRes.headers.get("Content-Type"), /application\/rss\+xml/);
  const feedXml = await feedRes.text();
  assert.match(feedXml, /<rss version="2\.0">/);
  assert.match(feedXml, /https:\/\/x\.com\/_mohansolo\/status\/2125851902009311306/);

  const badgeRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/badge.svg"),
    env,
  );
  assert.equal(badgeRes.status, 200);
  assert.match(badgeRes.headers.get("Content-Type"), /image\/svg\+xml/);
  assert.match(await badgeRes.text(), /antigravity reset/);

  const subRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/subscribe/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "user@example.com", locale: "en" }),
    }),
    env,
  );
  assert.equal(subRes.status, 201);

  const unsubRes = await worker.fetch(
    new Request("https://antigravity-resets.com/api/v1/unsubscribe?email=user%40example.com"),
    env,
  );
  assert.equal(unsubRes.status, 200);
  assert.equal((await unsubRes.json()).removed, true);
});

test("X API v2 auto-hydrates missing parent post for 'Done' via X_BEARER_TOKEN so Tier-1 approves unanimously", async () => {
  const db = createMemoryD1();
  const xHydrateCalls = [];
  const publicTgCalls = [];
  const adminTgCalls = [];
  const judgeInputs = [];

  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.startsWith("https://api.x.com/2/tweets")) {
      xHydrateCalls.push({ url: urlStr, auth: init?.headers?.Authorization });
      return Response.json({
        data: [
          {
            id: "2130000000000000700",
            author_id: "2009",
            text: "@_mohansolo Can you reset Gemini quota for all Antigravity users right now?",
          },
        ],
        includes: {
          users: [{ id: "2009", username: "dev_requester", name: "Dev Requester" }],
        },
      });
    }
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      if (body.chat_id === "-100ADMIN") adminTgCalls.push(body);
      else publicTgCalls.push(body);
      return Response.json({ ok: true });
    }
    const body = JSON.parse(init.body);
    judgeInputs.push({ url: urlStr, model: body.model, input: body.input });
    if (urlStr.includes("/v1beta/decisions")) {
      return Response.json({
        answers: {
          is_quota_reset: { type: "noul", noul: 0.97, confidence: 0.97 },
          is_active_now: { type: "noul", noul: 0.96, confidence: 0.96 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: "regular", confidence: 0.98 },
        },
      });
    }
    return Response.json({
      id: "int_hydrated_1",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [
            {
              type: "text",
              text: JSON.stringify({
                is_reset: true,
                needs_review: false,
                type: "regular",
                confidence: 0.98,
                models: ["Gemini"],
                reason: "Hydrated parent explicitly asked for an all-users Gemini quota reset.",
                summary_i18n: {
                  en: "Varun Mohan confirmed a Gemini quota reset for all Antigravity users.",
                  "zh-CN": "Varun Mohan 确认已为所有 Antigravity 用户重置 Gemini 配额。",
                  "zh-TW": "Varun Mohan 確認已為所有 Antigravity 使用者重置 Gemini 配額。",
                  ja: "全 Antigravity ユーザーの Gemini クォータリセットが確認されました。",
                  ko: "모든 Antigravity 사용자의 Gemini 할당량 리셋이 확인되었습니다.",
                },
              }),
            },
          ],
        },
      ],
    });
  };

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    X_BEARER_TOKEN: "mock_x_bearer_token",
    GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100PUBLIC",
    ADMIN_TELEGRAM_CHAT_ID: "-100ADMIN",
    DB: db,
    __fetchImpl: mockFetch,
  };

  // Official post.create "Done" WITHOUT parent in data.includes.tweets
  const payload = makeOfficialActivityPostCreate({
    eventUuid: "evt-hydrate-done",
    tweetId: "2130000000000000701",
    text: "Done",
    referencedTweets: [{ type: "replied_to", id: "2130000000000000700" }],
    inReplyToUserId: "2009",
    extraUsers: [],
    extraTweets: [],
  });

  const wu = makeWaitUntilCtx();
  const res = await worker.fetch(makeSignedWebhookRequest(payload), env, wu.ctx);
  await wu.flush();
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tweetsSeen, 1);
  assert.equal(body.resetsRecorded, 1);
  assert.equal(body.needsReview, 0);
  assert.equal(body.classification, "regular");

  assert.equal(xHydrateCalls.length, 1);
  assert.equal(xHydrateCalls[0].auth, "Bearer mock_x_bearer_token");
  assert.match(xHydrateCalls[0].url, /ids=2130000000000000700/);
  assert.equal(judgeInputs.length, 2, "Only Tier-1 judges needed after hydration succeeds");
  for (const j of judgeInputs) {
    assert.match(j.input, /Replied-to parent post author: Dev Requester \(@dev_requester\)/);
    assert.match(j.input, /Can you reset Gemini quota for all Antigravity users right now\?/);
  }
  assert.equal(publicTgCalls.length, 1);
  assert.equal(adminTgCalls.length, 0);
});

test("Tier-2 gemini-4-neon arbitrator resolves type disagreement when confident, rejects clear non-resets, and sends private admin Telegram alert on escalation without leaking to public channel", async () => {
  const db = createMemoryD1();
  const publicTgCalls = [];
  const adminTgCalls = [];
  const arbitratorCalls = [];

  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      if (body.chat_id === "-100ADMIN") adminTgCalls.push(body);
      else publicTgCalls.push(body);
      return Response.json({ ok: true });
    }
    const body = JSON.parse(init.body);
    if (urlStr.includes("/v1beta/decisions")) {
      return Response.json({
        answers: {
          is_quota_reset: { type: "noul", noul: 0.96, confidence: 0.96 },
          is_active_now: { type: "noul", noul: 0.95, confidence: 0.95 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: "regular", confidence: 0.9 },
        },
      });
    }
    // Tier-1 Flash (causes type_disagreement by returning banked)
    if (body.model === "gemini-3.8-flash") {
      return Response.json({
        id: "int_flash",
        status: "completed",
        steps: [
          {
            type: "model_output",
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  is_reset: true,
                  needs_review: false,
                  type: "banked",
                  confidence: 0.85,
                  models: ["Gemini"],
                  reason: "Possible banked reset.",
                  summary_i18n: {
                    en: "Banked reset.",
                    "zh-CN": "留存重置。",
                    "zh-TW": "留存重置。",
                    ja: "Banked reset.",
                    ko: "Banked reset.",
                  },
                }),
              },
            ],
          },
        ],
      });
    }
    // Tier-2 Arbitrator (gemini-4-neon)
    arbitratorCalls.push(body);
    const input = String(body.input || "");
    let arbPayload;
    if (input.includes("2130000000000000801")) {
      arbPayload = {
        decision: "approve_banked",
        confidence: 0.95,
        models: ["Gemini"],
        reason: "Explicitly grants 1 claimable banked reset credit redeemable later.",
        summary_i18n: {
          en: "Every paid Antigravity account received 1 claimable banked reset credit.",
          "zh-CN": "所有 Antigravity 付费账号已获得 1 次可留存领取的配额重置额度。",
          "zh-TW": "所有 Antigravity 付費帳號已獲得 1 次可留存領取的配額重置額度。",
          ja: "有料 Antigravity アカウントに 1 回分の banked reset が付与されました。",
          ko: "유료 Antigravity 계정에 보관형 리셋 1회가 지급되었습니다.",
        },
      };
    } else if (input.includes("2130000000000000802")) {
      arbPayload = {
        decision: "reject",
        confidence: 0.96,
        models: [],
        reason: "Actually a teaser discussing an upcoming feature, not live yet.",
        summary_i18n: {
          en: "Teaser.",
          "zh-CN": "预告。",
          "zh-TW": "預告。",
          ja: "予告。",
          ko: "예고.",
        },
      };
    } else {
      arbPayload = {
        decision: "escalate_human",
        confidence: 0.62,
        models: ["Gemini"],
        reason: "Ambiguous whether immediate regular reset or claimable banked credit.",
        summary_i18n: {
          en: "Ambiguous reset credit.",
          "zh-CN": "类型存疑的重置公告。",
          "zh-TW": "類型存疑的重置公告。",
          ja: "要確認のリセット告知。",
          ko: "확인 필요한 리셋 공지.",
        },
      };
    }
    return Response.json({
      id: "int_arb",
      status: "completed",
      steps: [
        {
          type: "model_output",
          content: [{ type: "text", text: JSON.stringify(arbPayload) }],
        },
      ],
    });
  };

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    ADMIN_API_TOKEN: ADMIN_TOKEN,
    ARBITRATOR_MODEL: "gemini-4-neon",
    ENABLE_TIER2_ARBITRATOR: "true",
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100PUBLIC",
    ADMIN_TELEGRAM_CHAT_ID: "-100ADMIN",
    DB: db,
    __fetchImpl: mockFetch,
  };

  const wu = makeWaitUntilCtx();

  // Case A: Tier-2 gemini-4-neon resolves type_disagreement -> approved as banked, consensus === "tier2_arbitrated" (NOT unanimous)
  const payloadA = makeOfficialActivityPostCreate({
    eventUuid: "evt-t2-approve",
    tweetId: "2130000000000000801",
    text: "Just dropped 1 claimable banked reset credit into every paid Antigravity account!",
  });
  const resA = await worker.fetch(makeSignedWebhookRequest(payloadA), env, wu.ctx);
  await wu.flush();
  assert.equal(resA.status, 200);
  const bodyA = await resA.json();
  assert.equal(bodyA.resetsRecorded, 1);
  assert.equal(bodyA.classification, "banked");
  assert.equal(arbitratorCalls.length, 1);
  assert.equal(arbitratorCalls[0].model, "gemini-4-neon");
  assert.equal(publicTgCalls.length, 1);
  assert.equal(adminTgCalls.length, 0);
  const statusA = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)
  ).json();
  assert.equal(statusA.latest.tweetId, "2130000000000000801");
  assert.equal(statusA.latest.judgeSummary.consensus, "tier2_arbitrated");
  assert.equal(statusA.latest.judgeSummary.arbitratorModel, "gemini-4-neon");

  // Case B: Tier-2 rejects cleanly -> 0 resets, 0 review, 0 Telegram calls
  const payloadB = makeOfficialActivityPostCreate({
    eventUuid: "evt-t2-reject",
    tweetId: "2130000000000000802",
    text: "Previewing how banked reset credits will look next week!",
  });
  const resB = await worker.fetch(makeSignedWebhookRequest(payloadB), env, wu.ctx);
  await wu.flush();
  const bodyB = await resB.json();
  assert.equal(bodyB.resetsRecorded, 0);
  assert.equal(bodyB.needsReview, 0);
  assert.equal(bodyB.classification, "rejected");
  assert.equal(publicTgCalls.length, 1);
  assert.equal(adminTgCalls.length, 0);

  // Case C: Tier-2 escalates to human -> needs_review + private ADMIN_TELEGRAM_CHAT_ID notified ONCE (never public!)
  const payloadC = makeOfficialActivityPostCreate({
    eventUuid: "evt-t2-escalate",
    tweetId: "2130000000000000803",
    text: "New reset perk now active on accounts!",
  });
  const resC = await worker.fetch(makeSignedWebhookRequest(payloadC), env, wu.ctx);
  await wu.flush();
  const bodyC = await resC.json();
  assert.equal(bodyC.resetsRecorded, 0);
  assert.equal(bodyC.needsReview, 1);
  assert.equal(bodyC.classification, "needs_review");
  assert.equal(publicTgCalls.length, 1, "Escalated needs_review must NEVER post to public channel");
  assert.equal(adminTgCalls.length, 1, "Escalated needs_review must alert private admin chat");
  assert.match(adminTgCalls[0].text, /\[REVIEW NEEDED\]/);
  assert.match(adminTgCalls[0].text, /2130000000000000803/);
  assert.match(adminTgCalls[0].text, /gemini-4-neon/);

  // Duplicate redelivery of Case C must NOT spam another admin Telegram alert!
  const resCDup = await worker.fetch(makeSignedWebhookRequest(payloadC), env, wu.ctx);
  await wu.flush();
  assert.equal(resCDup.status, 200);
  assert.equal(adminTgCalls.length, 1, "Duplicate needs_review delivery must not re-alert admin");
});

test("Codex-style HTML Telegram templates & ETA lifecycle: possible watch -> Update editMessageText -> expected ETA/TBA -> confirmed clears upcomingReset", async () => {
  const db = createMemoryD1();
  const tgCalls = [];

  const mockFetch = async (url, init) => {
    const urlStr = String(url);
    if (urlStr.includes("api.telegram.org")) {
      const body = JSON.parse(init.body);
      const method = urlStr.split("/").pop();
      tgCalls.push({ method, body });
      return Response.json({ ok: true, result: { message_id: 770 + tgCalls.length } });
    }
    const body = JSON.parse(init.body);
    const input = String(body.input || "");

    const isWatch1 = input.includes("2130000000000000901");
    const isWatch2 = input.includes("2130000000000000902");
    const isExpectedEta = input.includes("2130000000000000903");
    const isExpectedTba = input.includes("2130000000000000904");
    const isConfirmed = input.includes("2130000000000000905");

    if (urlStr.includes("/v1beta/decisions")) {
      if (isWatch1 || isWatch2) {
        return Response.json({
          answers: {
            is_quota_reset: { type: "noul", noul: 0.3, confidence: 0.7 },
            is_active_now: { type: "noul", noul: 0.05, confidence: 0.95 },
            is_scheduled_upcoming: { type: "noul", noul: 0.15, confidence: 0.85 },
            is_possible_hint: { type: "noul", noul: 0.94, confidence: 0.94 },
            needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
            reset_type: { type: "choice", choice: isWatch2 ? "banked" : "regular", confidence: 0.85 },
          },
        });
      }
      if (isExpectedEta || isExpectedTba) {
        return Response.json({
          answers: {
            is_quota_reset: { type: "noul", noul: 0.95, confidence: 0.95 },
            is_active_now: { type: "noul", noul: 0.1, confidence: 0.9 },
            is_scheduled_upcoming: { type: "noul", noul: 0.96, confidence: 0.96 },
            is_possible_hint: { type: "noul", noul: 0.05, confidence: 0.95 },
            needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
            reset_type: { type: "choice", choice: isExpectedTba ? "banked" : "regular", confidence: 0.97 },
          },
        });
      }
      return Response.json({
        answers: {
          is_quota_reset: { type: "noul", noul: 0.98, confidence: 0.98 },
          is_active_now: { type: "noul", noul: 0.97, confidence: 0.97 },
          is_scheduled_upcoming: { type: "noul", noul: 0.02, confidence: 0.98 },
          is_possible_hint: { type: "noul", noul: 0.01, confidence: 0.99 },
          needs_context_review: { type: "noul", noul: 0.01, confidence: 0.99 },
          reset_type: { type: "choice", choice: "regular", confidence: 0.99 },
        },
      });
    }

    // Flash response
    let flashObj;
    if (isWatch1) {
      flashObj = {
        is_reset: false,
        reset_stage: "possible",
        expected_by_iso: "",
        needs_review: false,
        type: "regular",
        confidence: 0.91,
        models: ["Gemini"],
        reason: "Playful hint about returning with a reset.",
        summary_i18n: { en: "Maybe time for a reset.", "zh-CN": "可能准备重置。", "zh-TW": "可能準備重置。", ja: "リセット示唆。", ko: "리셋 암시." },
      };
    } else if (isWatch2) {
      flashObj = {
        is_reset: false,
        reset_stage: "possible",
        expected_by_iso: "2026-11-13T08:00:00Z",
        needs_review: false,
        type: "banked",
        confidence: 0.92,
        models: ["Gemini"],
        reason: "Follow-up hint pointing to Thursday.",
        summary_i18n: { en: "Thursday banked reset hint.", "zh-CN": "周四可能发放留存重置。", "zh-TW": "週四可能發放留存重置。", ja: "木曜示唆。", ko: "목요일 암시." },
      };
    } else if (isExpectedEta) {
      flashObj = {
        is_reset: true,
        reset_stage: "expected",
        expected_by_iso: "2026-10-28T07:00:00Z",
        needs_review: false,
        type: "regular",
        confidence: 0.96,
        models: ["Gemini"],
        reason: "Concrete commitment landing by midnight PST.",
        summary_i18n: { en: "Lands by midnight PST.", "zh-CN": "太平洋午夜前生效。", "zh-TW": "太平洋午夜前生效。", ja: "PST深夜までに反映。", ko: "PST 자정 전 반영." },
      };
    } else if (isExpectedTba) {
      flashObj = {
        is_reset: true,
        reset_stage: "expected",
        expected_by_iso: "",
        needs_review: false,
        type: "banked",
        confidence: 0.96,
        models: ["Gemini"],
        reason: "Unconditional banked reset commitment with time TBA.",
        summary_i18n: { en: "Adding one banked reset for everyone.", "zh-CN": "将为所有人追加一次留存重置。", "zh-TW": "將為所有人追加一次留存重置。", ja: "全員に banked reset 追加予定。", ko: "모두에게 적립 리셋 추가 예정." },
      };
    } else if (isConfirmed) {
      flashObj = {
        is_reset: true,
        reset_stage: "confirmed",
        expected_by_iso: "",
        needs_review: false,
        type: "regular",
        confidence: 0.99,
        models: ["Gemini"],
        reason: "Confirmed propagated reset.",
        summary_i18n: { en: "Antigravity usage limits have been reset.", "zh-CN": "Antigravity 配额已重置生效。", "zh-TW": "Antigravity 配額已重置生效。", ja: "クォータがリセットされました。", ko: "할당량이 초기화되었습니다." },
      };
    }

    return Response.json({
      id: "int_tpl",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: JSON.stringify(flashObj) }] }],
    });
  };

  const env = {
    X_API_KEY_SECRET: LEGACY_SECRET,
    GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "mock_tg_token",
    TELEGRAM_CHAT_ID: "-100PUBLIC",
    SITE_URL: "https://antigravity-resets.com",
    DB: db,
    __fetchImpl: mockFetch,
  };
  const wu = makeWaitUntilCtx();

  // 1. Possible Watch #1
  const resW1 = await worker.fetch(
    makeSignedWebhookRequest(
      makeOfficialActivityPostCreate({
        eventUuid: "evt-w1",
        tweetId: "2130000000000000901",
        createdAt: "2026-11-11T01:00:00Z",
        text: "It's been a while without resets. Maybe I should come back out of the basement",
      }),
    ),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal((await resW1.json()).classification, "possible");
  assert.equal(tgCalls.length, 1);
  assert.equal(tgCalls[0].method, "sendMessage");
  assert.equal(tgCalls[0].body.parse_mode, "HTML");
  assert.match(tgCalls[0].body.text, /⚠️ <b>Possible Antigravity reset<\/b>/);
  assert.match(tgCalls[0].body.text, /<blockquote>It's been a while without resets.* - Varun<\/blockquote>/);
  assert.match(tgCalls[0].body.text, /Track this watch on <a href="https:\/\/antigravity-resets\.com">antigravity-resets\.com<\/a>/);

  // 2. Possible Watch Update #2 -> edits existing Telegram message in-place with `<i>Update:</i>` + ETA!
  const resW2 = await worker.fetch(
    makeSignedWebhookRequest(
      makeOfficialActivityPostCreate({
        eventUuid: "evt-w2",
        tweetId: "2130000000000000902",
        createdAt: "2026-11-11T02:00:00Z",
        text: "Thursday is feeling good to me. Perhaps also a good time for a banked reset.",
      }),
    ),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal((await resW2.json()).expectedRecorded, 1);
  assert.equal(tgCalls.length, 2);
  assert.equal(tgCalls[1].method, "editMessageText");
  assert.equal(tgCalls[1].body.message_id, 771);
  assert.match(tgCalls[1].body.text, /⚠️ <b>Possible Antigravity reset by Nov 13, 08:00 UTC<\/b>/);
  assert.match(tgCalls[1].body.text, /<i>Update:<\/i>\n<blockquote>Thursday is feeling good.* - Varun<\/blockquote>/);

  // 3. Expected Reset WITH concrete ETA -> `🗓 Antigravity reset expected by Oct 28, 07:00 UTC`
  const resEta = await worker.fetch(
    makeSignedWebhookRequest(
      makeOfficialActivityPostCreate({
        eventUuid: "evt-eta",
        tweetId: "2130000000000000903",
        createdAt: "2026-11-27T20:00:00Z",
        text: "Lands by midnight PST.",
      }),
    ),
    env,
    wu.ctx,
  );
  await wu.flush();
  const etaJson = await resEta.json();
  assert.equal(etaJson.classification, "expected");
  assert.equal(etaJson.expectedRecorded, 1);
  assert.equal(etaJson.resetsRecorded, 0);
  assert.equal(tgCalls[2].method, "sendMessage");
  assert.match(tgCalls[2].body.text, /🗓 <b>Antigravity reset expected by Oct 28, 07:00 UTC<\/b>/);
  assert.match(tgCalls[2].body.text, /<blockquote>Lands by midnight PST\. - Varun<\/blockquote>/);
  assert.match(tgCalls[2].body.text, /Track the announced reset on <a href="https:\/\/antigravity-resets\.com">antigravity-resets\.com<\/a>/);

  // Status API exposes upcomingReset
  const statusDuringExpected = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)
  ).json();
  assert.equal(statusDuringExpected.upcomingReset.tweetId, "2130000000000000903");
  assert.equal(statusDuringExpected.upcomingReset.expectedBy, "2026-10-28T07:00:00Z");

  // 4. Expected Reset with Time TBA -> `🗓 Antigravity reset expected time to be announced`
  const resTba = await worker.fetch(
    makeSignedWebhookRequest(
      makeOfficialActivityPostCreate({
        eventUuid: "evt-tba",
        tweetId: "2130000000000000904",
        createdAt: "2026-11-27T21:00:00Z",
        text: "As a small token to apologize for the mistake, we'll be adding one banked reset for everyone.",
      }),
    ),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal((await resTba.json()).expectedRecorded, 1);
  assert.match(tgCalls[3].body.text, /🗓 <b>Antigravity reset expected time to be announced<\/b>/);

  // 5. Confirmed Reset lands -> `✅ Antigravity reset confirmed` AND clears upcomingReset to null!
  const resConf = await worker.fetch(
    makeSignedWebhookRequest(
      makeOfficialActivityPostCreate({
        eventUuid: "evt-conf",
        tweetId: "2130000000000000905",
        createdAt: "2026-11-28T07:05:00Z",
        text: "Antigravity usage limits have been reset. Check your limits.",
      }),
    ),
    env,
    wu.ctx,
  );
  await wu.flush();
  assert.equal((await resConf.json()).resetsRecorded, 1);
  assert.match(tgCalls[4].body.text, /✅ <b>Antigravity reset confirmed<\/b>/);
  assert.match(tgCalls[4].body.text, /<blockquote>Antigravity usage limits have been reset\. Check your limits\. - Varun<\/blockquote>/);
  assert.match(tgCalls[4].body.text, /Tracked by <a href="https:\/\/antigravity-resets\.com">antigravity-resets\.com<\/a>/);

  const statusAfterConfirmed = await (
    await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)
  ).json();
  assert.equal(statusAfterConfirmed.latest.tweetId, "2130000000000000905");
  assert.equal(statusAfterConfirmed.upcomingReset, null);
});

function telegramDeliveryFixture(stage, telegramFetch) {
  const { mockFetch } = makeMockJointFetchWithRouter((kind) => kind === "decisions" ? {
    answers: {
      is_quota_reset: { noul: stage === "possible" ? 0.3 : 0.98 },
      is_active_now: { noul: stage === "confirmed" ? 0.98 : 0.05 },
      is_scheduled_upcoming: { noul: stage === "expected" ? 0.98 : 0.05 },
      is_possible_hint: { noul: stage === "possible" ? 0.98 : 0.01 },
      needs_context_review: { noul: 0.01 },
      reset_type: { choice: "regular", confidence: 0.99 },
    },
  } : {
    is_reset: stage !== "possible", reset_stage: stage, needs_review: false,
    expected_by_iso: "", type: "regular", confidence: 0.99,
    models: ["Gemini"], reason: "Official reset announcement.",
    summary_i18n: { en: "Antigravity quota reset announcement." },
  });
  return {
    X_API_KEY_SECRET: LEGACY_SECRET, GEMINI_API_KEY: GEMINI_KEY,
    TELEGRAM_BOT_TOKEN: "synthetic-telegram-secret", TELEGRAM_CHAT_ID: "@antigravity_resets_alert",
    DB: createMemoryD1(),
    __fetchImpl: (url, init) => String(url).includes("api.telegram.org")
      ? telegramFetch(url, init) : mockFetch(url, init),
  };
}

test("Confirmed and expected Telegram response failures are logged safely while preserving D1 records", async (t) => {
  for (const stage of ["confirmed", "expected"]) {
    for (const [label, responder] of [
      ["HTTP", async () => Response.json({ ok: false, error_code: 403 }, { status: 403 })],
      ["API", async () => Response.json({ ok: false, error_code: 400, result: { message_id: 666 } })],
      ["invalid JSON", async () => new Response("not JSON")],
      ["network", async (url) => { throw new Error(`Failed to fetch ${url}`); }],
    ]) {
      await t.test(`${stage}: ${label}`, async (st) => {
        const error = st.mock.method(console, "error", () => {});
        const log = st.mock.method(console, "log", () => {});
        const env = telegramDeliveryFixture(stage, responder);
        const wu = makeWaitUntilCtx();
        const result = await worker.fetch(makeSignedWebhookRequest(makeOfficialActivityPostCreate()), env, wu.ctx);
        await wu.flush();
        assert.equal(result.status, 200);
        const body = await result.json();
        assert.equal(stage === "confirmed" ? body.resetsRecorded : body.expectedRecorded, 1);
        assert.equal(error.mock.calls.length, 1);
        assert.equal(log.mock.calls.length, 0, "Rejected sends must not log success");
        const text = error.mock.calls[0].arguments[0];
        assert.ok(!text.includes(env.TELEGRAM_BOT_TOKEN));
        assert.equal(JSON.parse(text).event, stage === "confirmed" ? "telegram_notify_failed" : "telegram_expected_notify_failed");
        if (stage === "expected") {
          const status = await (await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)).json();
          assert.equal(status.upcomingReset.telegramMessageId, null, "API rejection must not persist a message ID");
        }
      });
    }
  }
});

test("Telegram edit API rejection is logged and falls back to a new watch message", async (t) => {
  const error = t.mock.method(console, "error", () => {});
  t.mock.method(console, "log", () => {});
  const methods = [];
  const env = telegramDeliveryFixture("possible", async (url) => {
    const method = String(url).split("/").pop();
    methods.push(method);
    return Response.json(method === "editMessageText"
      ? { ok: false, error_code: 400 }
      : { ok: true, result: { message_id: 700 + methods.length } });
  });
  const wu = makeWaitUntilCtx();
  for (const tweetId of ["2130000000000000991", "2130000000000000992"]) {
    const response = await worker.fetch(makeSignedWebhookRequest(makeOfficialActivityPostCreate({
      tweetId, eventUuid: `evt-${tweetId}`, text: "Maybe time for an Antigravity quota reset.",
    })), env, wu.ctx);
    await wu.flush();
    assert.equal((await response.json()).expectedRecorded, 1);
  }
  assert.deepEqual(methods, ["sendMessage", "editMessageText", "sendMessage"]);
  assert.equal(JSON.parse(error.mock.calls[0].arguments[0]).event, "telegram_expected_edit_failed");
  const status = await (await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)).json();
  assert.equal(status.upcomingReset.telegramMessageId, "703");
});

test("Replaying a watch update after confirmation cannot resurrect the watch or broadcast again", async (t) => {
  t.mock.method(console, "log", () => {});
  const methods = [];
  const telegramFetch = async (url) => {
    methods.push(String(url).split("/").pop());
    return Response.json({ ok: true, result: { message_id: 800 + methods.length } });
  };
  const env = telegramDeliveryFixture("possible", telegramFetch);
  const wu = makeWaitUntilCtx();
  const posts = ["2130000000000000981", "2130000000000000982"].map((tweetId) =>
    makeOfficialActivityPostCreate({
      tweetId, eventUuid: `evt-${tweetId}`, createdAt: "2026-11-27T12:00:00Z",
      text: "Maybe time for an Antigravity quota reset.",
    }));
  for (const payload of posts) {
    await worker.fetch(makeSignedWebhookRequest(payload), env, wu.ctx);
    await wu.flush();
  }
  const confirmed = telegramDeliveryFixture("confirmed", telegramFetch);
  confirmed.DB = env.DB;
  await worker.fetch(makeSignedWebhookRequest(makeOfficialActivityPostCreate({
    tweetId: "2130000000000000983", eventUuid: "evt-confirmed",
    createdAt: "2026-11-28T12:00:00Z",
  })), confirmed, wu.ctx);
  await wu.flush();
  assert.deepEqual(methods, ["sendMessage", "editMessageText", "sendMessage"]);

  for (const eventUuid of [posts[1].data.event_uuid, "redelivery-new-envelope"]) {
    posts[1].data.event_uuid = eventUuid;
    const response = await worker.fetch(makeSignedWebhookRequest(posts[1]), env, wu.ctx);
    await wu.flush();
    assert.equal((await response.json()).expectedRecorded, 0);
  }
  assert.equal(methods.length, 3, "The confirmed watch update must never broadcast again");
  const status = await (await worker.fetch(new Request("https://antigravity-resets.com/api/v1/status"), env)).json();
  assert.equal(status.upcomingReset, null);
});
