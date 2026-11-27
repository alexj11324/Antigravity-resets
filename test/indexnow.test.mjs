// IndexNow contract: the key file proves host control, the cron pushes once per
// new reset, and a failed push must not poison the stored watermark.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { pingIndexNow } from "../src/indexnow.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";
import { ensureSeeded } from "../src/store.mjs";

const SITE = "https://antigravity-resets.com";
const KEY = "0123456789abcdef0123456789abcdef";

test("the key file is served as plain text at the root", async () => {
  const res = await worker.fetch(
    new Request(`${SITE}/${KEY}.txt`),
    { INDEXNOW_KEY: KEY },
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/plain/);
  assert.equal(await res.text(), KEY);
});

test("a new reset triggers exactly one push and records the watermark", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    return new Response(null, { status: 202 });
  };

  const first = await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, fetchImpl);
  assert.equal(first.status, "sent");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.indexnow.org/indexnow");
  assert.equal(calls[0].body.key, KEY);
  assert.ok(calls[0].signal instanceof AbortSignal, "a hung endpoint must time out");
  assert.ok(calls[0].body.urlList.includes(`${SITE}/history`));
  assert.ok(calls[0].body.urlList.includes(`${SITE}/ja/history`));

  const second = await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, fetchImpl);
  assert.equal(second.status, "unchanged");
  assert.equal(calls.length, 1, "the same reset must not be pushed again");
});

test("a rejected push leaves the watermark untouched so a later tick retries", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  let calls = 0;
  const fail = async () => {
    calls += 1;
    return new Response(null, { status: 422 });
  };
  await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, fail);
  const state = await db
    .prepare("SELECT value FROM site_state WHERE key = 'indexnow_last_reset'")
    .first();
  assert.ok(!state, "a rejected push must not advance the watermark");

  // After the backoff window the same reset is attempted again.
  await db
    .prepare("UPDATE site_state SET value = ? WHERE key = 'indexnow_last_attempt'")
    .bind(String(Date.now() - 16 * 60 * 1000))
    .run();
  const retry = await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, async () => {
    calls += 1;
    return new Response(null, { status: 202 });
  });
  assert.equal(retry.status, "sent");
  assert.equal(calls, 2);
});

test("a 429 backs off instead of hammering the endpoint every tick", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  let calls = 0;
  const reject = async () => {
    calls += 1;
    return new Response(null, { status: 429 });
  };
  const first = await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, reject);
  assert.equal(first.status, "error");
  const second = await pingIndexNow({ DB: db, INDEXNOW_KEY: KEY }, reject);
  assert.equal(second.status, "backoff");
  assert.equal(calls, 1, "the retry must wait out the backoff window");
});

test("a success clears the backoff for the next reset", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  await pingIndexNow(
    { DB: db, INDEXNOW_KEY: KEY },
    async () => new Response(null, { status: 429 }),
  );
  await db
    .prepare("UPDATE site_state SET value = ? WHERE key = 'indexnow_last_attempt'")
    .bind(String(Date.now() - 16 * 60 * 1000))
    .run();
  const sent = await pingIndexNow(
    { DB: db, INDEXNOW_KEY: KEY },
    async () => new Response(null, { status: 202 }),
  );
  assert.equal(sent.status, "sent");
  const attempt = await db
    .prepare("SELECT value FROM site_state WHERE key = 'indexnow_last_attempt'")
    .first();
  assert.ok(!attempt, "a success must clear the backoff");
});

test("without a key or database the ping is a no-op", async () => {
  assert.equal((await pingIndexNow({}, async () => new Response(null))).status, "skipped");
  assert.equal(
    (await pingIndexNow({ DB: createMemoryD1() }, async () => new Response(null))).status,
    "skipped",
  );
});
