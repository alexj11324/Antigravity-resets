// Double opt-in guarantees: an address somebody else typed must never receive
// mail, and a pending submission must not be able to weaken a confirmed row.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";
import {
  addEmailSubscription,
  confirmEmailSubscription,
  listEmailSubscribers,
} from "../src/store.mjs";

const SITE = "https://antigravity-resets.com";

test("unconfirmed addresses never receive alerts", async () => {
  const db = createMemoryD1();
  await addEmailSubscription(db, { email: "Pending@Example.com", confirmed: 0 });
  assert.equal((await listEmailSubscribers(db)).length, 0, "pending must not be mailed");

  await confirmEmailSubscription(db, "pending@example.com");
  const subs = await listEmailSubscribers(db);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].email, "pending@example.com");
});

test("a pending submission cannot downgrade or relocalize a confirmed address", async () => {
  const db = createMemoryD1();
  await addEmailSubscription(db, { email: "a@example.com", locale: "en", confirmed: 1 });
  // Someone re-submitting the address unconfirmed must not clear the flag.
  await addEmailSubscription(db, { email: "a@example.com", locale: "ja", confirmed: 0 });

  const subs = await listEmailSubscribers(db);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].locale, "en", "confirmed row keeps its locale");
});

test("confirming an unknown address does not create one", async () => {
  const db = createMemoryD1();
  const res = await confirmEmailSubscription(db, "ghost@example.com");
  assert.equal(res.confirmed, false);
  assert.equal((await listEmailSubscribers(db)).length, 0);
});

test("with a mail transport, subscribe returns 202 and mails a confirmation link", async (t) => {
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "test-secret",
    RESEND_API_KEY: "test-key",
    RESEND_FROM_EMAIL: "alerts@antigravity-resets.com",
  };

  const res = await worker.fetch(
    new Request(`${SITE}/api/v1/subscribe/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new@example.com", locale: "en" }),
    }),
    env,
  );
  assert.equal(res.status, 202);
  assert.equal((await res.json()).pendingConfirmation, true);

  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /api\.resend\.com\/emails/);
  assert.match(sent[0].body.html, /\/api\/v1\/confirm\?email=/);

  // Still not mailable until the link is followed.
  assert.equal((await listEmailSubscribers(db)).length, 0);

  const confirmUrl = sent[0].body.html.match(/href="([^"]*\/api\/v1\/confirm[^"]*)"/)[1]
    .replace(/&amp;/g, "&");
  const confirmRes = await worker.fetch(new Request(confirmUrl), env);
  assert.equal(confirmRes.status, 200);

  const subs = await listEmailSubscribers(db);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].email, "new@example.com");
});

test("a tampered confirmation token is rejected", async () => {
  const db = createMemoryD1();
  const env = { DB: db, EMAIL_UNSUBSCRIBE_SECRET: "test-secret" };
  await addEmailSubscription(db, { email: "x@example.com", confirmed: 0 });

  const res = await worker.fetch(
    new Request(`${SITE}/api/v1/confirm?email=x%40example.com&token=deadbeef`),
    env,
  );
  assert.equal(res.status, 403);
  assert.equal((await listEmailSubscribers(db)).length, 0);
});
