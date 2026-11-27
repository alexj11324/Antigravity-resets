import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { recordWebhookEventAndResets } from "../src/store.mjs";
import { drainXPosts } from "../src/x-posts.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";

const NOW = Date.parse("2026-11-27T03:25:00Z");
const START = "2026-11-27T03:00:00Z";
const SOURCE_TIME = "2026-11-27T03:20:00Z";
const SITE = "https://antigravity-resets.com/";
const IDENTITY = "https://api.x.com/2/users/me";
const ENDPOINT = "https://api.x.com/2/tweets";
const correctUser = () => Response.json({ data: { username: "agy_resets" } });
const posted = () => Response.json({ data: { id: "9001" } }, { status: 201 });

const reset = (id, timestamp = SOURCE_TIME) => ({
  id: `r-${id}`, tweetId: id, timestamp, type: "regular", authorHandle: "_mohansolo",
  authorName: "Varun Mohan", models: [], url: `https://x.com/_mohansolo/status/${id}`,
  quoteText: "Source text", summary: { en: "Summary" },
});
const watch = (id, status = "expected") => ({
  ...reset(id), id: `w-${id}`, announcedAt: SOURCE_TIME, status,
});
const environment = (db) => ({
  DB: db, X_POST_API_KEY: "key", X_POST_API_KEY_SECRET: "key&secret",
  X_POST_ACCESS_TOKEN: "token", X_POST_ACCESS_TOKEN_SECRET: "token/secret",
  X_POSTS_START_AT: START,
});
const deliveries = (db) => db.sql.prepare("SELECT * FROM x_post_deliveries ORDER BY event_seq").all();

async function record(db, { resets = [], watches = [] } = {}) {
  await recordWebhookEventAndResets(db, {
    eventHash: crypto.randomUUID(), signatureScheme: "oauth2", eventType: "post.create",
    primaryTweet: null, classifiedResets: resets, announcedResets: watches, rawPayload: "{}",
  });
  db.sql.prepare("UPDATE telegram_outbox SET created_at = ?").run(SOURCE_TIME);
}

function assertSignature(url, { method, headers, redirect }) {
  assert.equal(redirect, "error");
  const params = Object.fromEntries([...headers.Authorization.matchAll(/(oauth_\w+)="([^"]+)"/g)]
    .map(([, key, value]) => [key, decodeURIComponent(value)]));
  const { oauth_signature: signature, ...unsigned } = params;
  assert.equal(unsigned.oauth_consumer_key, "key");
  assert.equal(unsigned.oauth_token, "token");
  const normalized = Object.entries(unsigned).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  const base = [method, url, normalized].map(encodeURIComponent).join("&");
  assert.equal(signature, createHmac("sha1", "key%26secret&token%2Fsecret").update(base).digest("base64"));
}

test("durable X posts distinguish expected and confirmed, cite the source, and do not replay", async () => {
  const db = createMemoryD1();
  const env = environment(db);
  await record(db, { watches: [watch("1")] });
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assertSignature(url, init);
    if (url === IDENTITY) return correctUser();
    assert.equal(url, ENDPOINT);
    bodies.push(JSON.parse(init.body));
    return posted();
  };
  assert.equal((await drainXPosts(env, { now: () => NOW, fetchImpl })).status, "sent");
  await record(db, { resets: [reset("2")] });
  await record(db, { resets: [reset("2")] });
  assert.equal((await drainXPosts(env, { now: () => NOW, fetchImpl })).status, "sent");
  assert.equal((await drainXPosts(env, { now: () => NOW, fetchImpl })).status, "idle");
  assert.deepEqual(bodies, [
    { text: `🗓️ Antigravity quota reset expected. Execution has not been confirmed.\n\n${SITE}\nhttps://x.com/_mohansolo/status/1` },
    { text: `✅ Antigravity quota reset confirmed.\n\n${SITE}\nhttps://x.com/_mohansolo/status/2` },
  ]);
  assert.deepEqual(deliveries(db).map(row => row.post_id), ["9001", "9001"]);
  assert.deepEqual(db.sql.prepare("SELECT DISTINCT status FROM telegram_outbox").all()
    .map(row => row.status), ["pending"]);
});

test("activation excludes historical posts, late deliveries and closed or tentative announcements", async () => {
  const db = createMemoryD1();
  await record(db, { watches: [watch("1"), watch("2", "possible")] });
  db.sql.prepare("UPDATE announced_resets SET status = 'expired' WHERE id = 'w-1'").run();
  await record(db, { resets: [reset("3", "2026-11-27T02:50:00Z"), reset("4")] });
  db.sql.prepare("UPDATE telegram_outbox SET created_at = ? WHERE entity_id = 'r-4'")
    .run("2026-11-27T02:55:00.000Z");
  let calls = 0;
  const fetchImpl = async () => { calls++; return posted(); };
  assert.equal((await drainXPosts(environment(db), { fetchImpl, now: () => NOW })).status, "idle");
  assert.equal((await drainXPosts({ DB: db }, { fetchImpl })).status, "unconfigured");
  assert.equal(calls, 0);
  assert.equal(deliveries(db).length, 0);
});

test("wrong account and concurrent claims cannot publish an extra post", async () => {
  const db = createMemoryD1();
  const env = environment(db);
  await record(db, { resets: [reset("1")] });
  let calls = 0;
  const wrong = await drainXPosts(env, {
    now: () => NOW,
    fetchImpl: async (url) => {
      calls++;
      assert.equal(url, IDENTITY);
      return Response.json({ data: { username: "different_account" } });
    },
  });
  assert.equal(wrong.status, "identity_failed");
  assert.equal(calls, 1);
  assert.equal(deliveries(db).length, 0);

  let posts = 0;
  const options = {
    now: () => NOW,
    fetchImpl: async (url) => {
      if (url === IDENTITY) return correctUser();
      posts++;
      return posted();
    },
  };
  const results = await Promise.all([drainXPosts(env, options), drainXPosts(env, options)]);
  assert.equal(results.filter(r => r.status === "sent").length, 1);
  assert.equal(posts, 1);
});

test("only a rate-limit rejection retries; an uncertain send stays held", async () => {
  const db = createMemoryD1();
  const env = environment(db);
  await record(db, { resets: [reset("1"), reset("2")] });
  let time = NOW;
  let posts = 0;
  const options = {
    now: () => time,
    fetchImpl: async (url) => {
      if (url === IDENTITY) return correctUser();
      if (++posts === 1) return new Response(null, { status: 429, headers: { "Retry-After": "90" } });
      if (posts === 2) return new Response(null, { status: 502 });
      return posted();
    },
  };
  assert.equal((await drainXPosts(env, options)).status, "retry");
  time += 89_000;
  assert.equal((await drainXPosts(env, options)).status, "idle");
  time += 1_000;
  assert.equal((await drainXPosts(env, options)).status, "ambiguous");
  assert.equal((await drainXPosts(env, options)).status, "sent");
  assert.equal((await drainXPosts(env, options)).status, "idle");
  assert.equal(posts, 3);
  assert.deepEqual(deliveries(db).map(row => row.status), ["ambiguous", "sent"]);
});

test("a batch publishes fresh events without retrying an expired send claim", async () => {
  const db = createMemoryD1();
  await record(db, { resets: [reset("1"), reset("2"), reset("3")] });
  db.sql.prepare("INSERT INTO x_post_deliveries (event_seq, status, lease_until) VALUES (1, 'sending', ?)")
    .run(NOW - 1);
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return url === IDENTITY ? correctUser() : posted();
  };
  assert.equal((await drainXPosts(environment(db), { now: () => NOW, fetchImpl })).status, "sent");
  assert.deepEqual(calls, [IDENTITY, ENDPOINT, ENDPOINT]);
  assert.deepEqual(deliveries(db).map(row => [row.status, row.last_error]), [
    ["ambiguous", "lease_expired"], ["sent", null], ["sent", null],
  ]);
});
