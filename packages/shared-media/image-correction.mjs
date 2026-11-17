import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initializeImageDescriptionCache, readVerifiedImageDescription,
  saveImageDescription, deleteVerifiedImageDescription } from './image-description-cache.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const text = (value, limit) => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= limit && !/[\u0000-\u001f\u007f]/u.test(value);
const revoked = value => Boolean(value.recall || value.recalled || value.revoked || value.deleted ||
  value.isRecalled || value.isDeleted || ['recalled', 'revoked', 'deleted'].includes(value.state));
const instant = value => {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) throw new Error('Invalid correction time');
  return new Date(at).toISOString();
};
const tableExists = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_description_corrections'").get());

function request(input, includeSnapshots = false) {
  if (!input || !text(input.correctionId, 120) || !text(input.accountId, 200) || !sha(input.imageSha256) ||
      !text(input.expectedVisibleText, 160) || !text(input.correctedVisibleText, 160) ||
      input.expectedVisibleText === input.correctedVisibleText || !Array.isArray(input.sources) ||
      !input.sources.length || input.sources.length > 100) throw new Error('Invalid image correction request');
  const verification = input.verification;
  if (verification?.method !== 'local_image_inspection' || !text(verification.note, 500)) {
    throw new Error('An explicit local image inspection is required');
  }
  const sources = input.sources.map(source => {
    if (!source || !text(source.sourceMessageId, 2000) || !text(source.groupId, 200) ||
        !source.groupId.endsWith('@chatroom') || (includeSnapshots && !sha(source.priorMessageSha256))) {
      throw new Error('Invalid correction source scope');
    }
    return { sourceMessageId: source.sourceMessageId, groupId: source.groupId,
      ...(includeSnapshots ? { priorMessageSha256: source.priorMessageSha256 } : {}) };
  }).sort((a, b) => a.sourceMessageId.localeCompare(b.sourceMessageId));
  if (new Set(sources.map(source => source.sourceMessageId)).size !== sources.length) throw new Error('Duplicate correction source');
  return { schemaVersion: 1, correctionId: input.correctionId, accountId: input.accountId,
    imageSha256: input.imageSha256, expectedVisibleText: input.expectedVisibleText,
    correctedVisibleText: input.correctedVisibleText,
    verification: { method: verification.method, verifiedAt: instant(verification.verifiedAt), note: verification.note }, sources };
}

function openInbox(filename, readOnly) {
  if (typeof filename !== 'string' || !existsSync(filename)) throw new Error('Existing Inbox is required');
  const db = new DatabaseSync(filename, { readOnly });
  db.exec('PRAGMA busy_timeout=5000');
  return db;
}

function verifyAccount(db, accountId) {
  if (db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) throw new Error('Correction Inbox account mismatch');
}

function verifyImage(message, imageDir, expectedHash) {
  if (typeof imageDir !== 'string' || typeof message.imagePath !== 'string') throw new Error('Local image cache path required');
  const root = realpathSync(imageDir), file = realpathSync(message.imagePath);
  const within = relative(root, file);
  if (!within || isAbsolute(within) || within === '..' || within.startsWith(`..${sep}`)) throw new Error('Image path is outside the cache');
  const info = statSync(file);
  if (!info.isFile() || info.size < 12 || info.size > 16 * 1024 * 1024) throw new Error('Invalid cached image size');
  if (hash(readFileSync(file)) !== expectedHash) throw new Error('Cached image hash mismatch');
}

function sourceSnapshot(db, input, source, imageDir) {
  const row = db.prepare('SELECT message FROM inbox WHERE id=?').get(source.sourceMessageId);
  if (!row) throw new Error('Correction source unavailable');
  const message = JSON.parse(row.message);
  if (message.sourceMessageId !== source.sourceMessageId || message.accountId !== input.accountId ||
      message.groupId !== source.groupId || !text(message.userId, 200) || message.interaction !== 'image' ||
      message.imageSha256 !== input.imageSha256 || revoked(message)) throw new Error('Correction source identity mismatch or revoked');
  if (source.priorMessageSha256 && hash(row.message) !== source.priorMessageSha256) throw new Error('Correction source changed since preparation');
  if (message.imageVisibleText !== input.expectedVisibleText || typeof message.text !== 'string') throw new Error('Expected OCR text does not match');
  const segment = `；图中文字：${input.expectedVisibleText}`;
  if (message.text.split(segment).length !== 2) throw new Error('Expected OCR segment is not unique');
  verifyImage(message, imageDir, input.imageSha256);
  return { raw: row.message, message, segment };
}

function planBody(plan) {
  const value = request(plan, true);
  if (plan.schemaVersion !== 1 || !Object.hasOwn(plan, 'priorVerifiedCache')) throw new Error('Invalid correction plan');
  return { ...value, priorVerifiedCache: plan.priorVerifiedCache };
}

/** Reads only. The caller must inspect the actual image before supplying corrected text. */
export function prepareImageDescriptionCorrection({ inboxPath, imageDir, ...input }) {
  const value = request(input), db = openInbox(inboxPath, true);
  try {
    verifyAccount(db, value.accountId);
    if (tableExists(db) && db.prepare('SELECT 1 FROM image_description_corrections WHERE correction_id=?').get(value.correctionId)) {
      throw new Error('Correction ID already exists; reuse its original plan or choose a new ID');
    }
    const sources = value.sources.map(source => ({ ...source,
      priorMessageSha256: hash(sourceSnapshot(db, value, source, imageDir).raw) }));
    const body = { ...value, sources, priorVerifiedCache: readVerifiedImageDescription(db,
      { accountId: value.accountId, sha256: value.imageSha256 }) };
    return { ...body, planSha256: hash(JSON.stringify(body)) };
  } finally { db.close(); }
}

function initializeAudit(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS image_description_corrections (
    correction_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, image_sha256 TEXT NOT NULL,
    plan_sha256 TEXT NOT NULL, plan_json TEXT NOT NULL, changes_json TEXT NOT NULL,
    cache_before_json TEXT NOT NULL, cache_after_json TEXT NOT NULL,
    state TEXT NOT NULL, applied_at TEXT NOT NULL, reverted_at TEXT);
    CREATE INDEX IF NOT EXISTS image_corrections_scope ON image_description_corrections(account_id,image_sha256)`);
}

function assertCurrentChanges(db, changes, field) {
  for (const change of changes) {
    const current = db.prepare('SELECT message FROM inbox WHERE id=?').get(change.sourceMessageId);
    if (!current || current.message !== change[field]) throw new Error('Correction source has subsequent changes');
  }
}

function currentVerified(db, value) {
  return readVerifiedImageDescription(db, { accountId: value.accountId, sha256: value.imageSha256 });
}

/** Applies exactly the reviewed plan, without model calls or network/file writes. */
export function applyImageDescriptionCorrection({ inboxPath, imageDir, plan, now = Date.now() }) {
  const body = planBody(plan), planSha256 = hash(JSON.stringify(body));
  if (planSha256 !== plan.planSha256) throw new Error('Correction plan digest mismatch');
  const appliedAt = instant(now), db = openInbox(inboxPath, false);
  try {
    db.exec('BEGIN IMMEDIATE');
    verifyAccount(db, body.accountId);
    initializeAudit(db);
    initializeImageDescriptionCache(db);
    const prior = db.prepare('SELECT * FROM image_description_corrections WHERE correction_id=?').get(body.correctionId);
    if (prior) {
      if (prior.plan_sha256 !== planSha256 || prior.account_id !== body.accountId || prior.state !== 'applied') {
        throw new Error('Correction ID conflicts with another or reverted plan');
      }
      assertCurrentChanges(db, JSON.parse(prior.changes_json), 'after');
      if (JSON.stringify(currentVerified(db, body)) !== prior.cache_after_json) throw new Error('Verified image cache has subsequent changes');
      db.exec('COMMIT');
      return { status: 'already_applied', correctionId: body.correctionId, changed: 0, planSha256 };
    }
    if (JSON.stringify(currentVerified(db, body)) !== JSON.stringify(body.priorVerifiedCache)) {
      throw new Error('Verified image cache changed since preparation');
    }
    const snapshots = body.sources.map(source => ({ source, ...sourceSnapshot(db, body, source, imageDir) }));
    const changes = snapshots.map(({ source, raw, message, segment }) => {
      const correctedText = message.text.replace(segment, `；图中文字：${body.correctedVisibleText}`);
      const correction = { id: body.correctionId, kind: 'ocr_transcription', method: body.verification.method,
        verifiedAt: body.verification.verifiedAt, appliedAt, imageSha256: body.imageSha256,
        previousMessageSha256: hash(raw), previousVisibleTextSha256: hash(body.expectedVisibleText),
        correctedVisibleTextSha256: hash(body.correctedVisibleText) };
      const after = JSON.stringify({ ...message, text: correctedText, imageVisibleText: body.correctedVisibleText,
        imageDescriptionCorrection: correction });
      return { sourceMessageId: source.sourceMessageId, groupId: source.groupId,
        before: raw, after, beforeSha256: hash(raw), afterSha256: hash(after) };
    });
    const sample = snapshots[0].message;
    saveImageDescription(db, { accountId: body.accountId, sha256: body.imageSha256, promptVersion: 'verified',
      description: { summary: sample.imageSummary ?? '', visibleText: body.correctedVisibleText,
        tone: sample.imageTone ?? '', safety: sample.imageSafety ?? 'uncertain', model: sample.imageModel ?? null },
      verification: 'local_image_inspection', correctionId: body.correctionId, describedAt: body.verification.verifiedAt });
    for (const change of changes) {
      if (db.prepare('UPDATE inbox SET message=? WHERE id=? AND message=?').run(change.after, change.sourceMessageId, change.before).changes !== 1) {
        throw new Error('Correction source compare-and-swap failed');
      }
    }
    const afterCache = currentVerified(db, body);
    db.prepare(`INSERT INTO image_description_corrections
      (correction_id,account_id,image_sha256,plan_sha256,plan_json,changes_json,cache_before_json,cache_after_json,state,applied_at)
      VALUES (?,?,?,?,?,?,?,?,'applied',?)`).run(body.correctionId, body.accountId, body.imageSha256, planSha256,
        JSON.stringify(body), JSON.stringify(changes), JSON.stringify(body.priorVerifiedCache), JSON.stringify(afterCache), appliedAt);
    db.exec('COMMIT');
    return { status: 'applied', correctionId: body.correctionId, changed: changes.length, planSha256,
      imageSha256: body.imageSha256, appliedAt };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}

/** Reverts only unchanged corrected rows, retaining the audit record and later work. */
export function revertImageDescriptionCorrection({ inboxPath, accountId, correctionId, now = Date.now() }) {
  if (!text(accountId, 200) || !text(correctionId, 120)) throw new Error('Invalid correction rollback scope');
  const revertedAt = instant(now), db = openInbox(inboxPath, false);
  try {
    db.exec('BEGIN IMMEDIATE');
    verifyAccount(db, accountId);
    const row = tableExists(db) && db.prepare('SELECT * FROM image_description_corrections WHERE correction_id=? AND account_id=?').get(correctionId, accountId);
    if (!row) throw new Error('Correction audit not found');
    if (row.state === 'reverted') {
      db.exec('COMMIT');
      return { status: 'already_reverted', correctionId, changed: 0 };
    }
    if (row.state !== 'applied') throw new Error('Correction is not applied');
    const changes = JSON.parse(row.changes_json), plan = JSON.parse(row.plan_json);
    assertCurrentChanges(db, changes, 'after');
    if (JSON.stringify(currentVerified(db, plan)) !== row.cache_after_json) throw new Error('Verified image cache has subsequent changes');
    if (deleteVerifiedImageDescription(db, { accountId, sha256: row.image_sha256, correctionId }) !== 1) {
      throw new Error('Verified image cache rollback conflict');
    }
    const oldCache = JSON.parse(row.cache_before_json);
    if (oldCache) saveImageDescription(db, { accountId, sha256: row.image_sha256, ...oldCache });
    for (const change of changes) {
      if (db.prepare('UPDATE inbox SET message=? WHERE id=? AND message=?').run(change.before, change.sourceMessageId, change.after).changes !== 1) {
        throw new Error('Correction rollback compare-and-swap failed');
      }
    }
    db.prepare("UPDATE image_description_corrections SET state='reverted',reverted_at=? WHERE correction_id=? AND state='applied'")
      .run(revertedAt, correctionId);
    db.exec('COMMIT');
    return { status: 'reverted', correctionId, changed: changes.length, revertedAt };
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  } finally { db.close(); }
}
