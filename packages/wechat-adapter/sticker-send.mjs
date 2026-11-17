import { createHash, randomUUID } from 'node:crypto';
import { ensureStickerAssetColumns, prepareStickerSend, STICKER_CONTEXTS } from './sticker-projection.mjs';

const FINAL_STATES = new Set(['sent', 'failed', 'cancelled']);
const RECEIPT_STATES = new Set(['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled']);
const stickerIdPattern = /^STK-(\d{6,})$/u;

export function stickerLabel(assetId) {
  return `STK-${String(assetId).padStart(6, '0')}`;
}

export function parseStickerId(value) {
  if (Number.isSafeInteger(value) && value > 0) return value;
  const match = stickerIdPattern.exec(String(value ?? ''));
  const assetId = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(assetId) || assetId < 1) throw new Error('Sticker ID must look like STK-000001');
  return assetId;
}

export function ensureStickerSendTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS sticker_sends (
    key TEXT PRIMARY KEY, asset_id INTEGER NOT NULL, group_id TEXT NOT NULL,
    state TEXT NOT NULL, receipt TEXT, attempted_at INTEGER NOT NULL);`);
}

export function listStickerAssets(db, { groupId = null, limit = 50 } = {}) {
  if (groupId !== null && (typeof groupId !== 'string' || !groupId)) throw new Error('Invalid sticker group');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid sticker list limit');
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sticker_assets'").get();
  if (!table) return [];
  const columns = new Set(db.prepare('PRAGMA table_info(sticker_assets)').all().map(column => column.name));
  const context = columns.has('context') ? 'a.context' : "'其他' AS context";
  const review = columns.has('review_state') ? 'a.review_state' : "'saved' AS review_state";
  const reusable = columns.has('reusable') ? 'a.reusable' : '1 AS reusable';
  const safety = columns.has('safety') ? 'a.safety' : "'safe' AS safety";
  const sendable = columns.has('review_state')
    ? "(a.send_xml IS NOT NULL AND a.review_state='saved') AS sendable"
    : '(a.send_xml IS NOT NULL) AS sendable';
  return db.prepare(`SELECT a.id,a.md5,a.bytes,a.filename,a.scene,a.visible_text,a.tone,
      ${context},${review},${reusable},${safety},${sendable}, o.group_id,
      COUNT(*) AS occurrences, MAX(o.event_time) AS last_seen_at
    FROM sticker_assets a JOIN sticker_occurrences o ON o.asset_id=a.id
    WHERE (? IS NULL OR o.group_id=?)
    GROUP BY a.id,o.group_id
    ORDER BY last_seen_at DESC,a.id DESC LIMIT ?`).all(groupId, groupId, limit)
    .map(row => ({ stickerId: stickerLabel(row.id), assetId: row.id, groupId: row.group_id,
      md5: row.md5, bytes: row.bytes, filename: row.filename, scene: row.scene,
      visibleText: row.visible_text, tone: row.tone, context: row.context,
      reviewState: row.review_state, reusable: row.reusable === 1, safety: row.safety,
      sendable: row.sendable === 1, occurrences: row.occurrences,
      lastSeenAt: row.last_seen_at }));
}

export function listStickerCandidates(db, { groupId, limit = 30 } = {}) {
  if (typeof groupId !== 'string' || !groupId) throw new Error('Invalid sticker group');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 60) throw new Error('Invalid sticker candidate limit');
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sticker_assets'").get();
  if (!table) return [];
  ensureStickerAssetColumns(db);
  return db.prepare(`SELECT a.id,a.scene,a.visible_text,a.tone,a.context,
      COUNT(o.source_id) AS occurrences, MAX(o.event_time) AS last_seen_at
    FROM sticker_assets a JOIN sticker_occurrences o ON o.asset_id=a.id
    WHERE o.group_id=? AND a.review_state='saved' AND a.send_xml IS NOT NULL
    GROUP BY a.id
    ORDER BY last_seen_at DESC,a.id DESC LIMIT ?`).all(groupId, limit)
    .map(row => ({ stickerId: stickerLabel(row.id), context: row.context, summary: row.scene,
      visibleText: row.visible_text, tone: row.tone, occurrences: row.occurrences,
      lastSeenAt: row.last_seen_at }));
}

export function listStickerReview(db, { state = 'needs_review', groupId = null, limit = 50 } = {}) {
  if (!['saved', 'needs_review', 'rejected'].includes(state)) throw new Error('Invalid sticker review state');
  if (groupId !== null && (typeof groupId !== 'string' || !groupId)) throw new Error('Invalid sticker group');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid sticker review limit');
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sticker_assets'").get();
  if (!table) return [];
  ensureStickerAssetColumns(db);
  return db.prepare(`SELECT a.id,a.md5,a.bytes,a.filename,a.scene,a.visible_text,a.tone,a.context,
      a.reusable,a.safety,a.review_state,a.review_reason,a.classified_at,
      (a.send_xml IS NOT NULL) AS has_send_xml, MAX(o.event_time) AS last_seen_at
    FROM sticker_assets a LEFT JOIN sticker_occurrences o ON o.asset_id=a.id
    WHERE a.review_state=? AND (? IS NULL OR o.group_id=?)
    GROUP BY a.id ORDER BY last_seen_at DESC,a.id DESC LIMIT ?`)
    .all(state, groupId, groupId, limit)
    .map(row => ({ stickerId: stickerLabel(row.id), assetId: row.id, md5: row.md5,
      bytes: row.bytes, filename: row.filename, scene: row.scene,
      visibleText: row.visible_text, tone: row.tone,
      context: row.context, reusable: row.reusable === 1, safety: row.safety,
      reviewState: row.review_state, reviewReason: row.review_reason,
      classifiedAt: row.classified_at, hasSendXml: row.has_send_xml === 1,
      lastSeenAt: row.last_seen_at }));
}

export function setStickerReview(db, { stickerId, reviewState = null, context = null, summary = null }) {
  if (reviewState !== null && !['saved', 'needs_review', 'rejected'].includes(reviewState)) {
    throw new Error('Invalid sticker review state');
  }
  if (context !== null && !STICKER_CONTEXTS.includes(context)) throw new Error('Invalid sticker context');
  if (summary !== null && (typeof summary !== 'string' || !summary.trim() || summary.length > 180)) {
    throw new Error('Invalid sticker summary');
  }
  const assetId = parseStickerId(stickerId);
  ensureStickerAssetColumns(db);
  const result = db.prepare(`UPDATE sticker_assets SET review_state=COALESCE(?,review_state),
    context=COALESCE(?,context),scene=COALESCE(?,scene) WHERE id=?`)
    .run(reviewState, context, summary?.trim() ?? null, assetId);
  if (result.changes !== 1) throw new Error('Sticker not found');
  const row = db.prepare(`SELECT id,scene,context,review_state,review_reason,
    (send_xml IS NOT NULL) AS has_send_xml FROM sticker_assets WHERE id=?`).get(assetId);
  return { stickerId: stickerLabel(row.id), scene: row.scene, context: row.context,
    reviewState: row.review_state, reviewReason: row.review_reason,
    hasSendXml: row.has_send_xml === 1 };
}

export function stickerSendKey(accountId, groupId, taskId, sourceId, stickerId) {
  return `sociomem-sticker-${createHash('sha256')
    .update(JSON.stringify([accountId, groupId, taskId, sourceId, stickerId])).digest('hex').slice(0, 32)}`;
}

export function stickerSendRow(db, key) {
  ensureStickerSendTable(db);
  return db.prepare('SELECT * FROM sticker_sends WHERE key=?').get(key) ?? null;
}

export function newStickerSendKey(accountId, groupId, assetId) {
  return `sociomem-sticker-${createHash('sha256')
    .update(JSON.stringify([accountId, groupId, assetId, randomUUID()])).digest('hex').slice(0, 32)}`;
}

function storedAccountId(db) {
  const meta = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='meta'").get();
  return meta ? db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value : undefined;
}

function recordStickerSend(db, { key, assetId, groupId, state, receipt = null, now = Date.now() }) {
  db.prepare(`INSERT INTO sticker_sends (key,asset_id,group_id,state,receipt,attempted_at)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET state=excluded.state,receipt=excluded.receipt`).run(
    key, assetId, groupId, state, receipt === null ? null : JSON.stringify(receipt), now);
}

function acceptStickerReceipt(receipt, { accountId, groupId }) {
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id ||
      receipt.accountId !== accountId || receipt.destination !== groupId ||
      !RECEIPT_STATES.has(receipt.state)) throw new Error('Sticker send receipt identity/state mismatch');
  return receipt;
}

function receiptState(receipt) {
  if (receipt.state === 'accepted') return 'sent';
  if (['queued', 'submitting'].includes(receipt.state)) return 'pending_receipt';
  if (['failed', 'cancelled'].includes(receipt.state)) return receipt.state;
  return 'needs_review';
}

function resultFromRow(row) {
  return { key: row.key, stickerId: stickerLabel(row.asset_id), assetId: row.asset_id,
    groupId: row.group_id, state: row.state,
    receipt: row.receipt ? JSON.parse(row.receipt) : null };
}

export async function sendSticker({ db, client, account, groupId, stickerId, key = null, signal, now = Date.now() }) {
  ensureStickerSendTable(db);
  const assetId = parseStickerId(stickerId);
  const identity = storedAccountId(db);
  if (identity && identity !== account.accountId) throw new Error('Sticker database belongs to another account');
  if (!db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='sticker_assets'").get()) {
    throw new Error('No captured stickers are available');
  }
  ensureStickerAssetColumns(db);
  const asset = db.prepare('SELECT send_xml,review_state FROM sticker_assets WHERE id=?').get(assetId);
  if (!asset) throw new Error(`Sticker ${stickerLabel(assetId)} is not captured`);
  if (!asset.send_xml) throw new Error(`Sticker ${stickerLabel(assetId)} has no verified send XML`);
  if (asset.review_state !== 'saved') throw new Error(`Sticker ${stickerLabel(assetId)} is ${asset.review_state}`);
  const sticker = prepareStickerSend({ db }, { assetId, groupId, destination: groupId,
    selfUserId: account.selfUserId });
  const attemptKey = key ?? newStickerSendKey(account.accountId, groupId, assetId);
  const existing = stickerSendRow(db, attemptKey);
  if (existing && FINAL_STATES.has(existing.state)) return resultFromRow(existing);
  if (existing) return reconcileStickerSend({ db, client, key: attemptKey, signal, now });
  recordStickerSend(db, { key: attemptKey, assetId, groupId, state: 'dispatching', now });
  try {
    const receipt = acceptStickerReceipt(await client.sendSticker(groupId, sticker, attemptKey, signal),
      { accountId: client.accountId, groupId });
    const state = receiptState(receipt);
    recordStickerSend(db, { key: attemptKey, assetId, groupId, state, receipt, now });
    return { key: attemptKey, stickerId: stickerLabel(assetId), assetId, groupId, state, receipt };
  } catch (error) {
    const reconciled = await reconcileStickerSend({ db, client, key: attemptKey, signal, now });
    return { ...reconciled, firstError: error.name };
  }
}

export async function reconcileStickerSend({ db, client, key, signal, now = Date.now() }) {
  const row = stickerSendRow(db, key);
  if (!row) throw new Error('Unknown sticker send key');
  if (FINAL_STATES.has(row.state)) return resultFromRow(row);
  let receipt = row.receipt ? JSON.parse(row.receipt) : null;
  try {
    const remote = receipt?.id
      ? await client.sendStatus(receipt.id, signal)
      : await client.sendByKey(key, signal);
    receipt = acceptStickerReceipt(remote, { accountId: client.accountId, groupId: row.group_id });
    recordStickerSend(db, { key, assetId: row.asset_id, groupId: row.group_id,
      state: receiptState(receipt), receipt, now });
    return resultFromRow(stickerSendRow(db, key));
  } catch (error) {
    recordStickerSend(db, { key, assetId: row.asset_id, groupId: row.group_id,
      state: 'needs_review', receipt, now });
    return { ...resultFromRow(stickerSendRow(db, key)), errorType: error.name };
  }
}
