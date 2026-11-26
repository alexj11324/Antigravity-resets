// Translation pipeline: the locale map the model returns must be validated and
// stored, an echoed source must never be labeled a translation, and a failure
// must retry on a short backoff instead of waiting a fixed hour.

import test from "node:test";
import assert from "node:assert/strict";
import {
  retryDelayMs,
  translatePost,
  translatePendingResets,
} from "../src/translate.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";
import { ensureSeeded } from "../src/store.mjs";
import worker from "../src/index.mjs";

const SITE = "https://antigravity-resets.com";

const SOURCE = "Resetting Gemini quota for all Antigravity users for Thanksgiving!";

const TRANSLATED = {
  zh_cn: "感恩节为所有 Antigravity 用户重置 Gemini 配额！",
  zh_tw: "感恩節為所有 Antigravity 使用者重置 Gemini 配額！",
  ja: "感謝祭として、すべての Antigravity ユーザーの Gemini クォータをリセットします！",
  ko: "추수감사절을 맞아 모든 Antigravity 사용자의 Gemini 할당량을 재설정합니다!",
};

function ok(payload) {
  return new Response(JSON.stringify({ output_text: JSON.stringify(payload) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("a structured response becomes a locale map", async () => {
  const { map, error } = await translatePost(
    { GEMINI_API_KEY: "k" },
    SOURCE,
    async () => ok(TRANSLATED),
  );
  assert.equal(error, null);
  assert.equal(map["zh-CN"], TRANSLATED.zh_cn);
  assert.equal(map["zh-TW"], TRANSLATED.zh_tw);
  assert.equal(map.ja, TRANSLATED.ja);
  assert.equal(map.ko, TRANSLATED.ko);
});

test("an echoed source is dropped instead of being labeled a translation", async () => {
  const echoed = { zh_cn: SOURCE, zh_tw: SOURCE, ja: SOURCE, ko: SOURCE };
  const { map, error } = await translatePost(
    { GEMINI_API_KEY: "k" },
    SOURCE,
    async () => ok(echoed),
  );
  assert.equal(map, null);
  assert.match(error, /too few/);
});

test("a partial echo keeps only the real translations", async () => {
  const mixed = { ...TRANSLATED, zh_tw: SOURCE, ko: SOURCE };
  const { map } = await translatePost(
    { GEMINI_API_KEY: "k" },
    SOURCE,
    async () => ok(mixed),
  );
  assert.deepEqual(Object.keys(map).sort(), ["ja", "zh-CN"]);
});

test("a failed request reports why instead of throwing", async () => {
  const { map, error } = await translatePost(
    { GEMINI_API_KEY: "k" },
    SOURCE,
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(map, null);
  assert.match(error, /HTTP 500/);
});

test("the backoff starts short and caps at an hour", () => {
  assert.equal(retryDelayMs(0), 30_000);
  assert.equal(retryDelayMs(1), 60_000);
  assert.equal(retryDelayMs(2), 120_000);
  assert.equal(retryDelayMs(10), 3_600_000);
});

test("the backfill stores translations and clears the failure count", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const env = { DB: db, GEMINI_API_KEY: "k" };

  const result = await translatePendingResets(env, 1, async () => ok(TRANSLATED));
  assert.equal(result.translated, 1);
  assert.equal(result.failed, 0);

  const row = db.sql
    .prepare(
      "SELECT text_i18n_json, translation_attempted_at, translation_failures FROM resets WHERE text_i18n_json IS NOT NULL",
    )
    .get();
  assert.ok(row.text_i18n_json.includes('"zh-CN"'));
  assert.ok(row.translation_attempted_at);
  assert.equal(row.translation_failures, 0);
});

test("a failure counts once and is not retried before its backoff", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  // Keep a single row, otherwise the second run legitimately picks the next one.
  const keep = db.sql.prepare("SELECT id FROM resets ORDER BY timestamp DESC LIMIT 1").get().id;
  db.sql.prepare("DELETE FROM resets WHERE id <> ?").run(keep);

  const env = { DB: db, GEMINI_API_KEY: "k" };
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };

  const first = await translatePendingResets(env, 1, failing);
  assert.equal(first.failed, 1);
  assert.match(first.details[0].reason, /HTTP 500/);
  assert.equal(
    db.sql.prepare("SELECT translation_failures FROM resets WHERE id = ?").get(keep)
      .translation_failures,
    1,
  );

  const second = await translatePendingResets(env, 1, failing);
  assert.equal(second.failed, 0, "the same row must not be retried immediately");
  assert.equal(calls, 1);
});

test("a row is retried as soon as its backoff has elapsed", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const keep = db.sql.prepare("SELECT id FROM resets ORDER BY timestamp DESC LIMIT 1").get().id;
  db.sql.prepare("DELETE FROM resets WHERE id <> ?").run(keep);

  const env = { DB: db, GEMINI_API_KEY: "k" };
  let calls = 0;
  const failing = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };
  await translatePendingResets(env, 1, failing);
  assert.equal(calls, 1);

  // Pretend the last attempt was two minutes ago: longer than the 30s backoff.
  const past = new Date(Date.now() - 120_000).toISOString();
  db.sql
    .prepare("UPDATE resets SET translation_attempted_at = ? WHERE id = ?")
    .run(past, keep);

  const retry = await translatePendingResets(env, 1, failing);
  assert.equal(retry.failed, 1);
  assert.equal(calls, 2, "the elapsed backoff must allow a retry");
});

test("without a key the backfill is a no-op", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const result = await translatePendingResets({ DB: db }, 1, async () => ok(TRANSLATED));
  assert.deepEqual(result, { translated: 0, failed: 0, skipped: 0, details: [] });
});

test("the on-demand translation endpoint is admin-gated", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const post = (headers = {}) =>
    worker.fetch(
      new Request(`${SITE}/api/v1/admin/translate`, { method: "POST", headers }),
      { DB: db },
    );
  assert.equal((await post()).status, 503, "no token configured must fail closed");

  const wrong = await worker.fetch(
    new Request(`${SITE}/api/v1/admin/translate`, {
      method: "POST",
      headers: { Authorization: "Bearer nope" },
    }),
    { DB: db, ADMIN_API_TOKEN: "right" },
  );
  assert.equal(wrong.status, 401);
});
