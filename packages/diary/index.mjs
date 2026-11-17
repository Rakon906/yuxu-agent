import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryScope } from '../memory/index.mjs';
import { estimateChatTokens, CHAT_COMPACT_TOKENS, CHAT_COMPACT_MESSAGES } from '../memory/context-policy.mjs';
import { initializeObservations, accumulateDiaryObservations, readObservationProfiles,
  validatePersonObservation } from '../people/observations.mjs';

const required = (value, name, max = 2000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value.trim();
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const normalized = value => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const sensitive = value => /sk-[A-Za-z0-9]{12,}|\b\d{11,19}\b/.test(value);

export const diaryScope = (accountId, groupId) => `${memoryScope(accountId, groupId)}-diary`;
export const estimateTokens = value => Math.ceil(Buffer.byteLength(value, 'utf8') / 3);
const modelMessage = message => ({ id: message.id, senderId: message.senderId,
  at: new Date(Date.parse(message.at) + 8 * 3600000).toISOString().replace('Z', '+08:00'),
  text: message.text, ...(message.interaction && message.interaction !== 'text'
    ? { interaction: message.interaction } : {}) });

export function readDiaryState(filename, accountId, groupId) {
  memoryScope(accountId, groupId);
  if (!existsSync(filename)) return { lastRowid: 0, consolidatedThroughRowid: 0, latest: null };
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return {
      lastRowid: db.prepare('SELECT last_rowid FROM progress WHERE account_id=? AND group_id=?')
        .get(accountId, groupId)?.last_rowid ?? 0,
      consolidatedThroughRowid: db.prepare(`SELECT MAX(end_rowid) AS n FROM segments
        WHERE account_id=? AND group_id=? AND indexed=1 AND end_rowid < COALESCE(
          (SELECT MIN(start_rowid) FROM segments WHERE account_id=? AND group_id=? AND indexed=0),
          9223372036854775807)`)
        .get(accountId, groupId, accountId, groupId)?.n ?? 0,
      latest: db.prepare('SELECT title,summary,end_at FROM segments WHERE account_id=? AND group_id=? ORDER BY end_rowid DESC LIMIT 1')
        .get(accountId, groupId) ?? null,
    };
  } finally { db.close(); }
}

export function readCoreFacts(memoryRoot, accountId, groupId) {
  const filename = join(memoryRoot, 'vectors.db');
  if (!existsSync(filename)) return [];
  const scope = memoryScope(accountId, groupId);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare('SELECT id,payload FROM vectors').all().flatMap(row => {
      const item = JSON.parse(row.payload);
      return item.agent_id === scope && item.kind === 'core' &&
        item.accountId === accountId && item.groupId === groupId &&
        typeof item.data === 'string' && typeof item.subjectId === 'string' &&
        item.status !== 'retired'
        ? [{ id: row.id, fact: item.data, subjectId: item.subjectId,
          category: item.category ?? 'general' }] : [];
    });
  } finally { db.close(); }
}

export class DiaryStore {
  constructor(filename) {
    this.filename = filename;
    mkdirSync(dirname(filename), { recursive: true });
    this.lockPath = `${filename}.owner`;
    this.lock = openSync(this.lockPath, 'wx');
    writeFileSync(this.lock, `${process.pid}\n`);
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS progress (
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, last_rowid INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY(account_id,group_id));
        CREATE TABLE IF NOT EXISTS segments (
          id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
          start_rowid INTEGER NOT NULL, end_rowid INTEGER NOT NULL,
          start_at TEXT NOT NULL, end_at TEXT NOT NULL,
          title TEXT NOT NULL, summary TEXT NOT NULL, events_json TEXT NOT NULL,
          source_ids_json TEXT NOT NULL, indexed INTEGER NOT NULL DEFAULT 0,
          memory_id TEXT, created_at TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS segments_scope ON segments(account_id,group_id,end_rowid);
        CREATE TABLE IF NOT EXISTS core_actions (
          segment_id TEXT NOT NULL, position INTEGER NOT NULL, action_json TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', memory_id TEXT,
          PRIMARY KEY(segment_id,position));
        CREATE TABLE IF NOT EXISTS core_revisions (
          segment_id TEXT NOT NULL, position INTEGER NOT NULL,
          account_id TEXT NOT NULL, group_id TEXT NOT NULL, subject_id TEXT NOT NULL,
          action TEXT NOT NULL, category TEXT NOT NULL, memory_id TEXT,
          previous_fact TEXT, next_fact TEXT, previous_status TEXT, next_status TEXT NOT NULL,
          source_ids_json TEXT NOT NULL, evidence_quote TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, applied_at TEXT,
          PRIMARY KEY(segment_id,position));
        CREATE INDEX IF NOT EXISTS core_revisions_subject ON
          core_revisions(account_id,group_id,subject_id,created_at);`);
      initializeObservations(this.db);
    } catch (error) {
      this.db?.close(); closeSync(this.lock); unlinkSync(this.lockPath); throw error;
    }
  }
  close() { this.db.close(); closeSync(this.lock); unlinkSync(this.lockPath); }
  progress(accountId, groupId) {
    return this.db.prepare('SELECT last_rowid FROM progress WHERE account_id=? AND group_id=?')
      .get(accountId, groupId)?.last_rowid ?? 0;
  }
  latest(accountId, groupId) {
    return this.db.prepare('SELECT * FROM segments WHERE account_id=? AND group_id=? ORDER BY end_rowid DESC LIMIT 1')
      .get(accountId, groupId) ?? null;
  }
  segments(accountId, groupId, limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid segment limit');
    return this.db.prepare('SELECT * FROM segments WHERE account_id=? AND group_id=? ORDER BY end_rowid DESC LIMIT ?')
      .all(accountId, groupId, limit);
  }
  pending(accountId, groupId) {
    return this.db.prepare(`SELECT * FROM segments WHERE account_id=? AND group_id=? AND
      (indexed=0 OR EXISTS(SELECT 1 FROM core_actions WHERE segment_id=segments.id AND state='pending'))
      ORDER BY end_rowid`).all(accountId, groupId);
  }
  actions(segmentId) {
    return this.db.prepare('SELECT * FROM core_actions WHERE segment_id=? ORDER BY position').all(segmentId);
  }
  save(segment, updates, sourceMessages = []) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const prior = this.progress(segment.accountId, segment.groupId);
      if (prior !== segment.previousRowid && prior !== segment.endRowid) throw new Error('Diary progress changed during summarization');
      if (prior === segment.endRowid) {
        const existing = this.db.prepare('SELECT * FROM segments WHERE id=?').get(segment.id);
        if (!existing) throw new Error('Diary progress has no matching segment');
        this.db.exec('COMMIT');
        return existing;
      }
      this.db.prepare(`INSERT INTO segments
        (id,account_id,group_id,start_rowid,end_rowid,start_at,end_at,title,summary,events_json,source_ids_json,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(segment.id, segment.accountId, segment.groupId,
        segment.startRowid, segment.endRowid, segment.startAt, segment.endAt, segment.title,
        segment.summary, JSON.stringify(segment.events), JSON.stringify(segment.sourceMessageIds), new Date().toISOString());
      for (const [position, action] of updates.entries()) {
        this.db.prepare('INSERT INTO core_actions(segment_id,position,action_json) VALUES (?,?,?)')
          .run(segment.id, position, JSON.stringify(action));
      }
      accumulateDiaryObservations(this.db, { accountId: segment.accountId, groupId: segment.groupId,
        segmentId: segment.id, events: segment.events, messages: sourceMessages });
      this.db.prepare(`INSERT INTO progress(account_id,group_id,last_rowid) VALUES (?,?,?)
        ON CONFLICT(account_id,group_id) DO UPDATE SET last_rowid=excluded.last_rowid`)
        .run(segment.accountId, segment.groupId, segment.endRowid);
      this.db.exec('COMMIT');
      return this.db.prepare('SELECT * FROM segments WHERE id=?').get(segment.id);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  markIndexed(id, memoryId) {
    this.db.prepare('UPDATE segments SET indexed=1,memory_id=? WHERE id=? AND indexed=0').run(memoryId, id);
  }
  markAction(id, position, state, memoryId = null) {
    this.db.prepare("UPDATE core_actions SET state=?,memory_id=? WHERE segment_id=? AND position=? AND state='pending'")
      .run(state, memoryId, id, position);
  }
  prepareRevision(segment, position, action, previous = null) {
    this.db.prepare(`INSERT OR IGNORE INTO core_revisions
      (segment_id,position,account_id,group_id,subject_id,action,category,memory_id,
       previous_fact,next_fact,previous_status,next_status,source_ids_json,evidence_quote,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(segment.id, position,
      segment.account_id, segment.group_id, action.subjectId, action.action,
      action.category ?? 'general', previous?.id ?? null, previous?.memory ?? null,
      action.action === 'retire' ? null : action.fact,
      previous ? (previous.metadata?.status ?? 'active') : null,
      action.action === 'retire' ? 'retired' : 'active',
      JSON.stringify(action.sourceMessageIds), action.evidenceQuote, new Date().toISOString());
    return this.db.prepare('SELECT * FROM core_revisions WHERE segment_id=? AND position=?')
      .get(segment.id, position);
  }
  finishRevision(segmentId, position, memoryId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`UPDATE core_revisions SET state='applied',memory_id=?,applied_at=?
        WHERE segment_id=? AND position=? AND state='pending'`)
        .run(memoryId, new Date().toISOString(), segmentId, position);
      this.markAction(segmentId, position, 'applied', memoryId);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}

export function readCoreRevisions(filename, accountId, groupId, subjectId) {
  memoryScope(accountId, groupId);
  required(subjectId, 'subjectId', 200);
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare(`SELECT segment_id,position,action,category,memory_id,previous_fact,
      next_fact,previous_status,next_status,source_ids_json,evidence_quote,state,created_at,applied_at
      FROM core_revisions WHERE account_id=? AND group_id=? AND subject_id=?
      ORDER BY created_at,segment_id,position`).all(accountId, groupId, subjectId)
      .map(row => ({ ...row, sourceMessageIds: JSON.parse(row.source_ids_json) }));
  } finally { db.close(); }
}

export function readInbox(dbPath, { accountId, groupId, afterRowid = 0, limit = 256, recent = false }) {
  memoryScope(accountId, groupId);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    if (db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) {
      throw new Error('Inbox account mismatch');
    }
    const rows = recent
      ? db.prepare(`SELECT rowid,id,message,delivered FROM inbox WHERE
          json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?
          ORDER BY rowid DESC LIMIT ?`).all(accountId, groupId, limit).reverse()
      : db.prepare(`SELECT rowid,id,message,delivered FROM inbox WHERE rowid>? AND
          json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?
          ORDER BY rowid LIMIT ?`).all(afterRowid, accountId, groupId, limit);
    return rows.map(row => {
      const message = JSON.parse(row.message);
      if (message.sourceMessageId !== row.id || message.accountId !== accountId || message.groupId !== groupId ||
          typeof message.text !== 'string' || !message.userId) throw new Error('Inbox message identity mismatch');
      // Preserve source semantics across the common reader without forwarding
      // arbitrary transport fields or nested instructions as trusted metadata.
      const quoteText = message.quote?.text ?? message.quote?.embeddedText;
      const quote = message.quote ? {
        serverId: typeof message.quote.serverId === 'string' && /^\d{1,20}$/u.test(message.quote.serverId)
          ? message.quote.serverId : null,
        senderId: typeof message.quote.senderId === 'string' && message.quote.senderId.length <= 200
          ? message.quote.senderId : null,
        type: Number.isSafeInteger(message.quote.type) ? message.quote.type : null,
        state: typeof message.quote.state === 'string' ? message.quote.state.slice(0, 40) : 'unknown',
        text: typeof quoteText === 'string' ? quoteText.slice(0, 2000) : null,
        sticker: message.quote.sticker === true || message.quote.embeddedSticker === true,
        image: message.quote.image === true || message.quote.embeddedImage === true,
      } : null;
      const invalidation = Object.fromEntries(['recall', 'recalled', 'revoked', 'deleted']
        .filter(key => Boolean(message[key])).map(key => [key, true]));
      const sourceState = typeof message.state === 'string' ? message.state.toLowerCase() : null;
      return { rowid: row.rowid, id: row.id, senderId: message.userId, text: message.text,
        at: message.eventTime ?? message.recordedAt, recordedAt: message.recordedAt,
        interaction: message.interaction ?? 'text',
        ...(message.interaction === 'image' ? {
          imageSha256: message.imageSha256,
          imageVisibleText: message.imageVisibleText,
          imageDescriptionCorrection: message.imageDescriptionCorrection,
          imageDescriptionProvenance: message.imageDescriptionProvenance,
        } : {}),
        ...(typeof message.serverId === 'string' && /^\d{1,20}$/u.test(message.serverId)
          ? { serverId: message.serverId } : {}),
        ...(['pending', 'done', 'failed'].includes(message.voiceState) ? { voiceState: message.voiceState } : {}),
        ...(['pending', 'done', 'failed'].includes(message.sharedMediaState) ? { sharedMediaState: message.sharedMediaState } : {}),
        ...(quote ? { quote } : {}), ...invalidation,
        ...(['recalled', 'revoked', 'deleted'].includes(sourceState) ? { state: sourceState } : {}),
        mentions: message.mentions ?? { state: 'unknown', self: false, userIds: [] }, delivered: row.delivered };
    });
  } finally { db.close(); }
}

function references(ids, allowed, label) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 ||
      ids.some(id => typeof id !== 'string' || !allowed.has(id))) throw new Error(`Invalid ${label} source IDs`);
  return [...new Set(ids)];
}

function attributeDiaryEvent(event, byId) {
  const cited = (event.sourceMessageIds ?? []).map(id => byId.get(id)).filter(Boolean);
  const literal = cited.filter(item => item.text.includes(event.evidenceQuote));
  const direct = literal.filter(item => (item.interaction ?? 'text') === 'text');
  return { ...event,
    sourceSpeakerIds: [...new Set(cited.map(item => item.senderId).filter(Boolean))],
    quoteSpeakerIds: [...new Set(direct.map(item => item.senderId).filter(Boolean))],
    ...(literal.length && !direct.length ? { evidenceAttribution: 'external_content_not_source_speaker' } : {}) };
}

export function validateDiaryOutput(output, messages, coreFacts = [], personHistory = []) {
  if (!output || typeof output !== 'object' || !output.diary || !Array.isArray(output.coreUpdates)) throw new Error('Invalid diary JSON shape');
  const currentIds = new Set(messages.map(message => message.id));
  const byId = new Map([...personHistory, ...messages].map(message => [message.id, message]));
  const evidence = (item, label, allowed, requireCurrent = false) => {
    const sourceMessageIds = references(item.sourceMessageIds, allowed, label);
    let evidenceQuote = required(item.evidenceQuote, `${label} evidence`, 200);
    if (requireCurrent && !sourceMessageIds.some(id => currentIds.has(id))) {
      throw new Error(`${label} update needs new source evidence`);
    }
    if (!sourceMessageIds.some(id => (!requireCurrent || currentIds.has(id)) &&
        byId.get(id).text.includes(evidenceQuote))) {
      // Some local models concatenate several cited messages into one quote.
      // Recover only when at least two distinct, complete source texts occur
      // verbatim in that composite quote; never invent or paraphrase evidence.
      const parts = [...new Set(sourceMessageIds.map(id => byId.get(id).text.trim()))]
        .filter(text => text.length >= 4 && text.length <= 200 && evidenceQuote.includes(text));
      if (sourceMessageIds.length < 2 || parts.length < 2) {
        throw new Error(`${label} evidence is absent from source`);
      }
      const literal = parts.filter(text => sourceMessageIds.some(id =>
        (!requireCurrent || currentIds.has(id)) && byId.get(id).text.includes(text)))
        .sort((left, right) => right.length - left.length)[0];
      if (!literal) throw new Error(`${label} evidence is absent from source`);
      evidenceQuote = literal;
    }
    return { sourceMessageIds, evidenceQuote };
  };
  const title = required(output.diary.title, 'diary title', 120);
  const summary = required(output.diary.summary, 'diary summary', 2400);
  if (!Array.isArray(output.diary.events) || output.diary.events.length > 48) throw new Error('Invalid diary events');
  const events = output.diary.events.map(item => {
    const event = attributeDiaryEvent({ text: required(item.text, 'event text', 500),
      ...evidence(item, 'event', currentIds) }, byId);
    try {
      const observation = validatePersonObservation(item.personObservation, event, messages);
      return observation ? { ...event, personObservation: observation } : event;
    } catch {
      // Optional classification must not block a diary whose original evidence passed.
      // Preserve the checked event, never the unsupported inferred label.
      return { ...event, classificationRejected: 'invalid_person_observation' };
    }
  });
  if (output.coreUpdates.length > 12) throw new Error('Too many core updates');
  const knownCore = new Map(coreFacts.map(item => [item.id, item]));
  const coreUpdates = output.coreUpdates.map(item => {
    if (!['add', 'replace', 'retire'].includes(item.action)) throw new Error('Invalid core action');
    const category = item.category ?? (item.action !== 'add'
      ? knownCore.get(item.targetMemoryId)?.category : null) ?? 'general';
    if (!['general', 'identity', 'nickname', 'interest', 'preference', 'speaking_style',
      'activity_pattern', 'personality', 'relationship'].includes(category)) throw new Error('Invalid core category');
    const targetMemoryId = item.action !== 'add' ? required(item.targetMemoryId, 'target memory ID', 200) : null;
    const fact = item.action === 'retire' ? null : required(item.fact, 'core fact', 500);
    if (fact && sensitive(fact)) throw new Error('Core fact contains a credential or long number');
    const refs = evidence(item, 'core', new Set(byId.keys()), true);
    const subjectId = required(item.subjectId, 'core subject', 200);
    if (!refs.sourceMessageIds.some(id => currentIds.has(id) &&
        (byId.get(id).interaction ?? 'text') === 'text' && byId.get(id).text.includes(refs.evidenceQuote))) {
      throw new Error('Core update needs direct text evidence, not external media or forwarded content');
    }
    if (subjectId !== 'group' && !refs.sourceMessageIds.some(id => currentIds.has(id) &&
        byId.get(id).senderId === subjectId && (byId.get(id).interaction ?? 'text') === 'text' &&
        byId.get(id).text.includes(refs.evidenceQuote))) {
      throw new Error('Core subject is not a cited sender');
    }
    if (item.action !== 'retire' && ['speaking_style', 'activity_pattern', 'personality'].includes(category)) {
      const own = refs.sourceMessageIds.map(id => byId.get(id)).filter(message =>
        message.senderId === subjectId && (message.interaction ?? 'text') === 'text');
      if (own.length < 3 || (['activity_pattern', 'personality'].includes(category) &&
          new Set(own.map(message => new Date(Date.parse(message.at) + 8 * 3600000).toISOString().slice(0, 10))).size < 2)) {
        throw new Error('Behavior profile needs repeated self evidence');
      }
    }
    if (targetMemoryId && (!knownCore.has(targetMemoryId) || knownCore.get(targetMemoryId).subjectId !== subjectId)) {
      throw new Error('Core replacement target is outside the supplied scope');
    }
    return { action: item.action, category, fact, subjectId, ...refs, targetMemoryId };
  });
  const targets = coreUpdates.map(item => item.targetMemoryId).filter(Boolean);
  if (new Set(targets).size !== targets.length) throw new Error('Repeated core update target');
  return { diary: { title, summary, events }, coreUpdates };
}

export function selectBatch(messages, maxTokens) {
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 100) throw new Error('Invalid diary batch limit');
  const chosen = [];
  let tokens = 0;
  for (const message of messages) {
    const cost = estimateTokens(JSON.stringify([...chosen, message].map(modelMessage)));
    if (chosen.length && cost > maxTokens) break;
    chosen.push(message);
    tokens = cost;
  }
  return { messages: chosen, tokens, hasMore: chosen.length < messages.length };
}

function prepareDiary({ inboxPath, accountId, groupId, afterRowid, triggerTokens = 120000,
  maxBatchTokens = 30000, maxAgeMs = 0, now = Date.now(), force = false }) {
  if (!Number.isSafeInteger(triggerTokens) || triggerTokens < 100 ||
      !Number.isSafeInteger(maxBatchTokens) || maxBatchTokens < 100 ||
      !Number.isSafeInteger(maxAgeMs) || (maxAgeMs !== 0 && maxAgeMs < 60000)) throw new Error('Invalid diary thresholds');
  const pending = [];
  let batch;
  let cursor = afterRowid;
  let pendingTokens = 0;
  let pendingContextTokens = 0;
  while (true) {
    const pageLimit = Math.min(257, CHAT_COMPACT_MESSAGES - pending.length);
    const page = readInbox(inboxPath, { accountId, groupId, afterRowid: cursor, limit: pageLimit });
    if (!page.length) break;
    pending.push(...page);
    cursor = page.at(-1).rowid;
    batch = selectBatch(pending, maxBatchTokens);
    pendingTokens = estimateTokens(JSON.stringify(pending.map(modelMessage)));
    pendingContextTokens = estimateChatTokens(pending);
    if (pendingTokens >= triggerTokens || pendingContextTokens >= CHAT_COMPACT_TOKENS ||
        pending.length >= CHAT_COMPACT_MESSAGES || page.length < pageLimit) break;
  }
  if (!pending.length) return { status: 'idle', reason: 'no_messages', pending: 0,
    estimatedTokens: 0, batch: null };
  const oldestAt = Date.parse(pending[0].at);
  const ageDue = maxAgeMs > 0 && Number.isFinite(oldestAt) && oldestAt <= now - maxAgeMs;
  const reason = force ? 'forced' : pendingTokens >= triggerTokens
    ? 'capacity' : pendingContextTokens >= CHAT_COMPACT_TOKENS ? 'context_capacity'
    : pending.length >= CHAT_COMPACT_MESSAGES ? 'message_capacity'
    : ageDue ? 'window_boundary' : 'below_capacity';
  return { status: reason === 'below_capacity' ? 'waiting' : 'ready', reason,
    pending: pending.length, pendingTokens, pendingContextTokens, estimatedTokens: batch.tokens, batch };
}

export function planDiary({ diaryPath, inboxPath, accountId, groupId,
  triggerTokens = 120000, maxBatchTokens = 30000,
  maxAgeMs = 0, now = Date.now(), force = false }) {
  const state = readDiaryState(diaryPath, accountId, groupId);
  const plan = prepareDiary({ inboxPath, accountId, groupId, afterRowid: state.lastRowid,
    triggerTokens, maxBatchTokens, maxAgeMs, now, force });
  return { status: plan.status, reason: plan.reason, lastRowid: state.lastRowid,
    pendingAtLeast: plan.pending, pendingEstimatedTokens: plan.pendingTokens ?? 0,
    pendingContextTokens: plan.pendingContextTokens ?? 0,
    contextTokenTrigger: CHAT_COMPACT_TOKENS, messageCountTrigger: CHAT_COMPACT_MESSAGES,
    timeTriggerEnabled: maxAgeMs > 0,
    estimatedTokens: plan.estimatedTokens,
    selected: plan.batch?.messages.length ?? 0 };
}

function recentPersonHistory(inboxPath, accountId, groupId, batch, diaryPath = null) {
  const current = new Set(batch.map(item => item.id));
  const senders = new Set(batch.map(item => item.senderId));
  const counts = new Map();
  const chosen = [];
  const observations = readObservationProfiles(diaryPath, { accountId, groupId, inboxPath,
    userIds: [...senders].slice(0, 30), limitPerPerson: 3 });
  const observationsBySource = new Map(observations.flatMap(item => item.evidence.map(source =>
    [source.sourceMessageId, { category: item.category, topic: item.topic, state: item.state, trait: item.trait,
      quote: source.quote }])));
  const savedEvidence = [];
  if (observationsBySource.size) {
    const db = new DatabaseSync(inboxPath, { readOnly: true });
    try {
      const find = db.prepare('SELECT rowid,id,message FROM inbox WHERE id=?');
      for (const id of observationsBySource.keys()) {
        const row = find.get(id);
        if (!row) continue;
        const item = JSON.parse(row.message);
        if (item.accountId !== accountId || item.groupId !== groupId || item.sourceMessageId !== id ||
            typeof item.text !== 'string' || !senders.has(item.userId)) continue;
        savedEvidence.push({ rowid: row.rowid, id, senderId: item.userId, text: item.text,
          at: item.eventTime ?? item.recordedAt, interaction: item.interaction ?? 'text' });
      }
    } finally { db.close(); }
  }
  const visited = new Set();
  for (const item of [...savedEvidence,
    ...readInbox(inboxPath, { accountId, groupId, recent: true, limit: 512 }).reverse()]) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    if (current.has(item.id) || item.rowid >= batch[0].rowid || !senders.has(item.senderId)) continue;
    const day = modelMessage(item).at.slice(0, 10);
    const key = `${item.senderId}:${day}`;
    if ((counts.get(item.senderId) ?? 0) >= 6 || (counts.get(key) ?? 0) >= 2) continue;
    const priorObservation = observationsBySource.get(item.id);
    const quoteAt = priorObservation ? item.text.indexOf(priorObservation.quote) : -1;
    const excerpt = { ...modelMessage(item), text: item.text.slice(Math.max(0, quoteAt), Math.max(0, quoteAt) + 350),
      ...(priorObservation && quoteAt >= 0 ? { observation: priorObservation } : {}) };
    if (chosen.length && estimateTokens(JSON.stringify([...chosen, excerpt])) > 1200) continue;
    counts.set(item.senderId, (counts.get(item.senderId) ?? 0) + 1);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    chosen.push(excerpt);
    if (chosen.length >= 24) break;
  }
  return chosen.reverse();
}

async function generateCheckedDiary({ batch, model, previousDiary, coreFacts, personHistory = [] }) {
  let selected = batch.messages;
  let retryFeedback = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const input = selected.map(modelMessage);
    let generated;
    try { generated = await model({ messages: input, previousDiary, coreFacts, personHistory,
      retryFeedback }); }
    catch (error) {
      if (error.code !== 'DIARY_OUTPUT_LIMIT' || selected.length < 2 || attempt === 3) throw error;
      selected = selected.slice(0, Math.ceil(selected.length / 2));
      continue;
    }
    let checked;
    try { checked = validateDiaryOutput(generated, input, coreFacts, personHistory); }
    catch (error) {
      error.code = 'DIARY_VALIDATION_FAILED';
      if (attempt === 3) throw error;
      retryFeedback = `上次输出未通过校验：${error.message}。重新核对每个引用 ID，并从对应新消息 text 逐字复制连续的 evidenceQuote；无法引用的条目请删除。`;
      continue;
    }
    return { selected, input, checked,
      estimatedTokens: estimateTokens(JSON.stringify(input)), attempts: attempt, reusedPreview: false };
  }
  throw new Error('Diary batch retry exhausted');
}

const previewCachePath = (diaryPath, accountId, groupId) =>
  join(dirname(diaryPath), 'preview-cache', `${digest([accountId, groupId])}.json`);
const coreDigest = coreFacts => digest([...coreFacts].sort((a, b) => a.id.localeCompare(b.id)));

function cachedDiary({ diaryPath, accountId, groupId, afterRowid, batch, previousDiary,
  coreFacts, personHistory = [] }) {
  const path = previewCachePath(diaryPath, accountId, groupId);
  if (!existsSync(path)) return null;
  const cache = JSON.parse(readFileSync(path, 'utf8'));
  if (cache.schemaVersion !== 2 || cache.accountId !== accountId || cache.groupId !== groupId ||
      cache.afterRowid !== afterRowid || cache.previousDiaryDigest !== digest(previousDiary) ||
      cache.coreFactsDigest !== coreDigest(coreFacts) ||
      cache.personHistoryDigest !== digest(personHistory) || !Array.isArray(cache.messageIds) ||
      !cache.messageIds.length || cache.messageIds.length > batch.messages.length ||
      cache.messageIds.some((id, index) => id !== batch.messages[index].id)) return null;
  const selected = batch.messages.slice(0, cache.messageIds.length);
  const input = selected.map(modelMessage);
  if (cache.messagesDigest && cache.messagesDigest !== digest(input)) return null;
  let checked;
  try { checked = validateDiaryOutput(cache.output, input, coreFacts, personHistory); }
  catch (error) { error.code = 'DIARY_VALIDATION_FAILED'; throw error; }
  return { selected, input, checked, estimatedTokens: estimateTokens(JSON.stringify(input)),
    attempts: 0, reusedPreview: true };
}

export async function previewDiary({ diaryPath, inboxPath, accountId, groupId, model, coreFacts = [],
  triggerTokens = 120000, maxBatchTokens = 30000, maxAgeMs = 0,
  now = Date.now(), force = false, saveCache = false }) {
  if (typeof model !== 'function') throw new Error('Diary model is required');
  const state = readDiaryState(diaryPath, accountId, groupId);
  const plan = prepareDiary({ inboxPath, accountId, groupId, afterRowid: state.lastRowid,
    triggerTokens, maxBatchTokens, maxAgeMs, now, force });
  if (plan.status !== 'ready') return { status: plan.status, reason: plan.reason,
    pending: plan.pending, estimatedTokens: plan.estimatedTokens };
  const previousDiary = state.latest ? { title: state.latest.title,
    summary: state.latest.summary, endAt: state.latest.end_at } : null;
  const personHistory = recentPersonHistory(inboxPath, accountId, groupId, plan.batch.messages, diaryPath);
  const generated = await generateCheckedDiary({ batch: plan.batch, model, previousDiary,
    coreFacts, personHistory });
  if (saveCache) {
    const path = previewCachePath(diaryPath, accountId, groupId);
    mkdirSync(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ schemaVersion: 2, accountId, groupId,
      afterRowid: state.lastRowid, messageIds: generated.input.map(item => item.id),
      messagesDigest: digest(generated.input), previousDiaryDigest: digest(previousDiary),
      coreFactsDigest: coreDigest(coreFacts), personHistoryDigest: digest(personHistory),
      output: generated.checked }), { mode: 0o600 });
    renameSync(temp, path);
  }
  return { status: 'preview', reason: plan.reason, sources: generated.input.length,
    estimatedTokens: generated.estimatedTokens, attempts: generated.attempts,
    cacheSaved: saveCache, sourceMessageIds: generated.input.map(message => message.id), ...generated.checked };
}

async function currentCore(memory, accountId, groupId) {
  const scope = memoryScope(accountId, groupId);
  const result = await memory.getAll({ filters: { agent_id: scope, kind: 'core' }, topK: 100 });
  return result.results.filter(item => item.metadata?.accountId === accountId &&
    item.metadata?.groupId === groupId && item.metadata?.kind === 'core' &&
    item.metadata?.status !== 'retired')
    .map(item => ({ id: item.id, fact: item.memory, subjectId: item.metadata.subjectId,
      category: item.metadata.category ?? 'general' }));
}

export async function syncDiary(store, memory, accountId, groupId) {
  const scope = diaryScope(accountId, groupId);
  const coreScope = memoryScope(accountId, groupId);
  let indexed = 0, applied = 0;
  for (const segment of store.pending(accountId, groupId)) {
    if (!segment.indexed) {
      const prior = await memory.getAll({ filters: { agent_id: scope, segmentId: segment.id }, topK: 1 });
      let item = prior.results.find(value => value.metadata?.segmentId === segment.id);
      if (!item) {
        const body = [segment.title, segment.summary,
          ...JSON.parse(segment.events_json).map(event => event.text)].join('\n');
        const result = await memory.add(body, { agentId: scope, infer: false,
          metadata: { kind: 'diary', accountId, groupId, segmentId: segment.id,
            startAt: segment.start_at, endAt: segment.end_at,
            sourceMessageIds: JSON.parse(segment.source_ids_json), title: segment.title } });
        item = result.results.find(value => value.metadata?.segmentId === segment.id) ?? result.results[0];
      }
      if (!item?.id) throw new Error('Mem0 did not return diary memory ID');
      store.markIndexed(segment.id, item.id);
      indexed++;
    }
    for (const row of store.actions(segment.id)) {
      if (row.state !== 'pending') continue;
      const action = JSON.parse(row.action_json);
      if (action.action === 'replace' || action.action === 'retire') {
        const target = await memory.get(action.targetMemoryId);
        if (!target || target.agent_id !== coreScope || target.metadata?.accountId !== accountId ||
            target.metadata?.groupId !== groupId || target.metadata?.kind !== 'core' ||
            target.metadata?.subjectId !== action.subjectId) throw new Error('Core replacement scope mismatch');
        const revision = store.prepareRevision(segment, row.position, action, target);
        if (target.metadata?.status === 'retired' && revision.previous_status !== 'active') {
          throw new Error('Core target is already retired');
        }
        const nextFact = action.action === 'retire' ? target.memory : action.fact;
        await memory.update(target.id, { text: nextFact,
          metadata: { kind: 'core', accountId, groupId, subjectId: action.subjectId,
            category: action.category ?? target.metadata?.category ?? 'general',
            status: action.action === 'retire' ? 'retired' : 'active',
            sourceMessageIds: action.sourceMessageIds, evidenceQuote: action.evidenceQuote,
            lastSegmentId: segment.id, normalizedFact: normalized(nextFact) } });
        store.finishRevision(segment.id, row.position, target.id);
      } else {
        const factKey = digest([segment.id, row.position, action.fact]);
        const prior = await memory.getAll({ filters: { agent_id: coreScope, factKey }, topK: 1 });
        let item = prior.results.find(value => value.metadata?.factKey === factKey);
        if (!item) {
          const duplicate = await memory.getAll({ filters: { agent_id: coreScope,
            normalizedFact: normalized(action.fact) }, topK: 20 });
          item = duplicate.results.find(value => value.metadata?.accountId === accountId &&
            value.metadata?.groupId === groupId && value.metadata?.subjectId === action.subjectId);
        }
        store.prepareRevision(segment, row.position, action, item);
        if (!item) {
          const result = await memory.add(action.fact, { agentId: coreScope, infer: false,
            metadata: { kind: 'core', accountId, groupId, subjectId: action.subjectId,
              category: action.category ?? 'general', status: 'active',
              sourceMessageIds: action.sourceMessageIds, evidenceQuote: action.evidenceQuote,
              segmentId: segment.id, factKey, normalizedFact: normalized(action.fact) } });
          item = result.results.find(value => value.metadata?.factKey === factKey) ?? result.results[0];
        } else if (item.metadata?.status === 'retired') {
          await memory.update(item.id, { text: action.fact,
            metadata: { kind: 'core', accountId, groupId, subjectId: action.subjectId,
              category: action.category ?? 'general', status: 'active',
              sourceMessageIds: action.sourceMessageIds, evidenceQuote: action.evidenceQuote,
              segmentId: segment.id, factKey, normalizedFact: normalized(action.fact) } });
        }
        if (!item?.id) throw new Error('Mem0 did not return core memory ID');
        store.finishRevision(segment.id, row.position, item.id);
      }
      applied++;
    }
  }
  return { indexed, applied };
}

export async function runDiary({ store, memory, model, inboxPath, accountId, groupId,
  force = false, triggerTokens = 120000, maxBatchTokens = 30000,
  maxAgeMs = 0, now = Date.now(), onIntimacy = null }) {
  memoryScope(accountId, groupId);
  if (typeof model !== 'function') throw new Error('Diary model is required');
  const recovered = await syncDiary(store, memory, accountId, groupId);
  const afterRowid = store.progress(accountId, groupId);
  const plan = prepareDiary({ inboxPath, accountId, groupId, afterRowid, force,
    triggerTokens, maxBatchTokens, maxAgeMs, now });
  if (plan.status !== 'ready') return { status: plan.status, reason: plan.reason,
    ...recovered, pending: plan.pending, estimatedTokens: plan.estimatedTokens };
  const coreFacts = await currentCore(memory, accountId, groupId);
  const latest = store.latest(accountId, groupId);
  const previousDiary = latest ? { title: latest.title, summary: latest.summary, endAt: latest.end_at } : null;
  const personHistory = recentPersonHistory(inboxPath, accountId, groupId, plan.batch.messages, store.filename);
  const generated = cachedDiary({ diaryPath: store.filename, accountId, groupId,
    afterRowid, batch: plan.batch, previousDiary, coreFacts, personHistory }) ??
    await generateCheckedDiary({ batch: plan.batch, model, previousDiary, coreFacts, personHistory });
  const batch = generated.selected;
  const checked = generated.checked;
  const first = batch[0], last = batch.at(-1);
  const id = digest([accountId, groupId, first.id, last.id]);
  store.save({ id, accountId, groupId, previousRowid: afterRowid, startRowid: first.rowid, endRowid: last.rowid,
    startAt: first.at, endAt: last.at, title: checked.diary.title, summary: checked.diary.summary,
    events: checked.diary.events, sourceMessageIds: batch.map(message => message.id) }, checked.coreUpdates, batch);
  let intimacy = null;
  if (typeof onIntimacy === 'function') {
    try {
      intimacy = await onIntimacy({ accountId, groupId, batch, diary: checked.diary,
        segmentId: id, now });
    } catch { intimacy = { error: true }; }
  }
  const synced = await syncDiary(store, memory, accountId, groupId);
  return { status: 'written', reason: plan.reason, id, sources: batch.length,
    estimatedTokens: generated.estimatedTokens, attempts: generated.attempts,
    reusedPreview: generated.reusedPreview, intimacy,
    coreUpdates: checked.coreUpdates.length,
    classificationRejected: checked.diary.events.filter(event => event.classificationRejected).length, ...synced };
}

function diaryEventsFromSources({ diaryPath, inboxPath, accountId, groupId, segmentId }) {
  if (!diaryPath || !inboxPath || !existsSync(diaryPath) || !existsSync(inboxPath) || !segmentId) return [];
  const diary = new DatabaseSync(diaryPath, { readOnly: true });
  let events;
  try {
    const row = diary.prepare('SELECT events_json FROM segments WHERE id=? AND account_id=? AND group_id=?')
      .get(segmentId, accountId, groupId);
    if (!row) return [];
    events = JSON.parse(row.events_json);
  } finally { diary.close(); }
  if (!Array.isArray(events) || events.length > 48) throw new Error('Invalid stored diary events');
  const inbox = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const find = inbox.prepare('SELECT message FROM inbox WHERE id=?');
    const byId = new Map();
    for (const id of new Set(events.flatMap(event => event.sourceMessageIds ?? []))) {
      const raw = find.get(id)?.message;
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.accountId !== accountId || message.groupId !== groupId ||
          message.sourceMessageId !== id || typeof message.text !== 'string' ||
          typeof message.userId !== 'string') continue;
      byId.set(id, { senderId: message.userId, text: message.text, interaction: message.interaction ?? 'text' });
    }
    return events.map(event => attributeDiaryEvent(event, byId));
  } finally { inbox.close(); }
}

export async function searchDiary(memory, { accountId, groupId, query, limit = 5,
  diaryPath = null, inboxPath = null }) {
  const scope = diaryScope(accountId, groupId);
  required(query, 'diary query', 1000);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid diary search limit');
  const result = await memory.search(query, { filters: { agent_id: scope }, topK: limit, threshold: 0 });
  return result.results.filter(item => item.metadata?.kind === 'diary' &&
      item.metadata.accountId === accountId && item.metadata.groupId === groupId)
    .map(item => ({ id: item.id, title: item.metadata.title, text: item.memory,
      startAt: item.metadata.startAt, endAt: item.metadata.endAt,
      sourceMessageIds: item.metadata.sourceMessageIds, score: item.score ?? null,
      events: diaryEventsFromSources({ diaryPath, inboxPath, accountId, groupId,
        segmentId: item.metadata.segmentId }) }));
}
