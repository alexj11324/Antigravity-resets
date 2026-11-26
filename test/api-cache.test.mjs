// HTTP caching contract for the read-only API: validators that actually hit,
// 304s that keep their freshness headers, and HEAD answering like GET without
// a body. Uptime checks and link validators use HEAD, so a 404 there is a lie.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const SITE = "https://antigravity-resets.com";

function get(path, headers = {}) {
  return worker.fetch(new Request(`${SITE}${path}`, { headers }), {});
}

test("status carries an ETag and separate browser and edge TTLs", async () => {
  const res = await get("/api/v1/status");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("etag"), /^"[0-9a-f]{32}"$/);
  assert.match(res.headers.get("cache-control"), /s-maxage=15/);
  assert.match(res.headers.get("cache-control"), /stale-while-revalidate=60/);
});

test("a matching If-None-Match gets a bodiless 304 that keeps its cache headers", async () => {
  const first = await get("/api/v1/status");
  const etag = first.headers.get("etag");

  const second = await get("/api/v1/status", { "If-None-Match": etag });
  assert.equal(second.status, 304);
  assert.equal(second.body, null);
  assert.equal(second.headers.get("etag"), etag);
  assert.match(
    second.headers.get("cache-control"),
    /s-maxage=15/,
    "the 304 must not drop the freshness window the client was promised",
  );
});

test("the validator ignores generatedAt, so repeat polls can revalidate", async () => {
  const a = await get("/api/v1/status");
  const b = await get("/api/v1/status");
  assert.equal(a.headers.get("etag"), b.headers.get("etag"));
});

test("a different representation gets a different validator", async () => {
  const all = await get("/api/v1/resets");
  const limited = await get("/api/v1/resets?limit=2");
  assert.notEqual(all.headers.get("etag"), limited.headers.get("etag"));
});

test("HEAD returns the GET headers with no body", async () => {
  const res = await worker.fetch(
    new Request(`${SITE}/api/v1/status`, { method: "HEAD" }),
    {},
  );
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.ok(res.headers.get("etag"), "HEAD must expose the validator");
});

test("HEAD on a no-store page still says no-store", async () => {
  const res = await worker.fetch(
    new Request(`${SITE}/api/v1/confirm?email=a%40b.com&token=deadbeef`, { method: "HEAD" }),
    { EMAIL_UNSUBSCRIBE_SECRET: "test-secret" },
  );
  assert.equal(res.status, 403);
  assert.equal(await res.text(), "");
  assert.equal(res.headers.get("cache-control"), "no-store");
});

test("a second read is served from the colo cache", async (t) => {
  // A Cache Rule alone does not cache a Worker response, so the Worker puts it
  // in caches.default itself. This pins that it actually consults it.
  const entries = new Map();
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = entries.get(key.url);
        return hit ? hit.clone() : undefined;
      },
      async put(key, response) {
        entries.set(key.url, response.clone());
      },
    },
  };
  t.after(() => {
    delete globalThis.caches;
  });

  const first = await worker.fetch(new Request(`${SITE}/api/v1/status`), {});
  assert.equal(first.headers.get("x-edge-cache"), "MISS");
  assert.equal((await first.json()).service, "antigravity-resets");

  const second = await worker.fetch(new Request(`${SITE}/api/v1/status`), {});
  assert.equal(second.headers.get("x-edge-cache"), "HIT");
  assert.equal((await second.json()).service, "antigravity-resets");
});

test("write routes never consult the colo cache", async (t) => {
  const entries = new Map();
  let lookups = 0;
  globalThis.caches = {
    default: {
      async match(key) {
        lookups += 1;
        return entries.get(key.url);
      },
      async put(key, response) {
        entries.set(key.url, response);
      },
    },
  };
  t.after(() => {
    delete globalThis.caches;
  });

  await worker.fetch(
    new Request(`${SITE}/api/v1/thanks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ delta: 1 }),
    }),
    {},
  );
  assert.equal(lookups, 0);
});

function installCache(entries) {
  globalThis.caches = {
    default: {
      async match(key) {
        const hit = entries.get(key.url);
        return hit ? hit.clone() : undefined;
      },
      async put(key, response) {
        entries.set(key.url, response.clone());
      },
    },
  };
}

test("junk query strings collapse onto one cache entry", async (t) => {
  // Keying on the raw URL would let anyone mint unbounded entries and evict
  // the real ones; the handler ignores these parameters anyway.
  const entries = new Map();
  installCache(entries);
  t.after(() => {
    delete globalThis.caches;
  });

  const first = await worker.fetch(new Request(`${SITE}/api/v1/status?utm_source=spam`), {});
  assert.equal(first.headers.get("x-edge-cache"), "MISS");

  const second = await worker.fetch(
    new Request(`${SITE}/api/v1/status?junk=${Math.random()}`),
    {},
  );
  assert.equal(second.headers.get("x-edge-cache"), "HIT");
  assert.equal(entries.size, 1, "both requests must share one entry");
});

test("valid query variants keep separate entries", async (t) => {
  const entries = new Map();
  installCache(entries);
  t.after(() => {
    delete globalThis.caches;
  });

  await worker.fetch(new Request(`${SITE}/api/v1/resets?limit=2`), {});
  await worker.fetch(new Request(`${SITE}/api/v1/resets?limit=3`), {});
  assert.equal(entries.size, 2);
});

test("out-of-range limits collapse onto the default representation", async (t) => {
  // The handler ignores limit=999, so it must not earn its own cache entry.
  const entries = new Map();
  installCache(entries);
  t.after(() => {
    delete globalThis.caches;
  });

  await worker.fetch(new Request(`${SITE}/api/v1/resets`), {});
  const second = await worker.fetch(new Request(`${SITE}/api/v1/resets?limit=999`), {});
  assert.equal(second.headers.get("x-edge-cache"), "HIT");
  assert.equal(entries.size, 1);
});
