import { createHash } from 'node:crypto';

const TABLE = 'image_description_cache';
const VERIFIED = 'verified';
const inFlight = new WeakMap();
const hash = value => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const identity = value => text(value, 200) && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) &&
  /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value);
const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').trim().slice(0, max) : '';
const hasTable = db => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(TABLE));

function scope({ accountId, sha256 }) {
  if (!identity(accountId) || !digest(sha256)) throw new Error('Invalid image description cache scope');
}

function validDescription(value) {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['summary', 'visibleText', 'tone', 'safety', 'model'].includes(key)) &&
    text(value.summary, 240) && text(value.visibleText, 160) && text(value.tone, 120) &&
    ['safe', 'uncertain', 'unsafe'].includes(value.safety) &&
    (value.model === null || text(value.model, 160));
}

function publicEntry(row) {
  if (!row) return null;
  let description;
  try { description = JSON.parse(row.description_json); } catch { return null; }
  const verified = row.verification === 'local_image_inspection';
  if (!validDescription(description) || !instant(row.described_at) ||
      (verified ? row.prompt_version !== VERIFIED || !identity(row.correction_id)
        : row.verification !== 'model' || !digest(row.prompt_version) || row.correction_id !== null)) return null;
  // Only content fields enter a consumer; never transport arbitrary stored keys.
  return { description: { summary: description.summary, visibleText: description.visibleText,
    tone: description.tone, safety: description.safety, model: description.model },
  verification: row.verification, correctionId: row.correction_id,
  describedAt: row.described_at, promptVersion: row.prompt_version };
}

/** Explicit schema creation: read helpers remain usable on a read-only old Inbox. */
export function initializeImageDescriptionCache(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
    account_id TEXT NOT NULL, sha256 TEXT NOT NULL, prompt_version TEXT NOT NULL,
    description_json TEXT NOT NULL, verification TEXT NOT NULL,
    correction_id TEXT, described_at TEXT NOT NULL,
    PRIMARY KEY(account_id,sha256,prompt_version),
    CHECK ((verification='model' AND prompt_version<>'verified' AND correction_id IS NULL) OR
      (verification='local_image_inspection' AND prompt_version='verified' AND correction_id IS NOT NULL)))`);
}

export function imageDescriptionPromptVersion(prompt) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 20000) throw new Error('Invalid image description prompt');
  return hash(prompt);
}

export function readVerifiedImageDescription(db, input) {
  scope(input);
  if (!hasTable(db)) return null;
  return publicEntry(db.prepare(`SELECT description_json,verification,correction_id,described_at,prompt_version
    FROM ${TABLE} WHERE account_id=? AND sha256=? AND prompt_version=?`)
    .get(input.accountId, input.sha256, VERIFIED));
}

export function readImageDescription(db, input) {
  scope(input);
  if (!digest(input.promptVersion)) throw new Error('Invalid image description prompt version');
  const verified = readVerifiedImageDescription(db, input);
  if (verified || !hasTable(db)) return verified;
  return publicEntry(db.prepare(`SELECT description_json,verification,correction_id,described_at,prompt_version
    FROM ${TABLE} WHERE account_id=? AND sha256=? AND prompt_version=?`)
    .get(input.accountId, input.sha256, input.promptVersion));
}

/** Callers may wrap this and Inbox updates in one transaction. No nested transaction. */
export function saveImageDescription(db, { accountId, sha256, promptVersion, description,
  verification = 'model', correctionId = null, describedAt = new Date().toISOString() }) {
  scope({ accountId, sha256 });
  if (!validDescription(description) || !instant(describedAt)) throw new Error('Invalid cached image description');
  if (verification === 'local_image_inspection') {
    if (!identity(correctionId) || (promptVersion !== undefined && promptVersion !== VERIFIED)) {
      throw new Error('Verified image description requires a correction ID and verified version');
    }
    promptVersion = VERIFIED;
  } else if (verification !== 'model' || correctionId !== null || !digest(promptVersion)) {
    throw new Error('Invalid model image description cache provenance');
  }
  db.prepare(`INSERT INTO ${TABLE}
    (account_id,sha256,prompt_version,description_json,verification,correction_id,described_at)
    VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,sha256,prompt_version) DO UPDATE SET
    description_json=excluded.description_json, verification=excluded.verification,
    correction_id=excluded.correction_id, described_at=excluded.described_at`)
    .run(accountId, sha256, promptVersion, JSON.stringify(description), verification, correctionId, describedAt);
  return publicEntry({ description_json: JSON.stringify(description), verification,
    correction_id: correctionId, described_at: describedAt, prompt_version: promptVersion });
}

export function deleteVerifiedImageDescription(db, { accountId, sha256, correctionId }) {
  scope({ accountId, sha256 });
  if (!identity(correctionId)) throw new Error('Image correction ID required');
  if (!hasTable(db)) return 0;
  return db.prepare(`DELETE FROM ${TABLE} WHERE account_id=? AND sha256=?
    AND prompt_version=? AND verification='local_image_inspection' AND correction_id=?`)
    .run(accountId, sha256, VERIFIED, correctionId).changes;
}

function describedResult(sha256, entry, cacheHit) {
  return { sha256, ...entry, cacheHit,
    imageDescriptionProvenance: { verification: entry.verification,
      correctionId: entry.correctionId, describedAt: entry.describedAt,
      promptVersion: entry.promptVersion, cacheHit, imageSha256: sha256,
      visibleTextSha256: hash(entry.description.visibleText) } };
}

/** Actual bytes determine identity before vision; cached descriptions contain no message or group identity. */
export async function describeImageWithCache({ db, accountId, bytes, prompt, vision }) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error('Invalid image bytes');
  const sha256 = hash(bytes), promptVersion = imageDescriptionPromptVersion(prompt);
  const cached = readImageDescription(db, { accountId, sha256, promptVersion });
  if (cached) return describedResult(sha256, cached, true);
  if (typeof vision !== 'function') throw new Error('Vision unavailable');
  let pending = inFlight.get(db);
  if (!pending) { pending = new Map(); inFlight.set(db, pending); }
  const operationKey = JSON.stringify([accountId, sha256, promptVersion]);
  if (pending.has(operationKey)) return pending.get(operationKey);
  const operation = (async () => {
    const raw = await vision({ bytes, prompt });
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid image vision response');
    const description = { summary: clean(raw?.summary ?? raw?.scene, 240),
      visibleText: clean(raw?.visibleText, 160), tone: clean(raw?.tone, 120),
      safety: ['safe', 'uncertain', 'unsafe'].includes(raw?.safety) ? raw.safety : 'safe',
      model: typeof raw?.model === 'string' ? clean(raw.model, 160) : null };
    if (!description.summary && !description.visibleText) throw new Error('Empty image vision description');
    // Corrections or another cache writer may arrive while vision is working.
    // The content already committed wins, including for this enriched message.
    const committed = readImageDescription(db, { accountId, sha256, promptVersion });
    if (committed) return describedResult(sha256, committed, true);
    const saved = saveImageDescription(db, { accountId, sha256, promptVersion, description });
    return describedResult(sha256, saved, false);
  })();
  pending.set(operationKey, operation);
  try { return await operation; }
  finally { if (pending.get(operationKey) === operation) pending.delete(operationKey); }
}
