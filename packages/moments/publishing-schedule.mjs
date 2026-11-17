import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { validateMomentAsset } from './publish-assets.mjs';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ZONE = 8 * HOUR;
const GAP = 36 * HOUR;
const ROLLING = 7 * DAY;
const MIN_DELAY = HOUR / 2;
const MAX_DELAY = 4 * HOUR;
const ACTIVE = ['evaluating', 'selected', 'generating', 'ready', 'prepared', 'dispatching', 'needs_review'];
const OUTCOMES = new Set(['accepted', 'verified', 'rejected', 'needs_review']);
const nonEmpty = value => typeof value === 'string' && value.trim().length > 0;

function key(value, name = 'key') {
  if (!nonEmpty(value) || value.length > 240 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}
function time(value, name = 'time') {
  if (!Number.isSafeInteger(value) || value < 0 || value > 8_000_000_000_000_000) throw new Error(`Invalid ${name}`);
  return value;
}
function digest(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error(`Invalid ${name}`);
  return value;
}
function text(value, name, max) {
  if (!nonEmpty(value) || value.length > max || !value.isWellFormed() ||
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(value)) throw new Error(`Invalid ${name}`);
  return value.trim();
}
function sample(random) {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Random sample must be in [0,1)');
  return value;
}
function sourceJson(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) throw new Error('Invalid source metadata');
  const result = JSON.stringify(source);
  if (Buffer.byteLength(result) > 32_768) throw new Error('Source metadata too large');
  return result;
}
function dayStart(now) { return Math.floor((time(now) + ZONE) / DAY) * DAY - ZONE; }

/** All calendar boundaries are fixed to Asia/Shanghai, independent of host timezone. */
export function momentsPublishingWeek(now) {
  const day = dayStart(now);
  const weekday = new Date(now + ZONE).getUTCDay();
  const startsAt = day - ((weekday + 6) % 7) * DAY;
  return { weekKey: new Date(startsAt + ZONE).toISOString().slice(0, 10), startsAt, endsAt: startsAt + ROLLING };
}

export function momentsPublishingWindow(now) {
  const day = dayStart(now);
  const opensAt = day + 12 * HOUR;
  const closesAt = day + DAY;
  return { open: now >= opensAt && now < closesAt, opensAt, closesAt,
    nextOpenAt: now < opensAt ? opensAt : now < closesAt ? now : opensAt + DAY };
}

function dueTime(now, expiresAt, random) {
  // Randomize once after selection. An opportunity that expires before a suitable
  // waking window is dropped; the weekly target never forces a late post.
  let earliest = now + MIN_DELAY;
  let latest = Math.min(now + MAX_DELAY, expiresAt - 1);
  const window = momentsPublishingWindow(earliest);
  if (!window.open) {
    earliest = window.nextOpenAt;
    latest = Math.min(earliest + MAX_DELAY - MIN_DELAY, expiresAt - 1);
  }
  latest = Math.min(latest, momentsPublishingWindow(earliest).closesAt - 1);
  if (latest < earliest) return null;
  return earliest + Math.floor(sample(random) * (latest - earliest + 1));
}

function decode(row) {
  return row ? { id: row.id, accountId: row.account_id, opportunityKey: row.opportunity_key,
    sourceFingerprint: row.source_fingerprint, topicKey: row.topic_key, source: JSON.parse(row.source_json),
    state: row.state, reason: row.reason, createdAt: row.created_at, updatedAt: row.updated_at,
    expiresAt: row.expires_at, dueAt: row.due_at, generationStartedAt: row.generation_started_at,
    attemptedAt: row.attempted_at, text: row.text, imagePrompt: row.image_prompt,
    imageKind: row.image_kind, visibility: row.visibility,
    asset: row.asset_json ? JSON.parse(row.asset_json) : null,
    publicationKey: row.publication_key, publicationDigest: row.publication_digest, momentId: row.moment_id } : null;
}

/** Durable scheduling only: this module performs no model, image, or WeChat calls. */
export class MomentsPublishingSchedule {
  constructor(filename, { now = Date.now, random = Math.random, makeId = randomUUID, minDecisionGapMs = 6 * HOUR } = {}) {
    this.now = now;
    this.random = random;
    this.makeId = makeId;
    if (!Number.isSafeInteger(minDecisionGapMs) || minDecisionGapMs < 0 || minDecisionGapMs > ROLLING) {
      throw new Error('Invalid decision interval');
    }
    this.minDecisionGapMs = minDecisionGapMs;
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS moments_publishing_weeks (
        account_id TEXT NOT NULL, week_key TEXT NOT NULL, target INTEGER NOT NULL CHECK(target IN (2,3)),
        created_at INTEGER NOT NULL, PRIMARY KEY(account_id,week_key)
      );
      CREATE TABLE IF NOT EXISTS moments_publishing_jobs (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, opportunity_key TEXT NOT NULL,
        source_fingerprint TEXT NOT NULL, topic_key TEXT NOT NULL, source_json TEXT NOT NULL,
        state TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL, due_at INTEGER, generation_started_at INTEGER, attempted_at INTEGER,
        text TEXT, image_prompt TEXT, image_kind TEXT, visibility TEXT, asset_json TEXT,
        publication_key TEXT UNIQUE, publication_digest TEXT, moment_id TEXT,
        UNIQUE(account_id,opportunity_key,source_fingerprint)
      );
      CREATE INDEX IF NOT EXISTS moments_publishing_attempts ON moments_publishing_jobs(account_id,attempted_at);
      CREATE INDEX IF NOT EXISTS moments_publishing_state ON moments_publishing_jobs(account_id,state)`);
    if (!this.db.prepare('PRAGMA table_info(moments_publishing_jobs)').all().some(row => row.name === 'image_kind')) {
      this.db.exec('ALTER TABLE moments_publishing_jobs ADD COLUMN image_kind TEXT');
    }
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  get(accountId, id) {
    return decode(this.db.prepare('SELECT * FROM moments_publishing_jobs WHERE account_id=? AND id=?')
      .get(key(accountId, 'account ID'), key(id, 'job ID')));
  }
  list(accountId, { limit = 50 } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid list limit');
    return this.db.prepare('SELECT * FROM moments_publishing_jobs WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT ?')
      .all(key(accountId, 'account ID'), limit).map(decode);
  }
  _require(accountId, id, states) {
    const job = this.get(accountId, id);
    if (!job || (states && !states.includes(job.state))) throw new Error('Invalid publishing job state or account');
    return job;
  }
  _week(accountId, now) {
    const week = momentsPublishingWeek(now);
    let row = this.db.prepare('SELECT target FROM moments_publishing_weeks WHERE account_id=? AND week_key=?')
      .get(accountId, week.weekKey);
    if (!row) {
      const target = sample(this.random) < 0.5 ? 2 : 3;
      this.db.prepare('INSERT INTO moments_publishing_weeks(account_id,week_key,target,created_at) VALUES(?,?,?,?)')
        .run(accountId, week.weekKey, target, now);
      row = { target };
    }
    return { ...week, target: row.target };
  }
  _expire(accountId, now) {
    this.db.prepare(`UPDATE moments_publishing_jobs SET state='expired',reason='opportunity_expired',updated_at=?
      WHERE account_id=? AND attempted_at IS NULL AND expires_at<=?
      AND state IN ('evaluating','selected','ready','prepared')`).run(now, accountId, now);
  }
  _assess(accountId, now, ignoreId = '') {
    const week = this._week(accountId, now);
    const rows = this.db.prepare('SELECT id,state,attempted_at FROM moments_publishing_jobs WHERE account_id=? AND attempted_at IS NOT NULL')
      .all(accountId);
    const weekCount = rows.filter(row => row.attempted_at >= week.startsAt && row.attempted_at < week.endsAt).length;
    const rollingAttempts = rows.filter(row => row.attempted_at > now - ROLLING);
    const rollingCount = rollingAttempts.length;
    const lastAttemptAt = rows.length ? Math.max(...rows.map(row => row.attempted_at)) : null;
    const lastDecisionAt = this.db.prepare('SELECT MAX(created_at) AS latest FROM moments_publishing_jobs WHERE account_id=?')
      .get(accountId).latest;
    const active = this.db.prepare(`SELECT id,state FROM moments_publishing_jobs WHERE account_id=? AND id<>?
      AND state IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`).get(accountId, ignoreId, ...ACTIVE);
    const window = momentsPublishingWindow(now);
    const decisionWait = !ignoreId && lastDecisionAt !== null && now - lastDecisionAt < this.minDecisionGapMs;
    let nextAllowedAt = Math.max(now, window.nextOpenAt, lastAttemptAt === null ? 0 : lastAttemptAt + GAP,
      decisionWait ? lastDecisionAt + this.minDecisionGapMs : 0,
      weekCount >= week.target ? week.endsAt : 0,
      rollingCount >= 3 ? Math.min(...rollingAttempts.map(row => row.attempted_at)) + ROLLING : 0);
    nextAllowedAt = momentsPublishingWindow(nextAllowedAt).nextOpenAt;
    const reason = active ? 'active_job' : !window.open ? 'outside_window' :
      rollingCount >= 3 ? 'rolling_limit' : weekCount >= week.target ? 'weekly_target_reached' :
      lastAttemptAt !== null && now - lastAttemptAt < GAP ? 'minimum_gap' :
      decisionWait ? 'decision_cooldown' : 'eligible';
    return { eligible: reason === 'eligible', reason, week, weekCount, rollingCount,
      lastAttemptAt, lastDecisionAt, nextAllowedAt, activeJobId: active?.id ?? null, window };
  }
  assess(accountId) {
    key(accountId, 'account ID');
    const now = time(this.now());
    return this.transaction(() => { this._expire(accountId, now); return this._assess(accountId, now); });
  }
  consider({ accountId, opportunityKey, sourceFingerprint, topicKey, expiresAt, source }) {
    key(accountId, 'account ID'); key(opportunityKey, 'opportunity key'); key(topicKey, 'topic key');
    digest(sourceFingerprint, 'source fingerprint'); time(expiresAt, 'expiry');
    const json = sourceJson(source);
    const now = time(this.now());
    return this.transaction(() => {
      this._expire(accountId, now);
      const prior = decode(this.db.prepare(`SELECT * FROM moments_publishing_jobs
        WHERE account_id=? AND opportunity_key=? AND source_fingerprint=?`).get(accountId, opportunityKey, sourceFingerprint));
      if (prior) return { claimed: false, reason: 'already_considered', job: prior };
      if (expiresAt <= now) return { claimed: false, reason: 'opportunity_expired', job: null };
      const policy = this._assess(accountId, now);
      if (!policy.eligible) return { claimed: false, reason: policy.reason, policy, job: null };
      // topicKey identifies an event/narrative, not a broad label such as "电竞".
      const repeated = this.db.prepare(`SELECT id FROM moments_publishing_jobs
        WHERE account_id=? AND topic_key=? AND attempted_at>? LIMIT 1`).get(accountId, topicKey, now - ROLLING);
      if (repeated) return { claimed: false, reason: 'recent_topic', policy, job: null };
      const id = key(this.makeId(), 'job ID');
      this.db.prepare(`INSERT INTO moments_publishing_jobs(id,account_id,opportunity_key,source_fingerprint,
        topic_key,source_json,state,created_at,updated_at,expires_at) VALUES(?,?,?,?,?,?,'evaluating',?,?,?)`)
        .run(id, accountId, opportunityKey, sourceFingerprint, topicKey, json, now, now, expiresAt);
      return { claimed: true, reason: 'new_opportunity', policy, job: this.get(accountId, id) };
    });
  }
  decline(accountId, id, reason = 'no_suitable_content') {
    key(reason, 'decline reason');
    return this.transaction(() => {
      this._require(accountId, id, ['evaluating']);
      this.db.prepare("UPDATE moments_publishing_jobs SET state='declined',reason=?,updated_at=? WHERE id=?")
        .run(reason, time(this.now()), id);
      return this.get(accountId, id);
    });
  }
  select(accountId, id, { text: caption, imagePrompt, imageKind = 'picture', visibility = 'friends' }) {
    caption = text(caption, 'caption', 5000); imagePrompt = text(imagePrompt, 'image prompt', 8000);
    if (!['friends', 'private'].includes(visibility)) throw new Error('Invalid visibility');
    if (!['picture', 'selfie'].includes(imageKind)) throw new Error('Invalid image kind');
    return this.transaction(() => {
      const job = this._require(accountId, id, ['evaluating']);
      const now = time(this.now());
      const dueAt = dueTime(now, job.expiresAt, this.random);
      if (dueAt === null) {
        this.db.prepare("UPDATE moments_publishing_jobs SET state='expired',reason='no_suitable_window',updated_at=? WHERE id=?").run(now, id);
      } else {
        this.db.prepare(`UPDATE moments_publishing_jobs SET state='selected',text=?,image_prompt=?,image_kind=?,visibility=?,
          due_at=?,updated_at=? WHERE id=?`).run(caption, imagePrompt, imageKind, visibility, dueAt, now, id);
      }
      return this.get(accountId, id);
    });
  }
  claimGeneration(accountId, id) {
    return this.transaction(() => {
      const job = this._require(accountId, id);
      if (job.state !== 'selected') return { claimed: false, reason: 'not_selected', job };
      const now = time(this.now());
      this._expire(accountId, now);
      if (job.expiresAt <= now) return { claimed: false, reason: 'opportunity_expired', job: this.get(accountId, id) };
      this.db.prepare("UPDATE moments_publishing_jobs SET state='generating',generation_started_at=?,updated_at=? WHERE id=?")
        .run(now, now, id);
      return { claimed: true, reason: 'generation_claimed', job: this.get(accountId, id) };
    });
  }
  saveAsset(accountId, id, asset) {
    const json = JSON.stringify(validateMomentAsset(asset));
    return this.transaction(() => {
      const job = this._require(accountId, id, ['generating', 'ready']);
      if (job.asset) {
        if (JSON.stringify(job.asset) !== json) throw new Error('Image asset conflict');
        return job;
      }
      this.db.prepare("UPDATE moments_publishing_jobs SET state='ready',asset_json=?,updated_at=? WHERE id=?")
        .run(json, time(this.now()), id);
      return this.get(accountId, id);
    });
  }
  bindPublication(accountId, id, { key: publicationKey, digest: publicationDigest }) {
    key(publicationKey, 'publication key'); digest(publicationDigest, 'publication digest');
    return this.transaction(() => {
      const job = this._require(accountId, id, ['ready', 'prepared']);
      if (!job.asset) throw new Error('Image asset required');
      if (job.publicationKey && (job.publicationKey !== publicationKey || job.publicationDigest !== publicationDigest)) {
        throw new Error('Publication binding conflict');
      }
      this.db.prepare("UPDATE moments_publishing_jobs SET state='prepared',publication_key=?,publication_digest=?,updated_at=? WHERE id=?")
        .run(publicationKey, publicationDigest, time(this.now()), id);
      return this.get(accountId, id);
    });
  }
  beginDispatch(accountId, id) {
    return this.transaction(() => {
      const job = this._require(accountId, id);
      if (job.state !== 'prepared' || job.attemptedAt !== null) return { claimed: false, reason: 'not_prepared', job };
      if (!job.asset || !job.publicationKey || !job.publicationDigest) throw new Error('Asset and publication binding required');
      const now = time(this.now());
      this._expire(accountId, now);
      if (job.expiresAt <= now) return { claimed: false, reason: 'opportunity_expired', job: this.get(accountId, id) };
      if (now < job.dueAt) return { claimed: false, reason: 'not_due', job };
      const policy = this._assess(accountId, now, id);
      if (!policy.eligible) return { claimed: false, reason: policy.reason, policy, job };
      this.db.prepare("UPDATE moments_publishing_jobs SET state='dispatching',attempted_at=?,updated_at=? WHERE id=?")
        .run(now, now, id);
      return { claimed: true, reason: 'dispatch_claimed', policy, job: this.get(accountId, id) };
    });
  }
  settle(accountId, id, { state, momentId = null, reason = null }) {
    if (!OUTCOMES.has(state)) throw new Error('Invalid publication outcome');
    if (momentId !== null) key(momentId, 'moment ID');
    if (reason !== null) key(reason, 'outcome reason');
    if (['accepted', 'verified'].includes(state) && !momentId) throw new Error('Confirmed publication ID required');
    return this.transaction(() => {
      const job = this._require(accountId, id, ['dispatching', 'needs_review', 'accepted', 'verified', 'rejected']);
      if (job.attemptedAt === null) throw new Error('Publication attempt required');
      if (job.momentId && momentId !== null && job.momentId !== momentId) throw new Error('Publication ID conflict');
      if ((job.state === 'verified' || job.state === 'rejected') && state !== job.state) throw new Error('Terminal publication outcome');
      this.db.prepare('UPDATE moments_publishing_jobs SET state=?,moment_id=?,reason=?,updated_at=? WHERE id=?')
        .run(state, momentId ?? job.momentId, reason, time(this.now()), id);
      return this.get(accountId, id);
    });
  }
  failBeforeDispatch(accountId, id, reason) {
    key(reason, 'failure reason');
    return this.transaction(() => {
      this._require(accountId, id, ['evaluating', 'selected', 'generating', 'ready', 'prepared']);
      this.db.prepare("UPDATE moments_publishing_jobs SET state='failed',reason=?,updated_at=? WHERE id=?")
        .run(reason, time(this.now()), id);
      return this.get(accountId, id);
    });
  }
  /** Call only after acquiring the worker's exclusive ownership on startup.
   * Model/image calls interrupted by a crash are not paid for again automatically.
   * Publication uncertainty requires reconciliation through the publication ledger.
   */
  recoverInterrupted(accountId) {
    key(accountId, 'account ID');
    return this.transaction(() => {
      const now = time(this.now());
      this.db.prepare(`UPDATE moments_publishing_jobs SET reason=state||'_result_unknown',state='failed',updated_at=?
        WHERE account_id=? AND state IN ('evaluating','generating') AND attempted_at IS NULL`).run(now, accountId);
      this.db.prepare(`UPDATE moments_publishing_jobs SET reason='publication_result_unknown',state='needs_review',updated_at=?
        WHERE account_id=? AND state='dispatching'`).run(now, accountId);
      this._expire(accountId, now);
      return this.list(accountId, { limit: 500 });
    });
  }
}
