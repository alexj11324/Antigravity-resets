// Translation pipeline: the locale map the model returns must be validated and
// stored, an echoed source must never be labeled a translation, and a failure
// must not be retried every minute forever.

import test from "node:test";
import assert from "node:assert/strict";
import { translatePost, translatePendingResets } from "../src/translate.mjs";
import { createMemoryD1 } from "./sqlite-d1.mjs";
import { ensureSeeded } from "../src/store.mjs";

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
  const map = await translatePost({ GEMINI_API_KEY: "k" }, SOURCE, async () => ok(TRANSLATED));
  assert.equal(map["zh-CN"], TRANSLATED.zh_cn);
  assert.equal(map["zh-TW"], TRANSLATED.zh_tw);
  assert.equal(map.ja, TRANSLATED.ja);
  assert.equal(map.ko, TRANSLATED.ko);
});

test("an echoed source is dropped instead of being labeled a translation", async () => {
  const echoed = { zh_cn: SOURCE, zh_tw: SOURCE, ja: SOURCE, ko: SOURCE };
  const map = await translatePost({ GEMINI_API_KEY: "k" }, SOURCE, async () => ok(echoed));
  assert.equal(map, null);
});

test("a partial echo keeps only the real translations", async () => {
  const mixed = { ...TRANSLATED, zh_tw: SOURCE, ko: SOURCE };
  const map = await translatePost({ GEMINI_API_KEY: "k" }, SOURCE, async () => ok(mixed));
  assert.deepEqual(Object.keys(map).sort(), ["ja", "zh-CN"]);
});

test("a failed request returns null rather than throwing", async () => {
  const map = await translatePost(
    { GEMINI_API_KEY: "k" },
    SOURCE,
    async () => new Response("boom", { status: 500 }),
  );
  assert.equal(map, null);
});

test("the backfill stores translations and their attempt time", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const env = { DB: db, GEMINI_API_KEY: "k" };

  const result = await translatePendingResets(env, 1, async () => ok(TRANSLATED));
  assert.equal(result.translated, 1);

  const row = db.sql
    .prepare("SELECT text_i18n_json, translation_attempted_at FROM resets WHERE text_i18n_json IS NOT NULL")
    .get();
  assert.ok(row.text_i18n_json.includes('"zh-CN"'));
  assert.ok(row.translation_attempted_at, "the attempt must be recorded");
});

test("a failure is not retried within the hour", async () => {
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

  const second = await translatePendingResets(env, 1, failing);
  assert.equal(second.failed, 0, "the same row must not be retried immediately");
  assert.equal(calls, 1);
});

test("without a key the backfill is a no-op", async () => {
  const db = createMemoryD1();
  await ensureSeeded(db);
  const result = await translatePendingResets({ DB: db }, 1, async () => ok(TRANSLATED));
  assert.deepEqual(result, { translated: 0, failed: 0 });
});
