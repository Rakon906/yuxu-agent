import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DAY = 24 * 3600000;

export class MomentsLedger {
  constructor(filename) {
    if (typeof filename !== 'string' || !filename) throw new Error('Moments ledger requires a filename');
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS moment_actions (
        key TEXT PRIMARY KEY, kind TEXT NOT NULL, moment_id TEXT NOT NULL,
        author_id TEXT, text TEXT, client_id TEXT, comment_id TEXT,
        state TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS moment_actions_moment ON moment_actions(moment_id,kind);
      CREATE INDEX IF NOT EXISTS moment_actions_comment ON moment_actions(moment_id,comment_id);
      CREATE TABLE IF NOT EXISTS moment_seen (
        moment_id TEXT PRIMARY KEY, author_id TEXT, author_name TEXT, created_at TEXT,
        text TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, comment TEXT,
        decided_at INTEGER NOT NULL, acted_at INTEGER, state TEXT NOT NULL,
        client_id TEXT, comment_id TEXT);
      CREATE TABLE IF NOT EXISTS moment_daily (
        day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(day,kind));
      CREATE TABLE IF NOT EXISTS moment_schedule (
        id INTEGER PRIMARY KEY CHECK(id=1), next_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS moment_media (
        media_key TEXT PRIMARY KEY, sha256 TEXT NOT NULL, scene TEXT NOT NULL,
        visible_text TEXT NOT NULL, tone TEXT NOT NULL, safety TEXT NOT NULL,
        model TEXT NOT NULL, described_at INTEGER NOT NULL, byte_length INTEGER);
      CREATE TABLE IF NOT EXISTS moment_trace (
        seq INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(moment_media)').all().some(column => column.name === 'byte_length')) {
      this.db.exec('ALTER TABLE moment_media ADD COLUMN byte_length INTEGER');
    }
  }

  close() { this.db.close(); }

  getMeta(key) {
    return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null;
  }

  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, String(value));
    return value;
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  trace(kind, detail) {
    this.db.prepare('INSERT INTO moment_trace (at,kind,detail) VALUES (?,?,?)')
      .run(new Date().toISOString(), kind, JSON.stringify(detail));
  }

  dayKey(now = Date.now()) {
    const value = new Date(now + 8 * 3600000);
    return value.toISOString().slice(0, 10);
  }

  seen(momentId) {
    return this.db.prepare('SELECT * FROM moment_seen WHERE moment_id=?').get(momentId) ?? null;
  }

  markSeen({ momentId, authorId = null, authorName = null, createdAt = null, text = '',
    decision = 'none', reason = '', comment = '', state = 'decided', now = Date.now() }) {
    this.db.prepare(`INSERT INTO moment_seen
      (moment_id,author_id,author_name,created_at,text,decision,reason,comment,decided_at,state)
      VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(moment_id) DO UPDATE SET
      decision=excluded.decision,reason=excluded.reason,comment=excluded.comment,
      decided_at=excluded.decided_at,state=excluded.state`)
      .run(momentId, authorId, authorName, createdAt, text, decision, reason, comment, now, state);
    return this.seen(momentId);
  }

  markActed(momentId, { state = 'acted', actedAt = Date.now(), clientId = null, commentId = null } = {}) {
    this.db.prepare(`UPDATE moment_seen SET state=?,acted_at=?,client_id=COALESCE(?,client_id),
      comment_id=COALESCE(?,comment_id) WHERE moment_id=?`)
      .run(state, actedAt, clientId, commentId, momentId);
    return this.seen(momentId);
  }

  recordAction({ key, kind, momentId, authorId = null, text = '', clientId = null,
    state = 'dispatching', now = Date.now() }) {
    this.db.prepare(`INSERT INTO moment_actions
      (key,kind,moment_id,author_id,text,client_id,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET state=excluded.state,updated_at=excluded.updated_at`)
      .run(key, kind, momentId, authorId, text, clientId, state, now, now);
    return this.action(key);
  }

  action(key) {
    return this.db.prepare('SELECT * FROM moment_actions WHERE key=?').get(key) ?? null;
  }

  updateAction(key, { state, commentId = null, receipt = null, now = Date.now() } = {}) {
    this.db.prepare(`UPDATE moment_actions SET state=?,comment_id=COALESCE(?,comment_id),
      receipt=COALESCE(?,receipt),updated_at=? WHERE key=?`)
      .run(state, commentId, receipt === null ? null : JSON.stringify(receipt), now, key);
    return this.action(key);
  }

  findCommentClientId(momentId, commentId) {
    return this.db.prepare(`SELECT client_id FROM moment_actions
      WHERE moment_id=? AND comment_id=? AND client_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(momentId, String(commentId))?.client_id ?? null;
  }

  findLatestClientId(momentId, kind) {
    return this.db.prepare(`SELECT client_id FROM moment_actions
      WHERE moment_id=? AND kind=? AND client_id IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`).get(momentId, kind)?.client_id ?? null;
  }

  recentActions({ since = Date.now() - DAY, kind = null } = {}) {
    if (kind) {
      return this.db.prepare(`SELECT * FROM moment_actions WHERE created_at>=? AND kind=?
        ORDER BY created_at DESC`).all(since, kind);
    }
    return this.db.prepare('SELECT * FROM moment_actions WHERE created_at>=? ORDER BY created_at DESC')
      .all(since);
  }

  countToday(kind, now = Date.now()) {
    return this.db.prepare('SELECT count FROM moment_daily WHERE day=? AND kind=?')
      .get(this.dayKey(now), kind)?.count ?? 0;
  }

  incrementToday(kind, now = Date.now()) {
    this.db.prepare(`INSERT INTO moment_daily (day,kind,count) VALUES (?,?,1)
      ON CONFLICT(day,kind) DO UPDATE SET count=count+1`).run(this.dayKey(now), kind);
    return this.countToday(kind, now);
  }

  mediaDescription(mediaKey) {
    if (typeof mediaKey !== 'string' || !mediaKey) return null;
    const row = this.db.prepare('SELECT * FROM moment_media WHERE media_key=?').get(mediaKey);
    return row ? { mediaKey: row.media_key, sha256: row.sha256, scene: row.scene,
      visibleText: row.visible_text, tone: row.tone, safety: row.safety, model: row.model,
      describedAt: row.described_at, byteLength: row.byte_length } : null;
  }

  saveMediaDescription({ mediaKey, sha256, scene, visibleText = '', tone = '', safety = 'uncertain',
    model = 'unknown', byteLength = null, now = Date.now() }) {
    if (typeof mediaKey !== 'string' || !mediaKey) throw new Error('Media description needs a key');
    this.db.prepare(`INSERT INTO moment_media
      (media_key,sha256,scene,visible_text,tone,safety,model,described_at,byte_length) VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(media_key) DO UPDATE SET sha256=excluded.sha256,scene=excluded.scene,visible_text=excluded.visible_text,
      tone=excluded.tone,safety=excluded.safety,model=excluded.model,described_at=excluded.described_at,
      byte_length=excluded.byte_length`)
      .run(mediaKey, sha256, scene, visibleText, tone, safety, model, now, byteLength);
    return this.mediaDescription(mediaKey);
  }

  nextScheduled() {
    return this.db.prepare('SELECT next_at FROM moment_schedule WHERE id=1').get()?.next_at ?? null;
  }

  scheduleNext(at) {
    this.db.prepare('INSERT INTO moment_schedule (id,next_at) VALUES (1,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at').run(at);
    return at;
  }
}
