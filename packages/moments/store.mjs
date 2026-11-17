import { DatabaseSync } from 'node:sqlite';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const nonEmpty = value => typeof value === 'string' && value.length > 0;

export class MomentsStore {
  constructor(filename, accountId) {
    if (!nonEmpty(filename) || !nonEmpty(accountId)) throw new Error('Moments store requires a filename and account ID');
    mkdirSync(dirname(filename), { recursive: true });
    this.lockPath = `${filename}.owner`;
    this.lock = openSync(this.lockPath, 'wx');
    writeFileSync(this.lock, `${process.pid}\n`);
    try {
      this.db = new DatabaseSync(filename);
      this.accountId = accountId;
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS moments (
          moment_id TEXT PRIMARY KEY,
          account_id TEXT NOT NULL,
          author_id TEXT,
          author_name TEXT,
          created_at TEXT,
          text TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS timeline_cache (
          cache_key TEXT PRIMARY KEY,
          next_cursor TEXT,
          moment_ids_json TEXT NOT NULL,
          fetched_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outbox (
          key TEXT PRIMARY KEY,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL,
          receipt_json TEXT,
          approved INTEGER NOT NULL DEFAULT 0,
          attempted_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS trace (
          seq INTEGER PRIMARY KEY,
          at TEXT NOT NULL,
          kind TEXT NOT NULL,
          detail TEXT NOT NULL
        );`);
      const prior = this.db.prepare('SELECT value FROM meta WHERE key=?').get('accountId');
      if (prior && prior.value !== accountId) throw new Error('Moments database belongs to another account');
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('accountId', accountId);
    } catch (error) {
      this.db?.close();
      closeSync(this.lock);
      unlinkSync(this.lockPath);
      throw error;
    }
  }

  close() {
    this.db.close();
    closeSync(this.lock);
    unlinkSync(this.lockPath);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  trace(kind, detail) {
    this.db.prepare('INSERT INTO trace (at,kind,detail) VALUES (?,?,?)')
      .run(new Date().toISOString(), kind, JSON.stringify(detail));
  }

  upsertMoments(items) {
    if (!Array.isArray(items)) throw new Error('Moments items must be an array');
    return this.transaction(() => {
      const statement = this.db.prepare(`INSERT INTO moments
        (moment_id,account_id,author_id,author_name,created_at,text,payload_json,fetched_at)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(moment_id) DO UPDATE SET
          account_id=excluded.account_id, author_id=excluded.author_id,
          author_name=excluded.author_name, created_at=excluded.created_at,
          text=excluded.text, payload_json=excluded.payload_json, fetched_at=excluded.fetched_at`);
      const fetchedAt = Date.now();
      for (const item of items) {
        statement.run(item.id, this.accountId, item.author?.id ?? null, item.author?.name ?? null,
          item.createdAt ?? null, item.text, JSON.stringify(item), fetchedAt);
      }
      this.trace('timeline.cached', { count: items.length });
      return items.length;
    });
  }

  cacheTimeline(cacheKey, nextCursor, items) {
    if (!nonEmpty(cacheKey) || !Array.isArray(items)) throw new Error('Invalid timeline cache');
    const ids = items.map(item => item.id);
    this.db.prepare(`INSERT INTO timeline_cache (cache_key,next_cursor,moment_ids_json,fetched_at)
      VALUES (?,?,?,?) ON CONFLICT(cache_key) DO UPDATE SET
      next_cursor=excluded.next_cursor,moment_ids_json=excluded.moment_ids_json,fetched_at=excluded.fetched_at`)
      .run(cacheKey, nextCursor ?? null, JSON.stringify(ids), Date.now());
    return this.cachedTimeline(cacheKey);
  }

  cachedTimeline(cacheKey) {
    const row = this.db.prepare('SELECT * FROM timeline_cache WHERE cache_key=?').get(cacheKey);
    if (!row) return null;
    const ids = JSON.parse(row.moment_ids_json);
    const items = ids.map(id => this.db.prepare('SELECT payload_json FROM moments WHERE moment_id=?').get(id))
      .filter(Boolean).map(item => JSON.parse(item.payload_json));
    return { items, nextCursor: row.next_cursor, fetchedAt: row.fetched_at };
  }

  moment(id) {
    const row = this.db.prepare('SELECT payload_json FROM moments WHERE moment_id=?').get(id);
    return row ? JSON.parse(row.payload_json) : null;
  }

  draft(key, payload) {
    if (!nonEmpty(key) || key.length > 200 || /[\u0000-\u001f]/u.test(key)) throw new Error('Invalid moments idempotency key');
    const json = JSON.stringify(payload);
    const existing = this.outbox(key);
    if (existing && existing.payload_json !== json) throw new Error('Moments idempotency key content conflict');
    this.db.prepare('INSERT OR IGNORE INTO outbox (key,payload_json,state) VALUES (?,?,?)')
      .run(key, json, 'draft');
    return this.outbox(key);
  }

  outbox(key) { return this.db.prepare('SELECT * FROM outbox WHERE key=?').get(key) ?? null; }

  approve(key) {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET approved=1 WHERE key=? AND state='draft'").run(key);
      if (result.changes !== 1) throw new Error('No moments draft exists for approval');
      this.trace('moments.publish.approved', { key });
      return this.outbox(key);
    });
  }

  claim(key, cooldownMs, now = Date.now()) {
    return this.transaction(() => {
      const row = this.outbox(key);
      if (!row || row.approved !== 1 || row.state !== 'draft') throw new Error('Moments publish is not an approved draft');
      const last = this.db.prepare('SELECT MAX(attempted_at) AS at FROM outbox').get().at;
      if (last !== null && now - last < cooldownMs) throw new Error('Moments publish rate limit');
      this.db.prepare("UPDATE outbox SET state='dispatching',attempted_at=? WHERE key=?").run(now, key);
      return row;
    });
  }

  receipt(key, state, receipt = null) {
    this.transaction(() => {
      this.db.prepare('UPDATE outbox SET state=?,receipt_json=? WHERE key=?')
        .run(state, receipt === null ? null : JSON.stringify(receipt), key);
      this.trace('moments.publish.receipt', { key, state, receiptId: receipt?.id ?? null });
    });
    return this.outbox(key);
  }
}
