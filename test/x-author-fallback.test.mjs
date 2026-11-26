import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { parseWebhookPayload } from "../src/reset-classifier.mjs";
import worker from "../src/x-webhook.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";

const AUTHOR_ID = "1086145626633494528";
const SECRET = "test_x_author_fallback_secret";
const knownAuthorsById = new Map([
  [AUTHOR_ID, { username: "_mohansolo", name: "Varun Mohan" }],
]);

function event(overrides = {}) {
  return {
    data: {
      event_uuid: "evt-no-author-expansion",
      event_type: "post.create",
      filter: { user_id: AUTHOR_ID },
      payload: {
        id: "2130000000000001001",
        author_id: AUTHOR_ID,
        created_at: "2026-11-26T20:00:00Z",
        text: "Resetting Gemini quota for all Antigravity users right now!",
        ...overrides,
      },
    },
  };
}

test("known payload author ID supplies username when Activity expansions are absent or partial", () => {
  for (const includes of [undefined, {}, { users: [{ id: AUTHOR_ID }] }]) {
    const payload = event();
    if (includes) payload.data.includes = includes;
    const result = parseWebhookPayload(payload, { knownAuthorsById });
    assert.deepEqual(result.errors, []);
    assert.equal(result.tweets[0].authorHandle, "@_mohansolo");
    assert.equal(result.tweets[0].authorName, "Varun Mohan");
  }
});

test("filter ID never supplies author identity when payload author ID is absent or different", () => {
  for (const author_id of [undefined, "999999999999999999"]) {
    const result = parseWebhookPayload(event({ author_id }), { knownAuthorsById });
    assert.equal(result.tweets.length, 0);
    assert.deepEqual(result.errors[0].missingFields, ["author_username"]);
  }
  // Previously the filter ID could select an expanded watched user despite
  // the payload lacking an author ID altogether.
  const payload = event({ author_id: undefined });
  payload.data.includes = { users: [{ id: AUTHOR_ID, username: "_mohansolo" }] };
  assert.equal(parseWebhookPayload(payload, { knownAuthorsById }).tweets.length, 0);
});

test("actual author expansion takes precedence over known fallback and unrelated events stay ignored", () => {
  const payload = event();
  payload.data.includes = { users: [{ id: AUTHOR_ID, username: "renamed_account", name: "Current Name" }] };
  const result = parseWebhookPayload(payload, { knownAuthorsById });
  assert.equal(result.tweets[0].authorHandle, "@renamed_account");
  assert.equal(result.tweets[0].authorName, "Current Name");
  payload.data.event_type = "post.reply.create";
  assert.equal(parseWebhookPayload(payload, { knownAuthorsById }).tweets.length, 0);
});

for (const reply of [false, true]) {
  test(`signed Activity ${reply ? "reply" : "original"} without author expansion reaches Telegram once`, async () => {
    const payload = event(reply ? {
      text: "Done",
      in_reply_to_tweet_id: "2130000000000000999",
      in_reply_to_user_id: AUTHOR_ID,
    } : {});
    if (reply) {
      payload.data.includes = {
        tweets: [{
          id: "2130000000000000999",
          author_id: AUTHOR_ID,
          text: "We will reset Gemini quota for all Antigravity users.",
        }],
      };
    }
    const calls = [];
    const env = {
      X_API_KEY_SECRET: SECRET,
      GEMINI_API_KEY: "mock_gemini_key",
      TELEGRAM_BOT_TOKEN: "mock_telegram_token",
      TELEGRAM_CHAT_ID: "-100999",
      DB: createMemoryD1(),
      __fetchImpl: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        if (String(url).includes("api.telegram.org")) {
          return Response.json({ ok: true, result: { message_id: 1 } });
        }
        if (String(url).includes("/v1beta/decisions")) {
          return Response.json({ answers: {
            is_quota_reset: { type: "noul", noul: 0.99, confidence: 0.99 },
            is_active_now: { type: "noul", noul: 0.99, confidence: 0.99 },
            reset_type: { type: "choice", choice: "regular", confidence: 0.99 },
          } });
        }
        assert.match(String(url), /\/v1\/interactions$/);
        const verdict = {
          is_reset: true, reset_stage: "confirmed", expected_by_iso: "",
          needs_review: false, type: "regular", confidence: 0.99,
          models: ["Gemini"], reason: "Broad reset confirmed.",
          summary_i18n: { en: "Quota reset confirmed.", "zh-CN": "配额已重置。", "zh-TW": "配額已重置。", ja: "リセット完了。", ko: "리셋 완료." },
        };
        return Response.json({ status: "completed", steps: [{
          type: "model_output", content: [{ type: "text", text: JSON.stringify(verdict) }],
        }] });
      },
    };
    const pending = [];
    const ctx = { waitUntil(promise) { pending.push(promise); } };
    const raw = JSON.stringify(payload);
    const signature = `sha256=${crypto.createHmac("sha256", SECRET).update(raw).digest("base64")}`;
    const request = () => new Request("https://webhooks.antigravity-resets.com/api/webhooks/x", {
      method: "POST", body: raw,
      headers: { "Content-Type": "application/json", "X-Twitter-Webhooks-Signature": signature },
    });
    const first = await worker.fetch(request(), env, ctx);
    await Promise.all(pending.splice(0));
    assert.equal(first.status, 200);
    assert.equal((await first.json()).resetsRecorded, 1);
    assert.equal(calls.filter((call) => call.url.includes("api.telegram.org")).length, 1);
    const modelCalls = calls.filter((call) => call.url.includes("googleapis.com"));
    assert.equal(modelCalls.length, 2);
    if (reply) {
      assert.ok(modelCalls.every((call) => String(call.body.input).includes("We will reset Gemini quota")));
    }
    const duplicate = await worker.fetch(request(), env, ctx);
    await Promise.all(pending.splice(0));
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).resetsRecorded, 0);
    assert.equal(calls.filter((call) => call.url.includes("api.telegram.org")).length, 1);
  });
}
