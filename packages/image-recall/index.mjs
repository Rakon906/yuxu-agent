import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync, statSync, readFileSync } from 'node:fs';
import { relative, isAbsolute, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const hash = value => createHash('sha256').update(value).digest('hex');
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f]/u.test(value);
const revoked = value => Boolean(value?.recall || value?.recalled || value?.revoked || value?.deleted || value?.isRecalled || value?.isDeleted || ['recalled', 'revoked', 'deleted'].includes(value?.state));
const LIMIT = 16 * 1024 * 1024;
const memberKey = value => `M_${createHash('sha256').update(value).digest('base64url').slice(0, 12)}`;
export const imageRecallId = (accountId, groupId, sha256) => `IMG_${hash(JSON.stringify([accountId, groupId, sha256])).slice(0, 24)}`;

function date(value, end = false) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error('Invalid image date');
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const at = Date.parse(`${value}T00:00:00+08:00`);
    if (!Number.isFinite(at) || new Date(at + 28800000).toISOString().slice(0, 10) !== value) throw new Error('Invalid image date');
    return at + (end ? 86400000 : 0);
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Image date requires timezone');
  return Date.parse(value);
}
export function validateImageSearchRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some(k => !['name', 'query', 'senderId', 'from', 'to', 'limit', 'beforeRowid', 'imageId'].includes(k)) ||
      (request.name != null && request.name !== 'image_search')) throw new Error('Image search scope is host-bound');
  const query = request.query ?? '', senderId = request.senderId ?? null, imageId = request.imageId ?? null;
  if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f]/u.test(query) || (senderId !== null && !id(senderId)) ||
      (imageId !== null && !/^IMG_[a-f0-9]{24}$/u.test(imageId))) throw new Error('Invalid image search');
  const from = date(request.from), to = date(request.to, true), limit = request.limit ?? 8, beforeRowid = request.beforeRowid ?? null;
  if ((from !== null && to !== null && from >= to) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
      (beforeRowid !== null && (!Number.isSafeInteger(beforeRowid) || beforeRowid < 1))) throw new Error('Invalid image search bounds');
  if (!query.trim() && !senderId && from === null && to === null && !imageId) throw new Error('Image search needs a description, sender, date or image ID');
  return { name: 'image_search', query: query.trim(), senderId, imageId, from: request.from ?? null, to: request.to ?? null, limit, beforeRowid };
}
function scope(db, accountId, groupId) {
  if (!db || !id(accountId) || !id(groupId) || !groupId.endsWith('@chatroom') || db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) throw new Error('Image Inbox scope mismatch');
}
function source(db, accountId, groupId, sourceId) {
  const row = db.prepare('SELECT message FROM inbox WHERE id=?').get(sourceId);
  const item = row ? JSON.parse(row.message) : null;
  if (!item || item.sourceMessageId !== sourceId || item.accountId !== accountId || item.groupId !== groupId || !id(item.userId) || revoked(item)) throw new Error('Image source unavailable or scope changed');
  return item;
}
function imageSource(db, accountId, groupId, sourceId) {
  const item = source(db, accountId, groupId, sourceId);
  if (item.interaction !== 'image' || !/^[a-f0-9]{64}$/u.test(item.imageSha256 ?? '') || item.imageSafety !== 'safe' || !Number.isFinite(Date.parse(item.eventTime ?? item.recordedAt))) throw new Error('Image is not an eligible recorded original');
  return item;
}
function search(db, { accountId, groupId, request }) {
  scope(db, accountId, groupId);
  const input = validateImageSearchRequest(request), from = date(input.from), to = date(input.to, true);
  const clauses = ["json_extract(message,'$.accountId')=?", "json_extract(message,'$.groupId')=?", "json_extract(message,'$.interaction')='image'"];
  const values = [accountId, groupId];
  if (input.beforeRowid !== null) { clauses.push('rowid<?'); values.push(input.beforeRowid); }
  if (from !== null) { clauses.push("julianday(COALESCE(json_extract(message,'$.eventTime'),json_extract(message,'$.recordedAt'))) >= julianday(?)"); values.push(new Date(from).toISOString()); }
  if (to !== null) { clauses.push("julianday(COALESCE(json_extract(message,'$.eventTime'),json_extract(message,'$.recordedAt'))) < julianday(?)"); values.push(new Date(to).toISOString()); }
  const rows = db.prepare(`SELECT rowid,id,message FROM inbox WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT 5001`).all(...values);
  const images = [], seen = new Set(); let scanned = 0;
  for (const row of rows.slice(0, 5000)) {
    scanned++;
    let item; try { item = imageSource(db, accountId, groupId, row.id); } catch { continue; }
    if (input.senderId && ![item.userId, memberKey(item.userId)].includes(input.senderId)) continue;
    const imageId = imageRecallId(accountId, groupId, item.imageSha256);
    if (input.imageId && input.imageId !== imageId) continue;
    const description = [item.imageSummary, item.imageVisibleText, item.imageTone].filter(x => typeof x === 'string').join('；');
    const normalized = description.normalize('NFKC').toLowerCase();
    if (input.query && !input.query.normalize('NFKC').toLowerCase().split(/\s+/u).every(word => normalized.includes(word))) continue;
    if (seen.has(imageId)) continue;
    seen.add(imageId);
    images.push({ imageId, sourceMessageId: row.id, senderId: item.userId, at: item.eventTime ?? item.recordedAt,
      summary: String(item.imageSummary ?? '').slice(0, 240), visibleText: String(item.imageVisibleText ?? '').slice(0, 160) });
    // Fetch one extra distinct match so limit=1 cannot disguise ambiguity.
    if (images.length > input.limit) break;
  }
  const truncated = scanned < rows.length || images.length > input.limit;
  return { name: 'image_search', images: images.slice(0, input.limit), ambiguous: images.length > 1 || truncated,
    coverage: { scanned, scanLimit: 5000, truncated, nextBeforeRowid: truncated ? rows[scanned - 1]?.rowid ?? null : null,
      fromInclusive: from === null ? null : new Date(from).toISOString(), toExclusive: to === null ? null : new Date(to).toISOString(),
      timezone: 'Asia/Shanghai', recalls: 'locally_known', originalsOnly: true } };
}
/** Existing image descriptions only. No model call, cache mutation or private path in results. */
export function searchImages(inboxPath, options) {
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try { return search(db, options); } finally { db.close(); }
}
export function explicitImageRecallRequest(text) {
  if (typeof text !== 'string' || text.length > 2000 || /(?:别|不要|不用|不许|禁止|不想|不需要).{0,8}(?:发|找|翻|传|重发)|(?:生成|画一|画张|做一张)/u.test(text)) return false;
  return /(?:找|翻|重发|再发|发|传|给|要|求|哪|再来).{0,50}(?:图片|照片|原图|那张图|这张图|火锅图|张.{0,10}图|IMG_[a-f0-9]{24})|(?:图片|照片|原图|那张图|这张图|.{0,10}图).{0,25}(?:在哪|呢|找|重发|再发|发来|发一下|发下|给我)/u.test(text);
}
export function inspectOriginalImage(bytes) {
  bytes = Buffer.from(bytes);
  if (bytes.length < 12 || bytes.length > LIMIT) throw new Error('Image byte limit exceeded');
  let mime, extension;
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) { mime = 'image/png'; extension = 'png'; }
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) { mime = 'image/jpeg'; extension = 'jpg'; }
  else if (/^GIF8[79]a$/u.test(bytes.toString('ascii', 0, 6))) { mime = 'image/gif'; extension = 'gif'; }
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') { mime = 'image/webp'; extension = 'webp'; }
  else throw new Error('Unsupported original image bytes');
  return { sha256: hash(bytes), byteLength: bytes.length, mime, extension };
}
function cachedBytes(item, imageDir) {
  if (!id(item.imagePath)) return null;
  const root = resolve(imageDir), path = resolve(item.imagePath), rel = relative(root, path);
  if (!rel || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) throw new Error('Image path outside cache root');
  if (!existsSync(path)) return null;
  const realRoot = realpathSync(root), real = realpathSync(path), realRel = relative(realRoot, real);
  if (!realRel || realRel.startsWith(`..${sep}`) || realRel === '..' || isAbsolute(realRel)) throw new Error('Image symlink outside cache root');
  const stat = statSync(real);
  if (!stat.isFile() || stat.size > LIMIT || stat.size < 12) throw new Error('Invalid original image file');
  const bytes = readFileSync(real), info = inspectOriginalImage(bytes);
  if (info.sha256 !== item.imageSha256 || info.byteLength !== stat.size) throw new Error('Original image integrity mismatch');
  return bytes;
}
async function nativeSource(client, item, signal) {
  const value = await client.message(item.sourceMessageId, signal);
  if (!value || value.id !== item.sourceMessageId || value.accountId !== item.accountId || value.threadId !== item.groupId ||
      value.senderId !== item.userId || value.type !== 3 || value.direction !== 'incoming' || revoked(value) ||
      (item.serverId != null && value.serverId !== item.serverId)) throw new Error('Native original image identity changed');
}
async function downloadOriginal(client, item, signal) {
  let response = await client.messageMedia(item.sourceMessageId, signal);
  const select = result => (result?.items ?? []).filter(asset => asset.kind === 'image' && asset.variant !== 'thumbnail' &&
    asset.accountId === item.accountId && asset.messageId === item.sourceMessageId && id(asset.id) &&
    (asset.byteLength ?? asset.advertisedByteLength ?? 0) <= LIMIT);
  let assets = select(response), chosen = assets.find(x => x.state === 'available' && x.sha256 === item.imageSha256);
  if (!chosen) {
    const candidate = assets.find(x => x.variant === 'original') ?? assets.find(x => x.variant === 'normal');
    const job = await client.request(`/messages/${encodeURIComponent(item.sourceMessageId)}/media-transfers`, {
      method: 'POST', body: { messageId: item.sourceMessageId, assetId: candidate?.id ?? null,
        quality: candidate?.variant ?? 'best' }, signal });
    if (!id(job?.id) || job.accountId !== item.accountId || (job.threadId != null && job.threadId !== item.groupId)) throw new Error('Image download scope mismatch');
    for (let n = 0; n < 8; n++) {
      const state = await client.request(`/jobs/${encodeURIComponent(job.id)}`, { signal });
      if (state?.id !== job.id || state.accountId !== item.accountId || (state.threadId != null && state.threadId !== item.groupId) || ['failed', 'cancelled', 'needs_review'].includes(state.state)) throw new Error('Image download unavailable');
      assets = select(await client.messageMedia(item.sourceMessageId, signal));
      chosen = assets.find(x => x.state === 'available' && x.id === state.assetId && x.sha256 === item.imageSha256);
      if (chosen) break;
      if (n < 7) await delay(500, undefined, { signal });
    }
  }
  if (!chosen) throw new Error('Original image is unavailable; no substitute allowed');
  const { bytes } = await client.requestBytes(`/media/${encodeURIComponent(chosen.id)}/content`, { signal, limit: LIMIT, accept: 'image/*,application/octet-stream' });
  const info = inspectOriginalImage(bytes);
  if (info.sha256 !== item.imageSha256 || info.sha256 !== chosen.sha256 || (chosen.byteLength != null && info.byteLength !== chosen.byteLength)) throw new Error('Downloaded image integrity mismatch');
  return bytes;
}
export function createImageRecallTransport({ client, fetchImpl = fetch }) {
  return {
    async upload(bytes, signal) {
      const info = inspectOriginalImage(bytes), body = new FormData();
      body.append('file', new Blob([bytes], { type: info.mime }), `${info.sha256}.${info.extension}`);
      const result = await fetchImpl(`${client.origin}/v1/accounts/${encodeURIComponent(client.accountId)}/uploads`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${client.token}`, Accept: 'application/json' }, body,
        signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]) });
      if (!result.ok) throw new Error('Image upload failed');
      const text = await result.text();
      if (Buffer.byteLength(text) > 16384) throw new Error('Image upload response too large');
      const value = JSON.parse(text);
      if (!id(value.id) || value.sha256 !== info.sha256 || value.byteLength !== info.byteLength) throw new Error('Image upload integrity mismatch');
      return value;
    },
    submit: (groupId, sourceId, key, signal) => client.request('/sends', { method: 'POST', body: { kind: 'image', threadId: groupId, sourceId }, key, signal }),
    status: (jobId, signal) => client.request(`/jobs/${encodeURIComponent(jobId)}`, { signal }),
    byKey: (key, signal) => client.sendByKey(key, signal),
  };
}
function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS image_recall_searches (
    task_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, requester_id TEXT NOT NULL, request_id TEXT NOT NULL,
    candidates_json TEXT NOT NULL, ambiguous INTEGER NOT NULL, created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS image_recall_sends (
    key TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE, group_id TEXT NOT NULL, requester_id TEXT NOT NULL,
    request_id TEXT NOT NULL, image_id TEXT NOT NULL, source_id TEXT NOT NULL, source_sender_id TEXT NOT NULL,
    sha256 TEXT NOT NULL, byte_length INTEGER, state TEXT NOT NULL, upload_id TEXT, job_id TEXT, receipt TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
}
function receiptState(job, row, accountId) {
  if (!job || !id(job.id) || job.accountId !== accountId || job.threadId !== row.group_id || job.kind !== 'send' ||
      job.sourceId !== row.upload_id || (row.job_id && job.id !== row.job_id)) throw new Error('Image send receipt identity mismatch');
  const receipt = job.result?.nativeReceipt;
  if (job.phase === 'completed' && job.state === 'accepted' && receipt?.status === 'server_accepted' && receipt.serviceCode === 0 &&
      typeof receipt.serverMessageId === 'string' && /^[1-9]\d*$/u.test(receipt.serverMessageId) && job.serverMessageId === receipt.serverMessageId && receipt.clientIdMatches === true) return 'sent';
  if (job.phase === 'completed' && job.state === 'failed' && receipt?.status === 'rejected') return 'failed';
  if (job.state === 'cancelled' && !receipt) return 'cancelled';
  return 'needs_review';
}

/** Host-bound service: the model only gets IDs from this task's most recent search. */
export function createImageRecallService({ ledger, adapter, client, imageDir, inboxPath = null, sourceDb = null,
  transport = createImageRecallTransport({ client }) }) {
  const db = ledger?.db, accountId = client?.accountId;
  if (!ledger?.store || ledger.store !== adapter?.store || ledger.store.accountId !== accountId || typeof imageDir !== 'string') throw new Error('Image recall service scope mismatch');
  if (inboxPath !== null && sourceDb !== null) throw new Error('Choose one image Inbox connection');
  const inbox = sourceDb ?? (inboxPath === null ? db : new DatabaseSync(inboxPath, { readOnly: true }));
  const ownsInbox = inboxPath !== null;
  scope(db, accountId, [...adapter.allowed][0]);
  try { scope(inbox, accountId, [...adapter.allowed][0]); }
  catch (error) { if (ownsInbox) inbox.close(); throw error; }
  ensure(db);
  function taskScope(task, target, groupId) {
    const sourceIds = task ? JSON.parse(task.source_ids_json) : null;
    if (!task || task.group_id !== groupId || !adapter.allowed.has(groupId) || !id(task.source_id) || target?.senderId !== task.sender_id ||
        !Array.isArray(sourceIds) || sourceIds.length < 1 || sourceIds.length > 10 || !sourceIds.includes(target.id)) throw new Error('Image recall task mismatch');
    const messages = sourceIds.map(sourceId => source(inbox, accountId, groupId, sourceId));
    if (messages.some(message => message.userId !== target.senderId)) throw new Error('Image request sender changed');
    // Participation combines consecutive messages from the same person. The first may just
    // be "肥鱼"; inspect all original outer messages, never image/card descriptions or quotes.
    const text = messages.filter(message => message.interaction === 'text' ||
      (message.interaction === 'voice' && message.voiceState === 'done')).map(message => message.text).join('\n');
    if (!explicitImageRecallRequest(text)) throw new Error('No explicit original-image request');
    return { ...messages.find(message => message.sourceMessageId === target.id), text };
  }
  const get = key => db.prepare('SELECT * FROM image_recall_sends WHERE key=?').get(key);
  const result = row => ({ key: row.key, imageId: row.image_id, state: row.state,
    status: row.state === 'sent' ? 'sent' : ['not_sent', 'failed', 'cancelled'].includes(row.state) ? 'not_sent' : 'needs_review',
    outboxKey: row.key, safeToFallback: row.state === 'not_sent', jobId: row.job_id,
    receipt: row.receipt ? JSON.parse(row.receipt) : null });
  function outcome(row, reserve = false) {
    return ledger.store.transaction(() => {
      if (reserve) {
        const last = db.prepare('SELECT MAX(attempted_at) at FROM outbox WHERE group_id=? AND key<>?').get(row.group_id, row.key)?.at;
        if (!adapter.sendingEnabled || !adapter.allowed.has(row.group_id) || (last != null && Date.now() - last < adapter.cooldownMs) || ledger.store.sendRecord(row.key)) {
          throw new Error('Image cooldown or outbox changed before dispatch');
        }
        row = { ...row, state: 'dispatching' };
        db.prepare("UPDATE image_recall_sends SET state='dispatching',updated_at=? WHERE key=?").run(Date.now(), row.key);
      }
      const accepted = row.state === 'sent', state = accepted ? 'accepted' : 'needs_review';
      const receipt = { channel: 'image_recall', imageId: row.image_id, sourceMessageId: row.source_id,
        sha256: row.sha256, id: row.job_id, accountId, destination: row.group_id, state,
        job: row.receipt ? JSON.parse(row.receipt) : null };
      db.prepare(`INSERT INTO outbox(key,group_id,text,state,receipt,approved,attempted_at,mentions_json)
        VALUES (?,?,?,?,?,1,?,'[]') ON CONFLICT(key) DO UPDATE SET state=excluded.state,receipt=excluded.receipt`)
        .run(row.key, row.group_id, `[重发历史图片 ${row.image_id}]`, state, JSON.stringify(receipt), row.created_at);
      const taskState = accepted ? 'sent' : 'needs_review';
      db.prepare(`UPDATE participation_tasks SET state=?,reason=?,outbox_key=? WHERE source_id=? AND group_id=? AND state IN ('pending','pending_receipt','needs_review')`)
        .run(taskState, `image_recall_${row.state}`, row.key, row.task_id, row.group_id);
      db.prepare('UPDATE participation_messages SET state=?,reason=?,outbox_key=? WHERE task_id=? AND group_id=?')
        .run(taskState, `image_recall_${row.state}`, row.key, row.task_id, row.group_id);
      if (accepted) ledger.settleTask(row.task_id, 'resolved', Date.now());
      ledger.store.trace('participation.image_recall_receipt', { sourceId: row.task_id, state: row.state, outboxKey: row.key, imageId: row.image_id });
      return result(row);
    });
  }
  async function reconcileRow(row, signal) {
    if (['sent', 'failed', 'cancelled', 'not_sent'].includes(row.state)) return result(row);
    if (!row.upload_id || !['dispatching', 'needs_review'].includes(row.state)) return { ...result(row), safeToFallback: false };
    try {
      const job = row.job_id ? await transport.status(row.job_id, signal) : await transport.byKey(row.key, signal);
      db.prepare('UPDATE image_recall_sends SET state=?,job_id=?,receipt=?,updated_at=? WHERE key=?')
        .run(receiptState(job, row, accountId), job.id, JSON.stringify(job), Date.now(), row.key);
    } catch { db.prepare("UPDATE image_recall_sends SET state='needs_review',updated_at=? WHERE key=?").run(Date.now(), row.key); }
    return outcome(get(row.key));
  }
  return {
    close() { if (ownsInbox) inbox.close(); },
    search({ task, target, groupId = task?.group_id, request, now = Date.now() }) {
      const originalRequest = taskScope(task, target, groupId);
      if (request?.imageId && !originalRequest.text.includes(request.imageId)) throw new Error('An image ID must be chosen explicitly by the requester');
      const found = search(inbox, { accountId, groupId, request });
      db.prepare(`INSERT INTO image_recall_searches VALUES (?,?,?,?,?,?,?) ON CONFLICT(task_id) DO UPDATE SET
        candidates_json=excluded.candidates_json,ambiguous=excluded.ambiguous,created_at=excluded.created_at`)
        .run(task.source_id, groupId, target.senderId, target.id, JSON.stringify(found.images), found.ambiguous ? 1 : 0, now);
      return found;
    },
    async send({ task, target, groupId = task?.group_id, imageId, key, authorize = async () => false, signal, now = Date.now() }) {
      scope(db, accountId, groupId); taskScope(task, target, groupId);
      if (!id(key) || !/^IMG_[a-f0-9]{24}$/u.test(imageId ?? '')) throw new Error('Invalid image send identity');
      const old = db.prepare('SELECT * FROM image_recall_sends WHERE task_id=? OR key=?').all(task.source_id, key);
      if (old.length) {
        if (old.length !== 1 || old[0].key !== key || old[0].task_id !== task.source_id || old[0].group_id !== groupId ||
            old[0].request_id !== target.id || old[0].requester_id !== target.senderId || old[0].image_id !== imageId) throw new Error('Image attempt conflict');
        return ['dispatching', 'needs_review'].includes(old[0].state) ? reconcileRow(old[0], signal) : result(old[0]);
      }
      const found = db.prepare('SELECT * FROM image_recall_searches WHERE task_id=?').get(task.source_id);
      if (!found || found.group_id !== groupId || found.requester_id !== target.senderId || found.request_id !== target.id ||
          found.ambiguous || now - found.created_at > 120000 || now < found.created_at) return { state: 'not_sent', status: 'not_sent', reason: 'image_choice_requires_fresh_unique_search', safeToFallback: true };
      const candidates = JSON.parse(found.candidates_json), candidate = candidates.find(x => x.imageId === imageId);
      if (candidates.length !== 1 || !candidate) return { state: 'not_sent', status: 'not_sent', reason: 'image_not_in_unique_candidates', safeToFallback: true };
      const original = imageSource(inbox, accountId, groupId, candidate.sourceMessageId);
      if (candidate.senderId !== original.userId || imageRecallId(accountId, groupId, original.imageSha256) !== imageId) throw new Error('Selected original changed');
      if (ledger.store.sendRecord(key)) throw new Error('Task already has another outbound message');
      db.prepare(`INSERT INTO image_recall_sends(key,task_id,group_id,requester_id,request_id,image_id,source_id,source_sender_id,sha256,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,'preparing',?,?)`).run(key, task.source_id, groupId, target.senderId, target.id, imageId, original.sourceMessageId, original.userId, original.imageSha256, now, now);
      let dispatching = false;
      try {
        const guard = async () => {
          taskScope(task, target, groupId);
          const current = imageSource(inbox, accountId, groupId, original.sourceMessageId);
          if (current.userId !== original.userId || current.imageSha256 !== original.imageSha256) return false;
          const last = db.prepare('SELECT MAX(attempted_at) at FROM outbox WHERE group_id=? AND key<>?').get(groupId, key)?.at;
          return adapter.sendingEnabled && adapter.allowed.has(groupId) && (last == null || Date.now() - last >= adapter.cooldownMs) && await authorize();
        };
        if (!await guard()) throw new Error('Image send no longer authorized');
        await nativeSource(client, original, signal);
        const bytes = cachedBytes(original, imageDir) ?? await downloadOriginal(client, original, signal), info = inspectOriginalImage(bytes);
        const uploaded = await transport.upload(bytes, signal);
        if (!id(uploaded?.id) || uploaded.sha256 !== original.imageSha256 || uploaded.byteLength !== info.byteLength) throw new Error('Image upload integrity mismatch');
        db.prepare('UPDATE image_recall_sends SET upload_id=?,byte_length=?,updated_at=? WHERE key=?').run(uploaded.id, info.byteLength, Date.now(), key);
        await nativeSource(client, original, signal);
        if (!await guard()) throw new Error('Image send no longer authorized');
        // Reserve cooldown and terminal task state in the same durable transaction BEFORE POST.
        // A process death must not leave a pending task eligible for ordinary text/image replay.
        outcome(get(key), true);
        dispatching = true;
        // Once POST may have occurred, all uncertain results are read-only reconciliation.
        const job = await transport.submit(groupId, uploaded.id, key, signal), row = get(key);
        db.prepare('UPDATE image_recall_sends SET state=?,job_id=?,receipt=?,updated_at=? WHERE key=?')
          .run(receiptState(job, row, accountId), job.id, JSON.stringify(job), Date.now(), key);
        return outcome(get(key));
      } catch {
        db.prepare('UPDATE image_recall_sends SET state=?,updated_at=? WHERE key=?').run(dispatching ? 'needs_review' : 'not_sent', Date.now(), key);
        return dispatching ? outcome(get(key)) : { ...result(get(key)), outboxKey: null };
      }
    },
    async reconcile({ groupId, signal, limit = 10 }) {
      scope(db, accountId, groupId);
      if (!adapter.allowed.has(groupId) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid image reconciliation scope');
      const rows = db.prepare("SELECT * FROM image_recall_sends WHERE group_id=? AND state IN ('dispatching','needs_review') ORDER BY updated_at LIMIT ?").all(groupId, limit);
      const results = []; for (const row of rows) results.push(await reconcileRow(row, signal)); return results;
    },
  };
}
