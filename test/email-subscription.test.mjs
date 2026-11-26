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

  const confirmUrl = sent[0].body.html
    .match(/href="([^"]*\/api\/v1\/confirm[^"]*)"/)[1]
    .replace(/&amp;/g, "&");

  // A mail scanner or link prefetcher hitting the URL must NOT subscribe anyone.
  const getRes = await worker.fetch(new Request(confirmUrl), env);
  assert.equal(getRes.status, 200);
  assert.match(await getRes.text(), /<form method="post"/);
  assert.equal((await listEmailSubscribers(db)).length, 0, "GET must not confirm");

  // Only the explicit POST does.
  const postRes = await worker.fetch(new Request(confirmUrl, { method: "POST" }), env);
  assert.equal(postRes.status, 200);

  const subs = await listEmailSubscribers(db);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].email, "new@example.com");
});

test("a repeated subscribe request is throttled instead of mailing again", async (t) => {
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "s",
    RESEND_API_KEY: "k",
    RESEND_FROM_EMAIL: "a@b.com",
  };
  const send = () =>
    worker.fetch(
      new Request(`${SITE}/api/v1/subscribe/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "spam@example.com" }),
      }),
      env,
    );

  assert.equal((await send()).status, 202);
  assert.equal((await send()).status, 202);
  assert.equal(sent.length, 1, "the second request inside the cooldown must not send mail");
});

test("a cooldown rejection must not spend the shared hourly send budget", async (t) => {
  // The exploit this pins: with the global slot reserved before the per-address
  // cooldown, posting one address over and over burns the cap on responses that
  // send nothing, and every other subscriber is locked out for the hour.
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "s",
    RESEND_API_KEY: "k",
    RESEND_FROM_EMAIL: "a@b.com",
  };
  const post = (email) =>
    worker.fetch(
      new Request(`${SITE}/api/v1/subscribe/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );

  const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  db.sql
    .prepare("INSERT OR IGNORE INTO email_send_log (window_start, sent) VALUES (?, 0)")
    .run(windowStart);
  db.sql.prepare("UPDATE email_send_log SET sent = 98 WHERE window_start = ?").run(windowStart);

  // One slot left. First post spends it and mails.
  assert.equal((await post("repeat@example.com")).status, 202);
  assert.equal(sent.length, 1);

  // Second post is refused by the cooldown. It must not touch the counter.
  assert.equal((await post("repeat@example.com")).status, 202);
  assert.equal(sent.length, 1, "cooldown must suppress the second mail");
  assert.equal(
    db.sql.prepare("SELECT sent FROM email_send_log WHERE window_start = ?").get(windowStart).sent,
    99,
    "a rejected request must not consume a send slot",
  );

  // The remaining slot is still available to a different address. Under the
  // old ordering this request got 429 and the whole feature was down.
  assert.equal((await post("fresh@example.com")).status, 202);
  assert.equal(sent.length, 2);
});

test("the hourly cap still refuses work once it is actually spent", async (t) => {
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "s",
    RESEND_API_KEY: "k",
    RESEND_FROM_EMAIL: "a@b.com",
  };

  // Seed the current and next window so an hour rollover mid-test cannot flake.
  const hour = 3600000;
  for (const offset of [0, hour]) {
    const key = new Date(Math.floor((Date.now() + offset) / hour) * hour).toISOString();
    db.sql
      .prepare("INSERT OR IGNORE INTO email_send_log (window_start, sent) VALUES (?, 100)")
      .run(key);
    db.sql.prepare("UPDATE email_send_log SET sent = 100 WHERE window_start = ?").run(key);
  }

  const res = await worker.fetch(
    new Request(`${SITE}/api/v1/subscribe/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "late@example.com" }),
    }),
    env,
  );
  assert.equal(res.status, 429);
  assert.equal(sent.length, 0, "a refused request must not mail");
});

test("a budget refusal leaves neither a pending row nor a cooldown", async (t) => {
  // A request refused for budget mails nothing, so it must not write anything
  // either: inserting the row first would let an exhausted hour grow the
  // subscriptions table without bound.
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "s",
    RESEND_API_KEY: "k",
    RESEND_FROM_EMAIL: "a@b.com",
  };
  const post = (email) =>
    worker.fetch(
      new Request(`${SITE}/api/v1/subscribe/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      }),
      env,
    );

  // An existing pending row must keep its NULL cooldown through a 429.
  await addEmailSubscription(db, { email: "existing@example.com", confirmed: 0 });

  const hour = 3600000;
  for (const offset of [0, hour]) {
    const key = new Date(Math.floor((Date.now() + offset) / hour) * hour).toISOString();
    db.sql
      .prepare("INSERT OR IGNORE INTO email_send_log (window_start, sent) VALUES (?, 100)")
      .run(key);
    db.sql.prepare("UPDATE email_send_log SET sent = 100 WHERE window_start = ?").run(key);
  }

  assert.equal((await post("fresh@example.com")).status, 429);
  assert.equal(
    db.sql
      .prepare("SELECT COUNT(*) AS n FROM email_subscriptions WHERE email = ?")
      .get("fresh@example.com").n,
    0,
    "a refused request must not create a pending row",
  );

  assert.equal((await post("existing@example.com")).status, 429);
  assert.equal(
    db.sql
      .prepare("SELECT confirmation_sent_at FROM email_subscriptions WHERE email = ?")
      .get("existing@example.com").confirmation_sent_at,
    null,
    "a refused request must not claim the cooldown",
  );
  assert.equal(sent.length, 0);
});

test("concurrent duplicates send once and refund the extra slot", async (t) => {
  // Both requests pass the advisory read before either claims the row, so this
  // exercises the claim-loser refund rather than the fast reject.
  const db = createMemoryD1();
  const sent = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    sent.push(JSON.parse(init.body));
    return new Response("{}", { status: 200 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  const prepare = db.prepare.bind(db);
  let arrived = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  db.prepare = (query) => {
    const wrapped = prepare(query);
    const first = wrapped.first.bind(wrapped);
    wrapped.first = async (...args) => {
      const result = await first(...args);
      if (/FROM email_subscriptions WHERE email = \?/.test(query)) {
        arrived += 1;
        if (arrived === 2) release();
        await gate;
      }
      return result;
    };
    return wrapped;
  };

  const env = {
    DB: db,
    EMAIL_UNSUBSCRIBE_SECRET: "s",
    RESEND_API_KEY: "k",
    RESEND_FROM_EMAIL: "a@b.com",
  };
  const post = () =>
    worker.fetch(
      new Request(`${SITE}/api/v1/subscribe/email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "race@example.com" }),
      }),
      env,
    );

  const [a, b] = await Promise.all([post(), post()]);
  assert.equal(a.status, 202);
  assert.equal(b.status, 202);
  assert.equal(sent.length, 1, "only the claim winner may mail");

  const windowStart = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  assert.equal(
    db.sql.prepare("SELECT sent FROM email_send_log WHERE window_start = ?").get(windowStart).sent,
    1,
    "the losing request must refund its slot",
  );
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
