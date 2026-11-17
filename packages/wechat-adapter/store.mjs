import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { validateQuoteReference } from './quote-send.mjs';

export function improvesInboxMessage(prior, next) {
  if (!prior || !next) return false;
  if (next.imageSummary && !prior.imageSummary) return true;
  if (prior.imageError && !next.imageError) return true;
  if (prior.voiceState === 'failed' && next.voiceState && next.voiceState !== 'failed') return true;
  return false;
}

export class AdapterStore {
  constructor(filename, accountId) {
    mkdirSync(dirname(filename), { recursive: true });
    this.lockPath = `${filename}.owner`;
    this.lock = openSync(this.lockPath, 'wx');
    writeFileSync(this.lock, `${process.pid}\n`);
    try {
      this.db = new DatabaseSync(filename);
      this.accountId = accountId;
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS outbox (key TEXT PRIMARY KEY, group_id TEXT NOT NULL, text TEXT NOT NULL,
        state TEXT NOT NULL, receipt TEXT, approved INTEGER NOT NULL DEFAULT 0, attempted_at INTEGER,
        mentions_json TEXT NOT NULL DEFAULT '[]');
      CREATE TABLE IF NOT EXISTS trace (seq INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);`);
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(row => row.name === 'mentions_json')) {
        this.db.exec("ALTER TABLE outbox ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'");
      }
      if (!this.db.prepare('PRAGMA table_info(outbox)').all().some(row => row.name === 'quote_json')) {
        this.db.exec("ALTER TABLE outbox ADD COLUMN quote_json TEXT NOT NULL DEFAULT 'null'");
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS inbox_scope_history ON inbox (
        json_extract(message,'$.accountId'), json_extract(message,'$.groupId'));
        CREATE INDEX IF NOT EXISTS inbox_scope_history_time ON inbox (
        json_extract(message,'$.accountId'), json_extract(message,'$.groupId'),
        julianday(COALESCE(json_extract(message,'$.eventTime'),json_extract(message,'$.recordedAt'))));`);
      const prior = this.db.prepare('SELECT value FROM meta WHERE key=?').get('accountId');
      if (prior && prior.value !== accountId) throw new Error('Database belongs to another account');
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES (?,?)').run('accountId', accountId);
    } catch (error) {
      this.db?.close(); closeSync(this.lock); unlinkSync(this.lockPath); throw error;
    }
  }
  close() { this.db.close(); closeSync(this.lock); unlinkSync(this.lockPath); }
  ownsLock() {
    try { return readFileSync(this.lockPath, 'utf8').trim() === String(process.pid); }
    catch { return false; }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  trace(kind, detail) { this.db.prepare('INSERT INTO trace (at,kind,detail) VALUES (?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(detail)); }
  cursor() { return this.db.prepare('SELECT value FROM meta WHERE key=?').get('cursor')?.value ?? '0'; }
  commitEvent(eventCursor, message, reason) {
    return this.transaction(() => {
      let inserted = false;
      if (message) {
        inserted = this.db.prepare('INSERT OR IGNORE INTO inbox (id,message) VALUES (?,?)').run(message.sourceMessageId, JSON.stringify(message)).changes === 1;
        if (!inserted) {
          const prior = this.db.prepare('SELECT message FROM inbox WHERE id=?').get(message.sourceMessageId);
          if (prior && improvesInboxMessage(JSON.parse(prior.message), message)) {
            this.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(message), message.sourceMessageId);
            this.trace('inbound.upgraded', { messageId: message.sourceMessageId, reason });
          }
        }
      }
      this.db.prepare('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('cursor', eventCursor);
      this.trace('inbound.committed', { cursor: eventCursor, messageId: message?.sourceMessageId ?? null, inserted, reason });
      return inserted;
    });
  }
  pending() { return this.db.prepare('SELECT id,message FROM inbox WHERE delivered=0 ORDER BY rowid').all().map(row => ({ id: row.id, message: JSON.parse(row.message) })); }
  delivered(id) { this.db.prepare('UPDATE inbox SET delivered=1 WHERE id=?').run(id); }
  inboxVoiceFailures(limit = 10) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid voice retry limit');
    return this.db.prepare(`SELECT id,message FROM inbox
      WHERE message LIKE '%"voiceState":"failed"%' ORDER BY rowid LIMIT ?`).all(limit)
      .map(row => ({ id: row.id, message: JSON.parse(row.message) }));
  }
  updateInbox(id, message) {
    this.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(message), id);
    this.trace('inbound.updated', { messageId: id, voiceState: message?.voiceState ?? null });
  }
  drafts() { return this.db.prepare('SELECT key,group_id,text,state,approved,attempted_at FROM outbox ORDER BY rowid').all(); }
  sendRecord(key) { return this.db.prepare('SELECT * FROM outbox WHERE key=?').get(key); }
  draft(key, groupId, text, mentionUserIds = [], quote = null) {
    if (!Array.isArray(mentionUserIds) || mentionUserIds.length > 1 ||
        mentionUserIds.some(userId => typeof userId !== 'string' || !userId)) {
      throw new Error('Invalid mention targets');
    }
    const mentions = JSON.stringify(mentionUserIds);
    const quoteJson = JSON.stringify(quote === null ? null : validateQuoteReference(quote));
    const existing = this.sendRecord(key);
    if (existing && (existing.group_id !== groupId || existing.text !== text ||
        existing.mentions_json !== mentions || existing.quote_json !== quoteJson)) throw new Error('Idempotency key content conflict');
    this.db.prepare('INSERT OR IGNORE INTO outbox (key,group_id,text,state,mentions_json,quote_json) VALUES (?,?,?,?,?,?)')
      .run(key, groupId, text, 'draft', mentions, quoteJson);
    return this.sendRecord(key);
  }
  reviseUnsentDraft(key, text, quote = undefined) {
    return this.transaction(() => {
      const row = this.sendRecord(key);
      if (!row || row.state !== 'draft' || row.attempted_at !== null) {
        throw new Error('Only an unsent draft can be revised');
      }
      this.db.prepare("UPDATE outbox SET text=?,approved=0 WHERE key=? AND state='draft'").run(text, key);
      if (quote !== undefined) this.db.prepare('UPDATE outbox SET quote_json=? WHERE key=?')
        .run(JSON.stringify(quote === null ? null : validateQuoteReference(quote)), key);
      this.trace('outbound.revised', { key });
      return this.sendRecord(key);
    });
  }
  approve(key) {
    this.transaction(() => {
      const result = this.db.prepare("UPDATE outbox SET approved=1 WHERE key=? AND state='draft'").run(key);
      if (result.changes !== 1) throw new Error('No draft exists for host approval');
      this.trace('outbound.approved', { key });
    });
    return this.sendRecord(key);
  }
  claim(key, cooldownMs, now = Date.now()) {
    return this.transaction(() => {
      const row = this.sendRecord(key);
      if (!row || !row.approved || row.state !== 'draft') throw new Error('Send is not an approved draft');
      const last = this.db.prepare('SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=?').get(row.group_id).at;
      if (last !== null && now - last < cooldownMs) throw new Error('Group send rate limit');
      this.db.prepare("UPDATE outbox SET state='dispatching',attempted_at=? WHERE key=?").run(now, key);
      return row;
    });
  }
  receipt(key, state, receipt = null) {
    this.transaction(() => {
      this.db.prepare('UPDATE outbox SET state=?,receipt=? WHERE key=?').run(state, receipt === null ? null : JSON.stringify(receipt), key);
      this.trace('outbound.receipt', { key, state, sendId: receipt?.id ?? null });
    });
    return this.sendRecord(key);
  }
}
