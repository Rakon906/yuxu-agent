import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200;

/** Self-authored SNS text stays distinct from group quotes, image guesses and stable traits. */
export class MomentPersonMemory {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS moments_sources (
        account_id TEXT NOT NULL, moment_id TEXT NOT NULL, author_id TEXT NOT NULL,
        text TEXT NOT NULL, published_at INTEGER NOT NULL, checked_at INTEGER NOT NULL,
        digest TEXT NOT NULL, state TEXT NOT NULL,
        PRIMARY KEY(account_id,moment_id));
      CREATE TABLE IF NOT EXISTS moments_observations (
        account_id TEXT NOT NULL, moment_id TEXT NOT NULL, position INTEGER NOT NULL,
        kind TEXT NOT NULL, quote TEXT NOT NULL, source_digest TEXT NOT NULL,
        PRIMARY KEY(account_id,moment_id,position));
      CREATE INDEX IF NOT EXISTS moments_person ON moments_sources(account_id,author_id,published_at);`);
  }
  close() { this.db.close(); }
  record({ accountId, moment, proposals = [], now = Date.now() }) {
    if (!validId(accountId) || !validId(moment?.id) || !validId(moment?.author?.id)) throw new Error('Invalid Moments memory identity');
    const previous = this.db.prepare('SELECT * FROM moments_sources WHERE account_id=? AND moment_id=?').get(accountId, moment.id);
    if (previous && previous.author_id !== moment.author.id) throw new Error('Moments author changed');
    const revoked = moment.deleted === true || moment.recalled === true || moment.state === 'deleted';
    if (revoked) {
      this.db.prepare("UPDATE moments_sources SET state='deleted',checked_at=? WHERE account_id=? AND moment_id=?").run(now, accountId, moment.id);
      return { recorded: 0, deleted: true };
    }
    const text = typeof moment.text === 'string' ? moment.text.trim() : '';
    if (previous && (!text || moment.private || moment.advertisement)) {
      this.db.prepare("UPDATE moments_sources SET state='withdrawn',checked_at=? WHERE account_id=? AND moment_id=?")
        .run(now, accountId, moment.id);
      return { recorded: 0, withdrawn: true };
    }
    const at = Number(moment.createTime) * 1000;
    if (!text || text.length > 10000 || !Number.isFinite(at) || at <= 0 || at > now + 60000 || moment.private || moment.advertisement) return { recorded: 0 };
    const sourceDigest = hash([moment.author.id, text, at]);
    // No synthesized prose is accepted as evidence. A photo alone never establishes a hobby.
    const reported = /(?:他说|她说|转发|代发|朋友说|同事说|朋友的|同事的)|[“「]/u.test(text);
    const accepted = (Array.isArray(proposals) ? proposals : []).slice(0, 4).filter(item => !reported &&
      item && ['recent_update', 'preference'].includes(item.kind) &&
      typeof item.evidenceQuote === 'string' && item.evidenceQuote.length >= 2 &&
      item.evidenceQuote.length <= 300 && text.includes(item.evidenceQuote) &&
      (item.subjectId == null || item.subjectId === moment.author.id) &&
      !/(?:他说|她说|转发|代发|朋友说|同事说)/u.test(item.evidenceQuote));
    const observations = accepted.length ? accepted.map(item => ({ kind: item.kind, quote: item.evidenceQuote }))
      : [{ kind: 'observed_post', quote: text.slice(0, 300) }];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO moments_sources VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,moment_id) DO UPDATE SET text=excluded.text,published_at=excluded.published_at,
        checked_at=excluded.checked_at,digest=excluded.digest,state=excluded.state`)
        .run(accountId, moment.id, moment.author.id, text, at, now, sourceDigest, 'visible');
      // A read without a new model proposal retains verified classifications for identical text.
      if (!previous || previous.digest !== sourceDigest || accepted.length) {
        this.db.prepare('DELETE FROM moments_observations WHERE account_id=? AND moment_id=?').run(accountId, moment.id);
        const insert = this.db.prepare('INSERT INTO moments_observations VALUES (?,?,?,?,?,?)');
        observations.forEach((item, i) => insert.run(accountId, moment.id, i, item.kind, item.quote, sourceDigest));
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { recorded: observations.length };
  }
}

export function readMomentObservations(filename, { accountId, subjectId, limit = 4, now = Date.now(), maxVerificationAgeMs = 48 * 3600000 }) {
  if (!validId(accountId) || !validId(subjectId) || !Number.isInteger(limit) || limit < 1 || limit > 12) throw new Error('Invalid Moments observation scope');
  if (!existsSync(filename)) return [];
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=3000');
    return db.prepare(`SELECT s.*,o.kind,o.quote FROM moments_sources s JOIN moments_observations o
      ON s.account_id=o.account_id AND s.moment_id=o.moment_id AND s.digest=o.source_digest
      WHERE s.account_id=? AND s.author_id=? AND s.state='visible' AND s.checked_at>=? AND s.checked_at<=?
      ORDER BY s.published_at DESC LIMIT ?`)
      .all(accountId, subjectId, now - maxVerificationAgeMs, now + 60000, limit).filter(row => row.text.includes(row.quote)).map(row => ({
        subjectId, category: 'moments', kind: row.kind, state: 'self_report',
        sourceType: 'friend_moment', observedAt: new Date(row.published_at).toISOString(),
        lastVerifiedAt: new Date(row.checked_at).toISOString(), ageDays: Math.max(0, Math.floor((now - row.published_at) / 86400000)),
        uncertainty: '好友当时发布的原话，不等于当前状态或确定爱好；转述内容不归属作者，不向群里公开其朋友圈原文或私事。',
        evidence: [{ id: row.moment_id, sourceMomentId: row.moment_id, speakerId: subjectId,
          at: new Date(row.published_at).toISOString(), quote: row.quote }],
      }));
  } finally { db.close(); }
}
