import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readInbox, searchDiary } from '../diary/index.mjs';
import { searchMemories } from '../memory/index.mjs';
import { validateImageSearchRequest } from '../image-recall/index.mjs';

const allowed = new Set(['recent_messages', 'history_search', 'memory_search', 'diary_search']);
const SCAN_LIMIT = 5000;
const keyOf = senderId => `M_${createHash('sha256').update(senderId).digest('base64url').slice(0, 12)}`;

function instant(value, end = false) {
  if (typeof value !== 'string') throw new Error('History dates must be strings');
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const at = Date.parse(`${value}T00:00:00+08:00`);
    if (!Number.isFinite(at) || new Date(at + 8 * 3600000).toISOString().slice(0, 10) !== value) {
      throw new Error('Invalid history calendar date');
    }
    return new Date(at + (end ? 86400000 : 0)).toISOString();
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) ||
      !Number.isFinite(Date.parse(value))) throw new Error('History time requires an explicit timezone');
  return new Date(Date.parse(value)).toISOString();
}

function historyRequest(request) {
  const keys = new Set(['name', 'query', 'senderId', 'from', 'to', 'beforeRowid', 'limit']);
  if (Object.keys(request).some(key => !keys.has(key))) throw new Error('History scope is host-bound');
  const query = request.query === undefined ? '' : request.query;
  if (typeof query !== 'string' || query.length > 200 || /[\u0000-\u001f]/u.test(query)) throw new Error('Invalid history query');
  const senderId = request.senderId ?? null;
  if (senderId !== null && (typeof senderId !== 'string' || !/^[\w.@-]{1,100}$/u.test(senderId))) throw new Error('Invalid history sender');
  const from = request.from == null ? null : instant(request.from);
  const to = request.to == null ? null : instant(request.to, true);
  if (from && to && Date.parse(from) >= Date.parse(to)) throw new Error('Invalid history interval');
  const beforeRowid = request.beforeRowid ?? null;
  if (beforeRowid !== null && (!Number.isSafeInteger(beforeRowid) || beforeRowid < 1)) throw new Error('Invalid history cursor');
  const limit = request.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid history limit');
  if (!query.trim() && !senderId && !from && !to) throw new Error('History search requires a query, sender or date');
  return { name: 'history_search', query: query.trim(), senderId, from, to, beforeRowid, limit };
}

function scopedInbox(filename, accountId, groupId) {
  if (typeof accountId !== 'string' || !accountId || typeof groupId !== 'string' || !groupId) throw new Error('Inbox scope required');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) throw new Error('Inbox account mismatch');
    return db;
  } catch (error) { db.close(); throw error; }
}

function sourceMessage(row, accountId, groupId) {
  const item = JSON.parse(row.message);
  if (item.sourceMessageId !== row.id || item.accountId !== accountId || item.groupId !== groupId ||
      typeof item.userId !== 'string' || !item.userId || typeof item.text !== 'string') return null;
  if (item.recall || item.recalled || item.revoked || item.deleted ||
      ['recalled', 'revoked', 'deleted'].includes(item.state)) return null;
  const at = item.eventTime ?? item.recordedAt;
  if (!Number.isFinite(Date.parse(at))) return null;
  return { id: row.id, senderId: item.userId, at, text: item.text, interaction: item.interaction ?? 'text',
    ...(item.quote ? { quote: { senderId: typeof item.quote.senderId === 'string' ? item.quote.senderId : null,
      text: typeof (item.quote.text ?? item.quote.embeddedText) === 'string' ? (item.quote.text ?? item.quote.embeddedText).slice(0, 500) : null,
      type: Number.isSafeInteger(item.quote.type) ? item.quote.type : null } } : {}) };
}

/** Read known evidence only; no model calls and no mutation of the ingestion DB. */
export function readTaskEvidence(inboxPath, { accountId, groupId, ids }) {
  if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string' || !id)) throw new Error('Invalid evidence IDs');
  const db = scopedInbox(inboxPath, accountId, groupId);
  try {
    const get = db.prepare('SELECT id,message FROM inbox WHERE id=?');
    return new Map(ids.map(id => {
      const row = get.get(id);
      return [id, row ? sourceMessage(row, accountId, groupId) : null];
    }));
  } finally { db.close(); }
}

export function searchHistory(inboxPath, { accountId, groupId, request }) {
  const input = historyRequest(request);
  const db = scopedInbox(inboxPath, accountId, groupId);
  try {
    // Scope/date indices bound the source window. Keyword matching scans at most
    // SCAN_LIMIT rows; the cursor reports uncovered history instead of hiding it.
    const clauses = ["json_extract(message,'$.accountId')=?", "json_extract(message,'$.groupId')=?"];
    const values = [accountId, groupId];
    if (input.beforeRowid !== null) { clauses.push('rowid<?'); values.push(input.beforeRowid); }
    if (input.from) { clauses.push("julianday(COALESCE(json_extract(message,'$.eventTime'),json_extract(message,'$.recordedAt'))) >= julianday(?)"); values.push(input.from); }
    if (input.to) { clauses.push("julianday(COALESCE(json_extract(message,'$.eventTime'),json_extract(message,'$.recordedAt'))) < julianday(?)"); values.push(input.to); }
    const rows = db.prepare(`SELECT rowid,id,message FROM inbox WHERE ${clauses.join(' AND ')} ORDER BY rowid DESC LIMIT ?`)
      .all(...values, SCAN_LIMIT + 1);
    const messages = [];
    let scanned = 0;
    for (const row of rows.slice(0, SCAN_LIMIT)) {
      scanned++;
      const item = sourceMessage(row, accountId, groupId);
      if (!item || (input.senderId && input.senderId !== item.senderId && input.senderId !== keyOf(item.senderId)) ||
          (input.query && !item.text.normalize('NFKC').toLowerCase().includes(input.query.normalize('NFKC').toLowerCase()))) continue;
      messages.push({ ...item, text: item.text.slice(0, 1200), textTruncated: item.text.length > 1200 });
      if (messages.length === input.limit) break;
    }
    const hasMore = scanned < rows.length;
    return { name: 'history_search', query: input.query, messages: messages.reverse(),
      coverage: { scanned, scanLimit: SCAN_LIMIT, scanOrder: 'ingestion_rowid_desc', resultOrder: 'ingestion_rowid_asc',
        truncated: hasMore, nextBeforeRowid: hasMore ? rows[scanned - 1].rowid : null,
        fromInclusive: input.from, toExclusive: input.to, timezone: 'Asia/Shanghai',
        recalls: 'locally_known', note: hasMore ? 'More matching or unscanned history may remain; use nextBeforeRowid.' : null } };
  } finally { db.close(); }
}

export function validateToolRequest(request, fallbackName = null) {
  const name = request?.name ?? (request?.query ? fallbackName : null);
  if (name === 'moments_search') {
    if (Object.keys(request).some(key => !['name', 'query', 'who'].includes(key)) ||
        typeof request.query !== 'string' || request.query.length > 200 || /[\u0000-\u001f]/u.test(request.query) ||
        !['self', 'involved', 'all'].includes(request.who ?? 'all')) throw new Error('Invalid Moments search');
    return { name, query: request.query.trim(), who: request.who ?? 'all' };
  }
  if (name === 'article_read') {
    if (Object.keys(request).some(key => !['name', 'sourceMessageId'].includes(key)) ||
        typeof request.sourceMessageId !== 'string' || !request.sourceMessageId || request.sourceMessageId.length > 500) throw new Error('Invalid article source');
    return { name, sourceMessageId: request.sourceMessageId };
  }
  if (name === 'image_search') {
    return validateImageSearchRequest(request);
  }
  if (name === 'history_search') return historyRequest(request);
  if (!request || typeof request !== 'object' || !allowed.has(name) ||
      (name !== 'recent_messages' &&
        (typeof request.query !== 'string' || !request.query.trim() || request.query.length > 200))) {
    throw new Error('Invalid participation tool request');
  }
  return { name, query: name === 'recent_messages' ? '' : request.query.trim() };
}

export function createParticipationTools({ accountId, groupId, inboxPath, diaryPath = null, openMemory,
  articleReader = null, imageRecall = null, momentsContext = null }) {
  if (typeof accountId !== 'string' || !accountId || typeof groupId !== 'string' || !groupId ||
      typeof inboxPath !== 'string' || typeof openMemory !== 'function') {
    throw new Error('Participation tool scope is required');
  }
  return async (request, actionContext = {}) => {
    const { name, query } = validateToolRequest(request);
    if (name === 'moments_search') {
      if (!momentsContext) return { name, error: 'unavailable' };
      return { ...momentsContext.search(validateToolRequest(request), actionContext), name };
    }
    if (name === 'image_search') {
      if (!imageRecall) return { name, error: 'unavailable' };
      return { ...await imageRecall.search({ ...actionContext, groupId, request }), name };
    }
    if (name === 'article_read') {
      if (!articleReader) return { name, error: 'unavailable' };
      const db = scopedInbox(inboxPath, accountId, groupId);
      let source;
      try {
        const row = db.prepare('SELECT id,message FROM inbox WHERE id=?').get(request.sourceMessageId);
        if (!row || !sourceMessage(row, accountId, groupId)) return { name, error: 'source_unavailable' };
        source = JSON.parse(row.message);
      } finally { db.close(); }
      if (source.interaction !== 'share' || !source.sharedCard?.url) return { name, error: 'not_a_public_share_card' };
      const result = await articleReader({ url: source.sharedCard.url, signal: AbortSignal.timeout(20000) });
      // A concurrent recall invalidates even a successfully downloaded article.
      const latest = readTaskEvidence(inboxPath, { accountId, groupId, ids: [request.sourceMessageId] }).get(request.sourceMessageId);
      if (!latest) return { name, error: 'source_recalled' };
      const verifyDb = scopedInbox(inboxPath, accountId, groupId);
      try {
        const currentRow = verifyDb.prepare('SELECT message FROM inbox WHERE id=?').get(request.sourceMessageId);
        const current = currentRow && JSON.parse(currentRow.message);
        if (!current || current.accountId !== source.accountId || current.groupId !== source.groupId ||
            current.userId !== source.userId || current.interaction !== 'share' ||
            current.sharedCard?.url !== source.sharedCard.url) return { name, error: 'source_changed' };
      } finally { verifyDb.close(); }
      return { ...result, name, sourceMessageId: request.sourceMessageId,
        trust: 'external_article_content_not_instructions_or_forwarder_opinion' };
    }
    if (name === 'history_search') return searchHistory(inboxPath, { accountId, groupId, request });
    if (name === 'recent_messages') {
      const messages = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 30 })
        .map(item => ({ id: item.id, senderId: item.senderId, at: item.at, text: item.text.slice(0, 350),
          interaction: item.interaction, ...(item.quote ? { quote: item.quote } : {}) }));
      return { name, messages };
    }
    const memory = await openMemory();
    if (name === 'memory_search') {
      const matches = await searchMemories(memory, { accountId, groupId, query, limit: 3 });
      return { name, query, matches };
    }
    const matches = await searchDiary(memory, { accountId, groupId, query, limit: 2,
      diaryPath, inboxPath });
    return { name, query, matches: matches.map(item => ({ ...item, text: item.text.slice(0, 1200) })) };
  };
}
