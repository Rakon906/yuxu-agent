import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateMomentAsset } from './publish-assets.mjs';
import { gameParticipationViolation } from '../participation/game-boundary.mjs';

const states = new Set(['draft', 'dispatching', 'accepted', 'verified', 'rejected', 'needs_review']);
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024 + 4096;
const DISPATCH_GRACE_MS = 5 * 60 * 1000;
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;
const identity = (value, name) => {
  if (!nonEmpty(value) || value.length > 200 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
};

function content(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid moments draft');
  if (input.media !== undefined && (!Array.isArray(input.media) || input.media.length > 1)) {
    throw new Error('Moments publishing supports at most one image');
  }
  if (input.audience !== undefined && (!Array.isArray(input.audience) || input.audience.length !== 0)) {
    throw new Error('Selected audiences are not implemented');
  }
  const text = input.text;
  if (!nonEmpty(text) || text.length > 5000 || !text.isWellFormed() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(text)) {
    throw new Error('Text must contain 1–5000 valid characters');
  }
  const visibility = input.visibility ?? 'private';
  if (!['private', 'friends'].includes(visibility)) throw new Error('Visibility must be private or friends');
  const media = (input.media ?? []).map(asset => validateMomentAsset(asset));
  return { key: identity(input.key, 'draft key'), accountId: identity(input.accountId, 'account ID'),
    selfUserId: identity(input.selfUserId, 'self user ID'), text, visibility,
    ...(media.length ? { media } : {}) };
}

export function draftDigest(draft) {
  const value = { ...content(draft), createdAt: draft.createdAt, clientId: draft.clientId };
  if (!nonEmpty(value.createdAt) || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid draft date');
  identity(value.clientId, 'client ID');
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function confirmed(actual, expected) {
  return typeof actual === 'string' && /^[a-f0-9]{64}$/u.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

const safeError = error => ({ state: 'needs_review', error: 'transport_or_verification_error',
  errorName: /^[A-Za-z][A-Za-z0-9_]{0,60}$/u.test(error?.name ?? '') ? error.name : 'Error' });
const decode = row => row ? { ...JSON.parse(row.draft_json), state: row.state,
  attemptedAt: row.attempted_at, updatedAt: row.updated_at, momentId: row.moment_id,
  receipt: row.receipt_json ? JSON.parse(row.receipt_json) : null,
  verification: row.verification_json ? JSON.parse(row.verification_json) : null } : null;

/** Dedicated publication ledger. SQLite transactions also protect concurrent CLI processes. */
export class MomentsPublishStore {
  constructor(filename, { readOnly = false, now = Date.now,
    newClientId = () => randomUUID().replaceAll('-', '') } = {}) {
    this.now = now;
    this.newClientId = newClientId;
    if (!readOnly) mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename, { readOnly });
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON');
    if (!readOnly) this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS publications (
        key TEXT PRIMARY KEY, account_id TEXT NOT NULL, draft_json TEXT NOT NULL,
        state TEXT NOT NULL, attempted_at INTEGER, updated_at INTEGER NOT NULL,
        moment_id TEXT, receipt_json TEXT, verification_json TEXT
      );
      CREATE TABLE IF NOT EXISTS publication_responses (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES publications(key),
        phase TEXT NOT NULL CHECK(phase IN ('publish','detail')),
        http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
        body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= ${MAX_RESPONSE_BYTES}),
        sha256 TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS publication_responses_key ON publication_responses(key,id);
      CREATE TABLE IF NOT EXISTS publication_upload_responses (
        id INTEGER PRIMARY KEY, key TEXT NOT NULL REFERENCES publications(key),
        phase TEXT NOT NULL CHECK(phase='upload'),
        http_status INTEGER NOT NULL CHECK(http_status BETWEEN 100 AND 599),
        body TEXT NOT NULL CHECK(length(CAST(body AS BLOB)) <= ${MAX_RESPONSE_BYTES}),
        sha256 TEXT NOT NULL, received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS publication_media (
        key TEXT NOT NULL REFERENCES publications(key), asset_sha256 TEXT NOT NULL,
        receipt_json TEXT NOT NULL, PRIMARY KEY(key,asset_sha256)
      )`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(key) {
    const draft = decode(this.db.prepare('SELECT * FROM publications WHERE key=?').get(identity(key, 'draft key')));
    if (!draft?.media?.length || !this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publication_media'").get()) return draft;
    const uploadedMedia = this.db.prepare('SELECT receipt_json FROM publication_media WHERE key=? ORDER BY rowid')
      .all(key).map(row => JSON.parse(row.receipt_json));
    return uploadedMedia.length ? { ...draft, uploadedMedia } : draft;
  }
  saveUploadedMedia(key, receipt) {
    return this.transaction(() => {
      const draft = this.get(key);
      const pending = draft && (draft.state === 'dispatching' ||
        (draft.state === 'needs_review' && !draft.receipt && !draft.momentId));
      if (!pending || draft.digest !== draftDigest(draft)) throw new Error('Invalid upload draft state');
      const asset = draft.media?.find(item => item.sha256 === receipt?.sha256);
      if (!asset || receipt.width !== asset.width || receipt.height !== asset.height || receipt.bytes !== asset.bytes ||
          typeof receipt.url !== 'string' || !receipt.url || typeof receipt.thumbUrl !== 'string' || !receipt.thumbUrl) {
        throw new Error('Upload receipt does not match image asset');
      }
      const json = JSON.stringify(receipt);
      if (Buffer.byteLength(json) > 65536) throw new Error('Upload receipt too large');
      const prior = this.db.prepare('SELECT receipt_json FROM publication_media WHERE key=? AND asset_sha256=?').get(key, asset.sha256);
      if (prior && prior.receipt_json !== json) throw new Error('Upload receipt conflict');
      this.db.prepare('INSERT OR IGNORE INTO publication_media(key,asset_sha256,receipt_json) VALUES (?,?,?)').run(key, asset.sha256, json);
      return receipt;
    });
  }
  recordResponse(key, response) {
    identity(key, 'draft key');
    if (!response || !['publish', 'detail', 'upload'].includes(response.phase) ||
        !Number.isInteger(response.httpStatus) || response.httpStatus < 100 || response.httpStatus > 599 ||
        typeof response.responseBody !== 'string' || !response.responseBody.isWellFormed() ||
        Buffer.byteLength(response.responseBody, 'utf8') > MAX_RESPONSE_BYTES ||
        typeof response.receivedAt !== 'string' || !Number.isFinite(Date.parse(response.receivedAt))) {
      throw new Error('Invalid or oversized publication response');
    }
    identity(response.accountId, 'response account ID');
    return this.transaction(() => {
      const stored = this.db.prepare('SELECT * FROM publications WHERE key=?').get(key);
      const draft = decode(stored);
      if (!draft || draft.state === 'draft' || draft.attemptedAt === null) {
        throw new Error('Publication has not been attempted');
      }
      if (response.accountId !== stored.account_id || response.accountId !== draft.accountId) {
        throw new Error('Publication response account identity mismatch');
      }
      if (draft.digest !== draftDigest(draft)) throw new Error('Draft integrity check failed');
      const sha256 = createHash('sha256').update(response.responseBody, 'utf8').digest('hex');
      const table = response.phase === 'upload' ? 'publication_upload_responses' : 'publication_responses';
      const inserted = this.db.prepare(`INSERT INTO ${table}
        (key,phase,http_status,body,sha256,received_at) VALUES (?,?,?,?,?,?)`)
        .run(key, response.phase, response.httpStatus, response.responseBody, sha256,
          new Date(response.receivedAt).toISOString());
      return this.db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(inserted.lastInsertRowid);
    });
  }
  responses(key) {
    if (!this.get(key)) throw new Error('Unknown moments draft');
    // A read-only inspection of a pre-upgrade ledger must not migrate it.
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='publication_responses'").get()) return [];
    return this.db.prepare('SELECT * FROM publication_responses WHERE key=? ORDER BY id').all(key);
  }
  draft(input) {
    const payload = content(input);
    return this.transaction(() => {
      const existing = this.get(payload.key);
      if (existing) {
        if (JSON.stringify(content(existing)) !== JSON.stringify(payload)) throw new Error('Draft key content conflict');
        return existing;
      }
      const now = this.now();
      const draft = { ...payload, createdAt: new Date(now).toISOString(), clientId: this.newClientId() };
      draft.digest = draftDigest(draft);
      this.db.prepare('INSERT INTO publications (key,account_id,draft_json,state,updated_at) VALUES (?,?,?,?,?)')
        .run(draft.key, draft.accountId, JSON.stringify(draft), 'draft', now);
      return this.get(draft.key);
    });
  }
  claim(key, confirmation) {
    return this.transaction(() => {
      const row = this.get(key);
      if (!row) throw new Error('Unknown moments draft');
      if (row.digest !== draftDigest(row)) throw new Error('Draft integrity check failed');
      if (!confirmed(confirmation, row.digest)) throw new Error('Send requires --confirm <exact draft digest>');
      if (row.state !== 'draft') return null;
      const now = this.now();
      const result = this.db.prepare("UPDATE publications SET state='dispatching',attempted_at=?,updated_at=? WHERE key=? AND state='draft'")
        .run(now, now, key);
      return result.changes === 1 ? this.get(key) : null;
    });
  }
  update(key, { state, receipt, verification, momentId } = {}) {
    if (!states.has(state) || state === 'draft') throw new Error('Invalid publication state');
    return this.transaction(() => {
      const existing = this.get(key);
      if (!existing || existing.state === 'draft') throw new Error('Publication has not been attempted');
      // A concurrent status check cannot downgrade a proven result.
      if (existing.state === 'verified') return existing;
      const id = momentId ?? existing.momentId;
      if (existing.momentId && id !== existing.momentId) throw new Error('Publication moment ID conflict');
      this.db.prepare('UPDATE publications SET state=?,moment_id=?,receipt_json=?,verification_json=?,updated_at=? WHERE key=?')
        .run(state, id ?? null, receipt === undefined ? (existing.receipt ? JSON.stringify(existing.receipt) : null) : JSON.stringify(receipt),
          verification === undefined ? (existing.verification ? JSON.stringify(existing.verification) : null) : JSON.stringify(verification), this.now(), key);
      return this.get(key);
    });
  }
}

export class MomentsPublishService {
  constructor({ store, gateway = null, accountId, selfUserId }) {
    if (!store || typeof store.claim !== 'function') throw new Error('A publication store is required');
    this.store = store;
    this.gateway = gateway;
    this.accountId = identity(accountId, 'account ID');
    this.selfUserId = identity(selfUserId, 'self user ID');
  }
  get(key) {
    const draft = this.store.get(key);
    if (!draft) throw new Error('Unknown moments draft');
    if (draft.accountId !== this.accountId || draft.selfUserId !== this.selfUserId) throw new Error('Draft account identity mismatch');
    if (draft.digest !== draftDigest(draft)) throw new Error('Draft integrity check failed');
    return draft;
  }
  draft(input) {
    if ((input.accountId !== undefined && input.accountId !== this.accountId) ||
        (input.selfUserId !== undefined && input.selfUserId !== this.selfUserId)) throw new Error('Draft account identity mismatch');
    return this.store.draft({ ...input, accountId: this.accountId, selfUserId: this.selfUserId });
  }
  async send(key, confirmation) {
    const draft = this.get(key);
    if (draft.state === 'draft' && gameParticipationViolation(draft.text)) {
      throw new Error('Game participation claim is not allowed');
    }
    if (typeof this.gateway?.publish !== 'function' || typeof this.gateway?.verify !== 'function') throw new Error('A native publisher is required');
    if (draft.media?.length && typeof this.gateway?.uploadImage !== 'function') throw new Error('A native image uploader is required');
    let claimed = this.store.claim(key, confirmation);
    // Previously attempted drafts are NEVER submitted again, even after timeout or restart.
    if (!claimed) return this.status(key);
    if (claimed.media?.length) {
      try {
        for (const asset of claimed.media) {
          const receipt = await this.gateway.uploadImage(asset, {
            onResponse: response => this.store.recordResponse(key, { ...response, phase: 'upload', accountId: this.accountId }),
          });
          this.store.saveUploadedMedia(key, receipt);
        }
        claimed = this.get(key);
      } catch (error) {
        return this.store.update(key, { state: 'needs_review', receipt: { ...safeError(error), phase: 'upload' } });
      }
    }
    let result;
    try { result = await this.gateway.publish(claimed, {
      onResponse: response => this.store.recordResponse(key, { ...response, accountId: this.accountId }),
    }); }
    catch (error) { return this.store.update(key, { state: 'needs_review', receipt: safeError(error) }); }
    const state = ['accepted', 'rejected', 'needs_review'].includes(result?.state) ? result.state : 'needs_review';
    const momentId = nonEmpty(result?.momentId) ? result.momentId : null;
    this.store.update(key, { state, receipt: result ?? { error: 'empty_publish_receipt' }, momentId });
    return state === 'rejected' ? this.get(key) : this.status(key);
  }
  async status(key) {
    let draft = this.get(key);
    if (['draft', 'verified', 'rejected'].includes(draft.state)) return draft;
    if (typeof this.gateway?.verify !== 'function') throw new Error('A native verifier is required');
    if (!draft.momentId && typeof this.gateway.recoverReceipt === 'function') {
      try {
        const recovered = await this.gateway.recoverReceipt(draft, this.store.responses(key));
        if (nonEmpty(recovered?.momentId)) draft = this.store.update(key, {
          state: 'needs_review', momentId: recovered.momentId,
          verification: { recoveredReceiptId: true },
        });
      } catch (error) {
        return this.store.update(key, { state: 'needs_review', verification: safeError(error) });
      }
    }
    // A concurrent read cannot treat an upload that is still in flight as a
    // failed publication. The grace period never permits another submission.
    if (draft.state === 'dispatching' && !draft.momentId && !draft.receipt &&
        this.store.now() - draft.attemptedAt < DISPATCH_GRACE_MS) return draft;
    let result;
    try { result = await this.gateway.verify(draft, {
      publicationResponses: this.store.responses(key),
      onResponse: response => this.store.recordResponse(key, { ...response, accountId: this.accountId }),
    }); }
    catch (error) { return this.store.update(key, { state: 'needs_review', verification: safeError(error) }); }
    const id = nonEmpty(result?.momentId) ? result.momentId : null;
    const verified = result?.verified === true && id && (!draft.momentId || id === draft.momentId);
    return this.store.update(key, { state: verified ? 'verified' : 'needs_review',
      verification: result ?? { error: 'empty_verification' }, momentId: verified ? id : draft.momentId });
  }
}
