import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function createMemoryD1() {
  const sql = new DatabaseSync(':memory:');
  for (const file of ['0001_init.sql', '0002_telegram_outbox.sql', '0003_confirm_existing_subscriptions.sql', '0004_email_send_throttle.sql', '0005_reset_translations.sql', '0006_translation_backoff.sql']) {
    sql.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  function prepare(query) {
    const stmt = sql.prepare(query);
    let args = [];
    const wrapped = {
      bind(...values) { args = values; return wrapped; },
      async run() { const res = stmt.run(...args); return { meta: { changes: Number(res.changes) } }; },
      async first() { return stmt.get(...args) || null; },
      async all() { return { results: stmt.all(...args) }; },
    };
    return wrapped;
  }
  return { sql, prepare, get _tables() { return { webhookEvents: new Map(sql.prepare('SELECT * FROM x_webhook_events').all().map(row => [row.event_hash, row])) }; }, async batch(statements) {
    sql.exec('BEGIN');
    try { const result = []; for (const stmt of statements) result.push(await stmt.run()); sql.exec('COMMIT'); return result; }
    catch (error) { sql.exec('ROLLBACK'); throw error; }
  } };
}
