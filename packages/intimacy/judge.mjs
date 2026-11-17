import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAnthropicJsonModel } from '../model/anthropic.mjs';
import { createOllamaJsonModel } from '../model/ollama.mjs';
import {
  DEFAULT_INTIMACY, MAX_DECREASE, MAX_INCREASE, openIntimacyStore,
} from './index.mjs';

const skillUrl = new URL('../../skills/member-intimacy/SKILL.md', import.meta.url);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function createIntimacyJudgeModel({ provider = process.env.SOCIOMEM_INTIMACY_PROVIDER ??
  process.env.SOCIOMEM_DIARY_PROVIDER ?? 'ollama', anthropic = null, ollama = null } = {}) {
  if (!['anthropic', 'ollama'].includes(provider)) throw new Error('Invalid intimacy provider');
  const model = provider === 'anthropic' ? anthropic ?? createAnthropicJsonModel()
    : ollama ?? createOllamaJsonModel();
  return async input => {
    const messages = [{ role: 'system', content: readFileSync(skillUrl, 'utf8') },
      { role: 'user', content: JSON.stringify(input) }];
    const memberCount = input.members?.length ?? 0;
    // The remote model can spend tokens before producing the compact JSON.
    // Real diary replays exhausted 2400; give the normal call enough headroom.
    const budget = provider === 'anthropic'
      ? Math.min(6400, Math.max(4800, 3200 + memberCount * 160))
      : Math.min(4800, Math.max(2400, 1200 + memberCount * 180));
    try {
      return await model({ component: 'intimacy', messages, maxTokens: budget,
        temperature: 0.2, timeoutMs: 120000 });
    } catch (error) {
      // Both adapters mark truncation with this code. No immediate retry for transport/JSON errors.
      if (error.code !== 'DIARY_OUTPUT_LIMIT') throw error;
      return model({ component: 'intimacy', messages, maxTokens: Math.min(8192, budget * 2),
        temperature: 0.2, timeoutMs: 120000 });
    }
  };
}

function lastSpokenMap(inboxPath, accountId, groupId) {
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  const last = new Map();
  try {
    for (const row of db.prepare('SELECT message FROM inbox ORDER BY rowid DESC LIMIT 5000').all()) {
      let item;
      try { item = JSON.parse(row.message); } catch { continue; }
      if (item.accountId !== accountId || item.groupId !== groupId || !item.userId) continue;
      const at = Date.parse(item.eventTime);
      if (!Number.isFinite(at)) continue;
      if (!last.has(item.userId) || at > last.get(item.userId)) last.set(item.userId, at);
    }
  } finally { db.close(); }
  return last;
}

const MAX_ATTEMPTS = 3;
const RETRY_MS = 30 * 60000;
function evidenceError(message) {
  const error = new Error(message);
  error.code = 'INTIMACY_EVIDENCE_INVALID';
  return error;
}

function verifySources(inboxPath, sources, accountId, groupId) {
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const find = db.prepare('SELECT message FROM inbox WHERE id=?');
    for (const source of sources) {
      let raw;
      try { raw = JSON.parse(find.get(source.id)?.message); } catch { /* invalid source */ }
      if (!raw || raw.accountId !== accountId || raw.groupId !== groupId ||
        raw.sourceMessageId !== source.id || raw.userId !== source.senderId ||
        typeof raw.text !== 'string' || raw.text !== source.originalText ||
        ['recall', 'recalled', 'revoked', 'deleted'].some(key => raw[key]) ||
        ['recalled', 'revoked', 'deleted'].includes(String(raw.state ?? '').toLowerCase())) {
        throw evidenceError('Intimacy source changed or is unavailable');
      }
    }
  } finally { db.close(); }
}

export function enqueueIntimacy({ store, accountId, groupId, batch, diary, segmentId, now = Date.now() }) {
  if (![accountId, groupId, segmentId].every(value => typeof value === 'string' && value) || !Array.isArray(batch)) {
    throw new Error('Invalid intimacy job');
  }
  const payload = { batch: batch.map(({ id, senderId, text, at }) => ({ id, senderId, text, at })),
    diary: { title: diary.title, summary: diary.summary } };
  store.db.prepare(`INSERT OR IGNORE INTO intimacy_jobs
    (account_id,group_id,segment_id,payload_json,next_attempt_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`).run(accountId, groupId, segmentId, JSON.stringify(payload), now, now, now);
  return store.db.prepare('SELECT * FROM intimacy_jobs WHERE account_id=? AND group_id=? AND segment_id=?')
    .get(accountId, groupId, segmentId);
}

function modelInput({ store, accountId, groupId, batch, diary, now }) {
  const participants = new Map();
  for (const message of batch) {
    if (!message?.senderId || typeof message.text !== 'string' || !message.text) continue;
    if (!participants.has(message.senderId)) participants.set(message.senderId, []);
    participants.get(message.senderId).push(message);
  }
  const people = new Map(), sources = new Map();
  const members = [...participants.entries()].slice(0, 20).map(([userId, rows], index) => {
    const ref = `p${index + 1}`;
    people.set(ref, userId);
    const messages = rows.slice(-6).map(message => {
      if (typeof message.id !== 'string' || !message.id) throw evidenceError('Intimacy message is missing its source ID');
      const id = `m${sources.size + 1}`;
      const source = { ...message, originalText: message.text, text: message.text.slice(0, 220) };
      sources.set(id, source);
      return { id, text: source.text };
    });
    return { userId: ref, current: store.get(accountId, groupId, userId, now).score, messages };
  });
  return { input: { diary: { title: String(diary.title ?? '').slice(0, 100),
    summary: String(diary.summary ?? '').slice(0, 1000) }, members }, participants, people, sources };
}

function checkedChanges(output, prepared) {
  if (!Array.isArray(output?.changes) || output.changes.length > prepared.people.size) throw evidenceError('Invalid intimacy changes');
  const seen = new Set();
  return output.changes.flatMap(item => {
    if (!item || !prepared.people.has(item.userId) || seen.has(item.userId)) throw evidenceError('Invalid intimacy member reference');
    seen.add(item.userId);
    if (typeof item.delta !== 'number' || !Number.isFinite(item.delta)) throw evidenceError('Invalid intimacy delta');
    if (item.delta === 0) return [];
    const userId = prepared.people.get(item.userId);
    const ids = item.sourceMessageIds, quote = item.evidenceQuote;
    if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 120 ||
      !Array.isArray(ids) || ids.length < 1 || ids.length > 3 || new Set(ids).size !== ids.length ||
      ids.some(id => !prepared.sources.has(id) || prepared.sources.get(id).senderId !== userId) ||
      typeof quote !== 'string' || !quote.trim() || quote.length > 160 ||
      !ids.some(id => prepared.sources.get(id).text.includes(quote))) {
      throw evidenceError('Intimacy change requires this member\'s verbatim evidence');
    }
    return [{ userId, delta: clamp(Math.round(item.delta * 100) / 100, -MAX_DECREASE, MAX_INCREASE),
      reason: item.reason.trim(), sourceMessageIds: ids.map(id => prepared.sources.get(id).id), evidenceQuote: quote }];
  });
}

export async function judgeIntimacy({ model, store = openIntimacyStore(), inboxPath,
  accountId, groupId, batch, diary, segmentId, now = Date.now(), closeStore = false }) {
  if (typeof model !== 'function') throw new Error('Intimacy model is required');
  try {
    const job = enqueueIntimacy({ store, accountId, groupId, batch, diary, segmentId, now });
    if (job.state !== 'pending' || job.next_attempt_at > now) return { applied: [], decayed: [],
      modelError: null, queueState: job.state, duplicate: job.state === 'done' };
    const claimed = store.db.prepare(`UPDATE intimacy_jobs SET attempts=attempts+1,next_attempt_at=?,updated_at=?
      WHERE account_id=? AND group_id=? AND segment_id=? AND state='pending' AND next_attempt_at<=? AND attempts<?`)
      .run(now + RETRY_MS, now, accountId, groupId, segmentId, now, MAX_ATTEMPTS);
    if (!claimed.changes) return { applied: [], decayed: [], modelError: null, queueState: 'waiting' };
    try {
      // Replays use the persisted original input, not a newly supplied lookalike.
      const payload = JSON.parse(job.payload_json);
      const prepared = modelInput({ store, accountId, groupId, ...payload, now });
      verifySources(inboxPath, [...prepared.sources.values()], accountId, groupId);
      const output = prepared.people.size ? await model(prepared.input) : { changes: [] };
      const changes = checkedChanges(output, prepared);
      // A recall or edit during inference invalidates the entire evaluation.
      verifySources(inboxPath, [...prepared.sources.values()], accountId, groupId);
      const last = lastSpokenMap(inboxPath, accountId, groupId);
      const applied = [], decayed = [];
      store.db.exec('BEGIN IMMEDIATE');
      try {
        for (const change of changes) applied.push({ ...store.apply({ accountId, groupId, ...change,
          taskId: `diary:${segmentId}`, now }), userId: change.userId });
        for (const member of store.list(accountId, groupId)) {
          if (member.locked || prepared.participants.has(member.userId) || member.score <= DEFAULT_INTIMACY) continue;
          const spokenAt = last.get(member.userId);
          if (!spokenAt) continue;
          const days = (now - spokenAt) / 86400000;
          let delta = days >= 14 ? -0.4 : days >= 7 ? -0.2 : days >= 3 ? -0.1 : 0;
          if (delta) delta = Math.max(delta, DEFAULT_INTIMACY - member.score);
          if (!delta) continue;
          decayed.push({ ...store.apply({ accountId, groupId, userId: member.userId,
            delta, reason: `超过 ${Math.floor(days)} 天没在群里说话`,
            taskId: `inactivity:${segmentId}`, now }), userId: member.userId });
        }
        store.db.prepare(`UPDATE intimacy_jobs SET state='done',last_error=NULL,result_json=?,updated_at=?
          WHERE account_id=? AND group_id=? AND segment_id=?`)
          .run(JSON.stringify({ changes }), now, accountId, groupId, segmentId);
        store.db.exec('COMMIT');
      } catch (error) { store.db.exec('ROLLBACK'); throw error; }
      return { applied, decayed, modelError: null, queueState: 'done' };
    } catch (error) {
      const terminal = error.code === 'INTIMACY_EVIDENCE_INVALID' || job.attempts + 1 >= MAX_ATTEMPTS;
      const state = terminal ? 'failed' : 'pending';
      // Persist stable error identity only, never arbitrary server response text.
      store.db.prepare(`UPDATE intimacy_jobs SET state=?,last_error=?,next_attempt_at=?,updated_at=?
        WHERE account_id=? AND group_id=? AND segment_id=?`)
        .run(state, error.code ?? error.name, now + RETRY_MS * 2 ** job.attempts, now, accountId, groupId, segmentId);
      return { applied: [], decayed: [], modelError: { name: error.name,
        message: error.message.slice(0, 160) }, queueState: state };
    }
  } finally { if (closeStore) store.close(); }
}

export async function retryPendingIntimacy({ model, store, inboxPath, accountId, groupIds, now = Date.now(), limit = 1 }) {
  if (!Array.isArray(groupIds) || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Invalid intimacy retry scope');
  for (const groupId of groupIds) store.db.prepare(`UPDATE intimacy_jobs SET state='failed',last_error='ATTEMPTS_EXHAUSTED',updated_at=?
    WHERE account_id=? AND group_id=? AND state='pending' AND next_attempt_at<=? AND attempts>=?`)
    .run(now, accountId, groupId, now, MAX_ATTEMPTS);
  const jobs = store.db.prepare(`SELECT * FROM intimacy_jobs WHERE account_id=? AND state='pending'
    AND next_attempt_at<=? AND attempts<? ORDER BY next_attempt_at,created_at`).all(accountId, now, MAX_ATTEMPTS)
    .filter(job => groupIds.includes(job.group_id)).slice(0, limit);
  const results = [];
  for (const job of jobs) results.push({ segmentId: job.segment_id, groupId: job.group_id,
    ...await judgeIntimacy({ model, store, inboxPath, accountId, groupId: job.group_id,
      segmentId: job.segment_id, ...JSON.parse(job.payload_json), now }) });
  return results;
}

// Call before new diaries and each poll: the watermark closes the save/enqueue
// crash gap without re-scoring all historical diaries. Explicit segmentIds are
// reserved for verified pre-upgrade failures; completed jobs remain idempotent.
export function recoverDiaryIntimacyJobs({ store, diaryPath, inboxPath, accountId, groupIds,
  segmentIds = [], now = Date.now() }) {
  const key = `diary_recovery_started:${accountId}`;
  store.db.prepare('INSERT OR IGNORE INTO intimacy_meta (key,value) VALUES (?,?)').run(key, new Date(now).toISOString());
  const since = store.db.prepare('SELECT value FROM intimacy_meta WHERE key=?').get(key).value;
  const diaries = new DatabaseSync(diaryPath, { readOnly: true });
  const inbox = new DatabaseSync(inboxPath, { readOnly: true });
  let queued = 0;
  try {
    const segments = diaries.prepare(`SELECT id,group_id,title,summary,source_ids_json FROM segments
      WHERE account_id=? AND (created_at>=? ${segmentIds.length ? `OR id IN (${segmentIds.map(() => '?').join(',')})` : ''})
      ORDER BY created_at,id`).all(accountId, since, ...segmentIds);
    const find = inbox.prepare('SELECT message FROM inbox WHERE id=?');
    for (const segment of segments) {
      if (!groupIds.includes(segment.group_id) || store.db.prepare(`SELECT 1 FROM intimacy_jobs
        WHERE account_id=? AND group_id=? AND segment_id=?`).get(accountId, segment.group_id, segment.id)) continue;
      const batch = JSON.parse(segment.source_ids_json).map(id => {
        let raw;
        try { raw = JSON.parse(find.get(id)?.message); } catch { /* checked before inference */ }
        return { id, senderId: raw?.userId, text: raw?.text, at: raw?.eventTime };
      });
      if (batch.some(item => !item.senderId || typeof item.text !== 'string')) continue;
      enqueueIntimacy({ store, accountId, groupId: segment.group_id, batch,
        diary: segment, segmentId: segment.id, now });
      queued++;
    }
  } finally { inbox.close(); diaries.close(); }
  return queued;
}
