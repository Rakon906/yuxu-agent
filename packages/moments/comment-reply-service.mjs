import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { gameParticipationViolation } from '../participation/game-boundary.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 + 4096;
const STATES = new Set(['draft', 'dispatching', 'accepted', 'verified', 'rejected',
  'needs_review', 'stale', 'skipped']);
const TERMINAL = new Set(['draft', 'verified', 'rejected', 'stale', 'skipped']);
const invalidText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u;

function identity(value, label) {
  if (typeof value !== 'string' || !value || value.length > 200 || !value.isWellFormed() || /[\s\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
}

function objectId(value, label) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`Invalid ${label}`);
  const string = String(value ?? '');
  if (!/^[1-9][0-9]{0,19}$/u.test(string) || BigInt(string) > 0xffffffffffffffffn) {
    throw new Error(`Invalid ${label}`);
  }
  return string;
}

function timestamp(value, label, optional = false) {
  if (optional && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid ${label}`);
  return value;
}

function replyText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 300 ||
      !value.isWellFormed() || invalidText.test(value)) throw new Error('Invalid reply text');
  return value;
}

function sourceComment(comment) {
  if (!comment || typeof comment !== 'object') throw new Error('Invalid source comment');
  if (comment.replyReferenceSupported === false) throw new Error('Extended comment reference is unsupported');
  if (typeof comment.text !== 'string' || comment.text.length > 10000 ||
      !comment.text.isWellFormed() || invalidText.test(comment.text)) throw new Error('Invalid source text');
  return {
    commentId: objectId(comment.commentId, 'source comment ID'),
    userId: identity(comment.userId, 'source author'),
    name: typeof comment.name === 'string' ? comment.name.slice(0, 200) : '',
    type: comment.type ?? 2,
    source: comment.source ?? 0,
    text: comment.text,
    createTime: timestamp(comment.createTime, 'source creation time', true),
    replyTo: comment.replyTo ? identity(comment.replyTo, 'source reply target') : null,
    replyCommentId: comment.replyCommentId && String(comment.replyCommentId) !== '0'
      ? objectId(comment.replyCommentId, 'source root comment ID') : null,
  };
}

function sameSource(a, b) {
  try {
    const left = sourceComment(a), right = sourceComment(b);
    return ['commentId', 'userId', 'text', 'createTime', 'replyTo', 'replyCommentId', 'type', 'source']
      .every(key => left[key] === right[key]);
  } catch { return false; }
}

function snapshotMoment(moment) {
  if (!moment || typeof moment !== 'object' || !Array.isArray(moment.comments)) {
    throw new Error('A moment with comments is required');
  }
  const id = objectId(moment.id, 'moment ID');
  const authorId = identity(moment.author?.id, 'moment author');
  const serialized = JSON.stringify(moment);
  if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error('Moment snapshot is too large');
  const copy = JSON.parse(serialized);
  copy.id = id;
  copy.author.id = authorId;
  return copy;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const digestFor = draft => sha256(canonical({ key: draft.key, accountId: draft.accountId,
  selfId: draft.selfId, moment: draft.moment, comment: draft.comment, text: draft.text,
  clientId: draft.clientId, createdAt: draft.createdAt }));
const confirmed = (value, expected) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) &&
  timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(expected, 'hex'));
const errorResult = error => ({ reason: 'transport_or_verification_error',
  errorName: /^[A-Za-z][A-Za-z0-9_]{0,60}$/u.test(error?.name ?? '') ? error.name : 'Error' });

function decode(row) {
  if (!row) return null;
  const draft = JSON.parse(row.draft_json);
  if (draft.digest !== row.digest || digestFor(draft) !== row.digest ||
      draft.accountId !== row.account_id || draft.selfId !== row.self_id ||
      draft.key !== row.key || draft.moment.id !== row.moment_id ||
      draft.comment.commentId !== row.source_comment_id) throw new Error('Reply draft integrity check failed');
  return { ...draft, state: row.state, attemptedAt: row.attempted_at,
    priorCommentIds: JSON.parse(row.prior_comment_ids), updatedAt: row.updated_at,
    receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
    verification: row.verification_json ? JSON.parse(row.verification_json) : null };
}

/** A separate account-bound ledger; one immutable job for each source comment. */
export class CommentReplyStore {
  constructor(filename, { accountId, selfId, now = Date.now, readOnly = false } = {}) {
    this.accountId = identity(accountId, 'account ID');
    this.selfId = identity(selfId, 'self ID');
    this.now = now;
    if (typeof filename !== 'string' || !filename) throw new Error('Reply ledger path is required');
    if (!readOnly) mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { readOnly });
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
      const hasMeta = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='comment_reply_meta'").get();
      const saved = hasMeta && this.db.prepare("SELECT value FROM comment_reply_meta WHERE key='identity'").get();
      const binding = JSON.stringify({ accountId: this.accountId, selfId: this.selfId });
      if (saved && saved.value !== binding) throw new Error('Reply ledger account identity mismatch');
      if (readOnly) {
        if (!saved) throw new Error('Reply ledger identity is missing');
      } else {
        this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
        this.transaction(() => {
          this.db.exec(`CREATE TABLE IF NOT EXISTS comment_reply_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS comment_reply_jobs (
              key TEXT PRIMARY KEY, account_id TEXT NOT NULL, self_id TEXT NOT NULL,
              moment_id TEXT NOT NULL, source_comment_id TEXT NOT NULL,
              draft_json TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL,
              attempted_at INTEGER, prior_comment_ids TEXT NOT NULL DEFAULT '[]',
              receipt_json TEXT, verification_json TEXT, updated_at INTEGER NOT NULL,
              UNIQUE(account_id,moment_id,source_comment_id));
            CREATE TABLE IF NOT EXISTS comment_reply_responses (
              id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES comment_reply_jobs(key),
              phase TEXT NOT NULL CHECK(phase IN ('send','detail')),
              http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
              body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= ${MAX_RESPONSE_BYTES}),
              sha256 TEXT NOT NULL, received_at TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS comment_reply_responses_key ON comment_reply_responses(key,id)`);
          this.db.prepare("INSERT OR IGNORE INTO comment_reply_meta(key,value) VALUES ('identity',?)").run(binding);
          if (this.db.prepare("SELECT value FROM comment_reply_meta WHERE key='identity'").get().value !== binding) {
            throw new Error('Reply ledger account identity mismatch');
          }
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key) {
    const result = decode(this.db.prepare('SELECT * FROM comment_reply_jobs WHERE key=?').get(identity(key, 'reply key')));
    if (result && (result.accountId !== this.accountId || result.selfId !== this.selfId)) {
      throw new Error('Reply draft account identity mismatch');
    }
    return result;
  }
  rows(states = null) {
    const wanted = states === null ? null : (Array.isArray(states) ? states : [states]);
    if (wanted?.some(state => !STATES.has(state))) throw new Error('Invalid reply state filter');
    return this.db.prepare('SELECT key FROM comment_reply_jobs ORDER BY updated_at,key').all()
      .map(row => this.get(row.key)).filter(row => !wanted || wanted.includes(row.state));
  }
  prepare({ moment, comment, text }) {
    const snapshot = snapshotMoment(moment);
    const source = sourceComment(comment);
    if (source.userId === this.selfId) throw new Error('Cannot reply to your own comment');
    const matches = snapshot.comments.filter(item => String(item.commentId) === source.commentId);
    if (matches.length !== 1 || !sameSource(matches[0], source)) throw new Error('Source comment does not match moment');
    const body = replyText(text);
    const key = `reply-${sha256(JSON.stringify([this.accountId, snapshot.id, source.commentId]))}`;
    return this.transaction(() => {
      const existing = this.get(key);
      if (existing) {
        if (existing.text !== body || !sameSource(existing.comment, source) ||
            existing.moment.author.id !== snapshot.author.id) throw new Error('Source comment already has a different immutable reply');
        return existing;
      }
      const now = timestamp(this.now(), 'current time');
      const draft = { key, accountId: this.accountId, selfId: this.selfId,
        moment: snapshot, comment: source, text: body,
        clientId: randomUUID().replaceAll('-', ''), createdAt: new Date(now).toISOString() };
      draft.digest = digestFor(draft);
      this.db.prepare(`INSERT INTO comment_reply_jobs
        (key,account_id,self_id,moment_id,source_comment_id,draft_json,digest,state,updated_at)
        VALUES (?,?,?,?,?,?,?,'draft',?)`).run(key, this.accountId, this.selfId, snapshot.id,
          source.commentId, JSON.stringify(draft), draft.digest, now);
      return this.get(key);
    });
  }
  claim(key, confirmation, priorCommentIds) {
    const ids = [...new Set(priorCommentIds.map(id => objectId(id, 'prior comment ID')))];
    return this.transaction(() => {
      const draft = this.get(key);
      if (!draft) throw new Error('Unknown reply draft');
      if (!confirmed(confirmation, draft.digest)) throw new Error('Exact reply digest confirmation is required');
      if (draft.state !== 'draft') return null;
      const now = timestamp(this.now(), 'current time');
      const result = this.db.prepare(`UPDATE comment_reply_jobs SET state='dispatching',attempted_at=?,
        prior_comment_ids=?,updated_at=? WHERE key=? AND state='draft'`).run(now, JSON.stringify(ids), now, key);
      return result.changes === 1 ? this.get(key) : null;
    });
  }
  finishBeforeSend(key, state, verification) {
    if (!['stale', 'skipped'].includes(state)) throw new Error('Invalid preflight state');
    return this.transaction(() => {
      if (!this.get(key)) throw new Error('Unknown reply draft');
      this.db.prepare(`UPDATE comment_reply_jobs SET state=?,verification_json=?,updated_at=?
        WHERE key=? AND state='draft'`).run(state, JSON.stringify(verification), this.now(), key);
      return this.get(key);
    });
  }
  update(key, { state, receipt, verification }) {
    if (!['accepted', 'verified', 'rejected', 'needs_review'].includes(state)) throw new Error('Invalid reply update');
    return this.transaction(() => {
      const existing = this.get(key);
      if (!existing || existing.attemptedAt === null || existing.state === 'draft') throw new Error('Reply was not attempted');
      if (['verified', 'rejected'].includes(existing.state)) return existing;
      this.db.prepare(`UPDATE comment_reply_jobs SET state=?,receipt_json=?,verification_json=?,updated_at=? WHERE key=?`)
        .run(state, receipt === undefined ? JSON.stringify(existing.receipt) : JSON.stringify(receipt),
          verification === undefined ? JSON.stringify(existing.verification) : JSON.stringify(verification), this.now(), key);
      return this.get(key);
    });
  }
  recordResponse(key, response) {
    if (!response || !['send', 'detail'].includes(response.phase) ||
        !Number.isInteger(response.httpStatus) || response.httpStatus < 100 || response.httpStatus > 599 ||
        typeof response.responseBody !== 'string' || !response.responseBody.isWellFormed() ||
        Buffer.byteLength(response.responseBody) > MAX_RESPONSE_BYTES ||
        typeof response.receivedAt !== 'string' || !Number.isFinite(Date.parse(response.receivedAt))) {
      throw new Error('Invalid or oversized reply response');
    }
    return this.transaction(() => {
      const draft = this.get(key);
      if (!draft || draft.attemptedAt === null) throw new Error('Reply was not attempted');
      if (response.accountId !== this.accountId || response.selfId !== this.selfId) throw new Error('Reply response account identity mismatch');
      this.db.prepare(`INSERT INTO comment_reply_responses
        (key,phase,http_status,body,sha256,received_at) VALUES (?,?,?,?,?,?)`).run(key, response.phase,
          response.httpStatus, response.responseBody, sha256(response.responseBody), new Date(response.receivedAt).toISOString());
    });
  }
  responses(key) {
    if (!this.get(key)) throw new Error('Unknown reply draft');
    return this.db.prepare('SELECT * FROM comment_reply_responses WHERE key=? ORDER BY id').all(key);
  }
}

function existingReply(moment, draft) {
  return moment.comments.find(comment => comment.userId === draft.selfId && comment.text === draft.text &&
    comment.replyTo === draft.comment.userId && String(comment.replyCommentId ?? '') === draft.comment.commentId &&
    (draft.comment.createTime === null || Number(comment.createTime) >= draft.comment.createTime));
}

export class CommentReplyService {
  constructor({ store, gateway = null, accountId, selfId }) {
    this.accountId = identity(accountId, 'account ID');
    this.selfId = identity(selfId, 'self ID');
    if (!store || store.accountId !== accountId || store.selfId !== selfId) throw new Error('Reply store account identity mismatch');
    this.store = store;
    this.gateway = gateway;
  }
  get(key) {
    const draft = this.store.get(key);
    if (!draft) throw new Error('Unknown reply draft');
    return draft;
  }
  prepare(input) { return this.store.prepare(input); }
  responseOptions(key) {
    return { onResponse: response => this.store.recordResponse(key,
      { ...response, accountId: this.accountId, selfId: this.selfId }) };
  }
  async send(key, confirmation) {
    const draft = this.get(key);
    if (!confirmed(confirmation, draft.digest)) throw new Error('Exact reply digest confirmation is required');
    if (draft.state !== 'draft') return this.status(key);
    if (gameParticipationViolation(draft.text, { contextText: `${draft.comment.text}\n${draft.moment.text ?? ''}` })) {
      return this.store.finishBeforeSend(key, 'skipped', { reason: 'cannot_play_games' });
    }
    if (typeof this.gateway?.readMoment !== 'function' || typeof this.gateway?.send !== 'function' ||
        typeof this.gateway?.verify !== 'function') throw new Error('A comment reply gateway is required');
    let current;
    try { current = await this.gateway.readMoment(draft.moment.id); }
    catch { throw new Error('Reply preflight could not read the source; no reply was submitted'); }
    if (!current || String(current.id) !== draft.moment.id || current.author?.id !== draft.moment.author.id ||
        !Array.isArray(current.comments)) {
      return this.store.finishBeforeSend(key, 'stale', { reason: 'source_moment_unavailable_or_changed' });
    }
    const sources = current.comments.filter(comment => String(comment.commentId) === draft.comment.commentId);
    if (sources.length !== 1 || !sameSource(sources[0], draft.comment)) {
      return this.store.finishBeforeSend(key, 'stale', { reason: 'source_comment_missing_or_changed' });
    }
    const already = existingReply(current, draft);
    if (already) return this.store.finishBeforeSend(key, 'skipped', {
      reason: 'already_replied', commentId: objectId(already.commentId, 'existing reply ID') });
    const claimed = this.store.claim(key, confirmation, current.comments.map(comment => comment.commentId));
    if (!claimed) return this.status(key);
    let receipt;
    try {
      receipt = await this.gateway.send({ moment: claimed.moment, comment: claimed.comment,
        selfId: this.selfId, clientId: claimed.clientId, text: claimed.text,
        attemptedAt: claimed.attemptedAt }, this.responseOptions(key));
    } catch (error) {
      return this.store.update(key, { state: 'needs_review', receipt: errorResult(error) });
    }
    const hasStatus = Number.isInteger(receipt?.baseCode) && receipt.ok !== false && !receipt.error;
    const state = hasStatus ? (receipt.baseCode === 0 ? 'accepted' : 'rejected') : 'needs_review';
    this.store.update(key, { state, receipt: receipt ?? { reason: 'empty_reply_receipt' } });
    return state === 'rejected' ? this.get(key) : this.status(key);
  }
  async status(key) {
    const draft = this.get(key);
    if (TERMINAL.has(draft.state)) return draft;
    if (typeof this.gateway?.verify !== 'function') throw new Error('A comment reply verifier is required');
    let result;
    try {
      result = await this.gateway.verify({ momentId: draft.moment.id, sourceComment: draft.comment,
        priorCommentIds: draft.priorCommentIds, selfId: this.selfId, text: draft.text,
        sentAt: Math.floor(draft.attemptedAt / 1000), clientId: draft.clientId }, this.responseOptions(key));
    } catch (error) {
      return this.store.update(key, { state: 'needs_review', verification: errorResult(error) });
    }
    let commentId = null;
    try { commentId = objectId(result?.commentId, 'verified reply ID'); } catch { /* No proven reply. */ }
    const sameTarget = (result?.momentId === undefined || String(result.momentId) === draft.moment.id) &&
      (result?.sourceCommentId === undefined || String(result.sourceCommentId) === draft.comment.commentId) &&
      (result?.replyCommentId === undefined || String(result.replyCommentId) === draft.comment.commentId) &&
      (result?.replyTo === undefined || result.replyTo === draft.comment.userId) &&
      (result?.authorId === undefined || result.authorId === this.selfId) &&
      (result?.text === undefined || result.text === draft.text);
    const verified = result?.verified === true && commentId !== null && sameTarget &&
      !draft.priorCommentIds.includes(commentId);
    return this.store.update(key, { state: verified ? 'verified' : 'needs_review',
      verification: { ...(result ?? { reason: 'empty_verification' }), verified,
        ...(!sameTarget ? { reason: 'verification_target_mismatch' } : {}),
        ...(commentId && draft.priorCommentIds.includes(commentId) ? { reason: 'reply_id_existed_before_send' } : {}) } });
  }
}
