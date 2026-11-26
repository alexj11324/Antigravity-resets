import assert from 'node:assert/strict';
import test from 'node:test';
import { drainTelegramOutbox } from '../src/telegram-outbox.mjs';
import { recordWebhookEventAndResets } from '../src/store.mjs';

import { createMemoryD1 as database } from './sqlite-d1.mjs';

const reset = (id = 'r1') => ({ id, tweetId: id, timestamp: '2026-11-26T15:00:00Z',
  type: 'regular', authorHandle: '@_mohansolo', authorName: 'Varun Mohan', models: ['Gemini'],
  url: `https://x.com/_mohansolo/status/${id}`, quoteText: 'Original source quote', summary: { en: 'Summary' } });
const watch = (id = 'w1') => ({ id, tweetId: id, announcedAt: '2026-11-26T14:00:00Z',
  type: 'regular', status: 'possible', authorHandle: '@_mohansolo', authorName: 'Varun Mohan',
  url: `https://x.com/_mohansolo/status/${id}`, quoteText: 'Something may be coming' });
async function record(db, { resets = [], watches = [], hash = crypto.randomUUID() } = {}) {
  return recordWebhookEventAndResets(db, { eventHash: hash, signatureScheme: 'oauth2', eventType: 'post.create',
    primaryTweet: null, classifiedResets: resets, announcedResets: watches, rawPayload: '{}' });
}
const environment = (db) => ({ DB: db, TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_CHAT_ID: 'test' });
const rows = (db) => db.sql.prepare('SELECT * FROM telegram_outbox ORDER BY seq').all();
const ok = (id = 321) => Response.json({ ok: true, result: { message_id: id } });

test('real SQLite triggers create durable source snapshots once; rollback prevents a reset without its outbox', async () => {
  const db = database();
  await record(db, { resets: [reset()], hash: 'replay' });
  await record(db, { resets: [reset()], hash: 'replay' });
  assert.equal(rows(db).length, 1);
  assert.equal(JSON.parse(rows(db)[0].payload_json).quoteText, 'Original source quote');
  db.sql.exec('DROP TABLE telegram_outbox');
  await assert.rejects(record(db, { resets: [reset('must-rollback')] }));
  assert.equal(db.sql.prepare("SELECT count(*) AS n FROM resets WHERE id = 'must-rollback'").get().n, 0);
});

test('explicit Telegram 503 and 429 retry durably without requiring X replay; confirmed deliveries never resend', async () => {
  const db = database();
  await record(db, { resets: [reset()] });
  let calls = 0;
  const fetchImpl = async () => { calls++; return calls === 1
    ? Response.json({ ok: false, error_code: 503 }, { status: 503 })
    : calls === 2 ? Response.json({ ok: false, error_code: 429, parameters: { retry_after: 60 } }, { status: 429 }) : ok(); };
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 0 });
  assert.equal(rows(db)[0].status, 'pending');
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 29_999 });
  assert.equal(calls, 1);
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 30_000 });
  assert.equal(rows(db)[0].next_attempt_at, 90_000);
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 90_000 });
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 100_000 });
  assert.equal(calls, 3);
  assert.equal(rows(db)[0].status, 'sent');
  assert.equal(rows(db)[0].telegram_message_id, '321');
});

test('transport loss and unstructured HTTP 503 remain ambiguous while unrelated entities continue', async () => {
  for (const failure of [async () => { throw new Error('connection lost'); }, async () => new Response('proxy unavailable', { status: 503 })]) {
    const db = database();
    await record(db, { resets: [reset(), reset('r2')] });
    let calls = 0;
    const fetchImpl = async (...args) => ++calls === 1 ? failure(...args) : ok(444);
    await drainTelegramOutbox(environment(db), { fetchImpl, now: 0 });
    await drainTelegramOutbox(environment(db), { fetchImpl, now: 600_000 });
    assert.equal(calls, 2);
    assert.deepEqual(rows(db).map(r => r.status), ['ambiguous', 'sent']);
  }
});

test('watch snapshots preserve order and edit the recorded message; duplicate update does not enqueue again', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  await record(db, { watches: [watch('w2')] });
  await record(db, { watches: [watch('w2')] });
  assert.equal(rows(db).length, 2);
  const calls = [];
  await drainTelegramOutbox(environment(db), { fetchImpl: async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) }); return ok(555);
  }, now: 0 });
  assert.match(calls[0].url, /sendMessage$/);
  assert.match(calls[1].url, /editMessageText$/);
  assert.equal(calls[1].body.message_id, 555);
  assert.equal(calls[0].body.text.includes('Update:'), false);
  assert.equal(calls[1].body.text.includes('Update:'), true);
  assert.equal(db.sql.prepare("SELECT telegram_message_id FROM announced_resets WHERE id = 'w1'").get().telegram_message_id, '555');
});

test('ambiguous watch blocks its update until an operator reconciles the actual message ID', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  await record(db, { watches: [watch('w2')] });
  let calls = 0;
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => { calls++; throw new Error('lost'); }, now: 0 });
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => { calls++; return ok(); }, now: 100_000 });
  assert.equal(calls, 1);
  db.sql.prepare("UPDATE telegram_outbox SET status = 'sent', telegram_message_id = '777', last_error = 'operator_confirmed_delivered' WHERE seq = 1 AND status = 'ambiguous'").run();
  await drainTelegramOutbox(environment(db), { fetchImpl: async (url, init) => {
    calls++; assert.match(url, /editMessageText$/); assert.equal(JSON.parse(init.body).message_id, 777); return ok(777);
  }, now: 100_000 });
  assert.equal(calls, 2);
  assert.deepEqual(rows(db).map(r => r.status), ['sent', 'sent']);
});

test('concurrent drainers claim only one request; abandoned send holds while safe edit retries', async () => {
  const db = database();
  await record(db, { resets: [reset()] });
  let release;
  let started;
  const inFlight = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const fetchImpl = () => { calls++; started(); return new Promise(resolve => { release = resolve; }); };
  const first = drainTelegramOutbox(environment(db), { fetchImpl, now: 0, limit: 1 });
  await inFlight;
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 1, limit: 1 });
  assert.equal(calls, 1);
  release(ok()); await first;
  assert.equal(rows(db)[0].status, 'sent');
  await record(db, { watches: [watch()] });
  db.sql.prepare("UPDATE telegram_outbox SET status = 'sending', action = 'send', lease_until = 1 WHERE kind = 'announcement'").run();
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => { throw new Error('must not run'); }, now: 60_000 });
  assert.equal(rows(db)[1].status, 'ambiguous');
});

test('idempotent edit retries transport loss and treats not-modified as success; permanent rejection is observable', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => ok(888), now: 0 });
  await record(db, { watches: [watch('w2')] });
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => { throw new Error('lost edit ack'); }, now: 0 });
  assert.equal(rows(db)[1].status, 'pending');
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => Response.json({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, { status: 400 }), now: 30_000 });
  assert.equal(rows(db)[1].status, 'sent');
  await record(db, { resets: [reset()] });
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => Response.json({ ok: false, error_code: 403 }, { status: 403 }), now: 30_000 });
  assert.equal(rows(db)[2].status, 'failed');
  assert.equal(rows(db)[2].last_error, 'telegram_api_403');
});

test('migration never enqueues notifications from the old writer during deploy or rollback', async () => {
  const db = database();
  await record(db, { resets: [reset()], watches: [watch()] });
  // An old writer names only the columns it knew about; newer columns take
  // their defaults. Positional SELECTs break every time a column is added.
  db.sql.exec("INSERT INTO resets (id, tweet_id, timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, source, created_at) SELECT 'old', 'old', timestamp, type, author_handle, author_name, models_json, url, summary_en, summary_i18n_json, judge_summary_json, thanks_count, source, created_at FROM resets WHERE id = 'r1'");
  db.sql.exec("INSERT INTO announced_resets (id, tweet_id, announced_at, type, author_handle, author_name, url, quote_text) VALUES ('old-watch', 'old-watch', '2026-11-26', 'regular', '@a', 'A', 'https://x.com/a/status/1', 'Old writer')");
  db.sql.exec("UPDATE announced_resets SET updates_json = '[]', url = 'https://x.com/a/status/2' WHERE id = 'w1'");
  assert.equal(rows(db).length, 2);
});

test('simultaneous watch updates preserve both quotes and enqueue complete ordered snapshots', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  await Promise.all([record(db, { watches: [watch('w2')] }), record(db, { watches: [watch('w3')] })]);
  const stored = JSON.parse(db.sql.prepare("SELECT updates_json FROM announced_resets WHERE id = 'w1'").get().updates_json);
  assert.deepEqual(stored.map(update => update.tweetId).sort(), ['w2', 'w3']);
  assert.deepEqual(rows(db).map(row => JSON.parse(row.payload_json).updates.length), [0, 1, 2]);
});

test('definitive watch edit 503 retries the same message ID without a replacement post', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => ok(909), now: 0 });
  await record(db, { watches: [watch('w2')] });
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return calls.length === 1 ? Response.json({ ok: false, error_code: 503 }, { status: 503 }) : ok(909);
  };
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 0 });
  await drainTelegramOutbox(environment(db), { fetchImpl, now: 30_000 });
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.match(call.url, /editMessageText$/); assert.equal(call.body.message_id, 909); }
  assert.equal(rows(db)[1].status, 'sent');
});

test('late send acknowledgement cannot overwrite an expired claim or report a confirmed delivery', async () => {
  const db = database();
  await record(db, { resets: [reset()] });
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const first = drainTelegramOutbox(environment(db), { fetchImpl: () => {
    started(); return new Promise(resolve => { release = resolve; });
  }, now: 0, limit: 1 });
  await begun;
  await drainTelegramOutbox(environment(db), { fetchImpl: async () => { throw new Error('must not resend'); }, now: 60_001 });
  release(ok(123));
  const result = await first;
  assert.equal(result.sent, 0);
  assert.equal(result.superseded, 1);
  assert.equal(rows(db)[0].status, 'ambiguous');
});

test('watch 429 then reset confirmation retires old snapshots before the confirmed post; expired expected is also retired', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  let calls = 0;
  const env = environment(db);
  await drainTelegramOutbox(env, { fetchImpl: async () => { calls++; return Response.json({ ok: false, error_code: 429 }, { status: 429 }); }, now: 0 });
  await record(db, { resets: [reset()] });
  await drainTelegramOutbox(env, { fetchImpl: async (_url, init) => {
    calls++; assert.match(JSON.parse(init.body).text, /reset confirmed/); return ok();
  }, now: 0 });
  await drainTelegramOutbox(env, { fetchImpl: async () => { throw new Error('closed watch must not publish'); }, now: 60_000 });
  assert.equal(calls, 2);
  assert.deepEqual(rows(db).map(row => row.status), ['cancelled', 'sent']);
  await record(db, { watches: [{ ...watch('expected'), status: 'expected' }] });
  db.sql.exec("UPDATE announced_resets SET status = 'expired' WHERE id = 'expected'");
  await drainTelegramOutbox(env, { fetchImpl: async () => { throw new Error('expired must not publish'); }, now: 60_000 });
  assert.equal(rows(db)[2].status, 'cancelled');
});

test('a definitive in-flight failure after watch closure cannot return the snapshot to delivery', async () => {
  const db = database();
  await record(db, { watches: [watch()] });
  let release, started;
  const begun = new Promise(resolve => { started = resolve; });
  const running = drainTelegramOutbox(environment(db), { fetchImpl: () => {
    started(); return new Promise(resolve => { release = resolve; });
  }, now: 0, limit: 1 });
  await begun;
  await record(db, { resets: [reset()] });
  release(Response.json({ ok: false, error_code: 503 }, { status: 503 }));
  const result = await running;
  assert.equal(result.cancelled, 1);
  assert.equal(result.pending, 0);
  assert.equal(rows(db)[0].status, 'cancelled');
  await drainTelegramOutbox(environment(db), { fetchImpl: async (_url, init) => {
    assert.match(JSON.parse(init.body).text, /reset confirmed/); return ok();
  }, now: 60_000 });
  assert.deepEqual(rows(db).map(row => row.status), ['cancelled', 'sent']);
});
