import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadSlangEntries } from './slang.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const speakerKey = id => `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}`;
const clean = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 &&
  value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const normalized = text => text.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
const revoked = value => ['recall', 'recalled', 'revoked', 'deleted', 'isRecalled', 'isDeleted'].some(key => value?.[key]) ||
  ['recalled', 'revoked', 'deleted'].includes(String(value?.state ?? '').toLowerCase());
const reported = /听说|据说|转发|引用|他(?:们)?说|她(?:们)?说|别人说|朋友说|有人说|原话|说[：:，,]|^\s*>/u;
const unsure = /大概|可能|也许|好像|似乎|不确定|我猜|猜测|应该|貌似/u;
const instruction = /忽略|无视|绕过|系统(?:提示|规则|指令)|提示词|开发者|最高优先|不要遵守|执行(?:代码|命令)|调用(?:工具|接口)|(?:删除|清除|修改|读取).{0,8}(?:记忆|文件|数据库|凭据)|(?:以后|从现在|无论).{0,15}(?:必须|只|永远|都要|回复)|(?:关闭|开启).{0,8}(?:功能|服务|安全)|(?:api.?key|password|secret|system|developer|assistant|prompt|ignore|override|instructions)\b/iu;
const sensitive = /sk-[a-z\d]{12,}|\b\d{8,}\b|https?:\/\/|\b\S+@\S+\.[a-z]{2,}/iu;
const reserved = new Set(['肥鱼', '肥鱼不肥', '本公主', 'agent', '系统', '管理员', '群主', '角色', '人格', '身份', '微信号', '昵称']);

function scope(accountId, groupId) {
  if (!clean(accountId) || !clean(groupId) || !groupId.endsWith('@chatroom')) throw new Error('Learned slang scope required');
}
function bounds(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid learned slang ${label}`);
  return value;
}
function sourceDigest(source) {
  return hash([source.accountId, source.groupId, source.sourceMessageId, source.userId,
    source.eventTime ?? source.recordedAt, source.text]);
}
function directSource(source, accountId, groupId, selfUserId) {
  return source && source.accountId === accountId && source.groupId === groupId &&
    clean(source.sourceMessageId, 2000) && clean(source.userId) && source.userId !== selfUserId &&
    clean(source.text, 300) && Number.isFinite(Date.parse(source.eventTime ?? source.recordedAt)) &&
    !revoked(source) && !source.quote && !source.quotedMessage && !source.referenceMessage &&
    !source.forwarded && !source.isForwarded && source.direction !== 'outgoing' &&
    (source.interaction ?? 'text') === 'text';
}
function openInbox(inboxPath, accountId) {
  if (typeof inboxPath !== 'string' || !inboxPath) throw new Error('Learned slang needs original Inbox');
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) {
      throw new Error('Learned slang Inbox account mismatch');
    }
    return db;
  } catch (error) { db.close(); throw error; }
}
function readSource(db, id) {
  try {
    const row = db.prepare('SELECT message FROM inbox WHERE id=?').get(id);
    const value = row && JSON.parse(row.message);
    return value?.sourceMessageId === id ? value : null;
  } catch { return null; }
}
function unquote(value) {
  const text = value.trim();
  const pairs = [['“', '”'], ['「', '」'], ['『', '』'], ['"', '"'], ["'", "'"]];
  for (const [start, end] of pairs) if (text.startsWith(start) && text.endsWith(end)) return text.slice(start.length, -end.length).trim();
  return text;
}

/** Deliberately narrow: local definitions, never instructions or guessed expansions. */
export function extractSlangDefinition(text, { blockedTerms = [] } = {}) {
  if (!clean(text, 300) || reported.test(text) || instruction.test(text) || sensitive.test(text) ||
    /[?？]|是不是|啥意思|什么意思|不代表|不等于|开玩笑|说着玩|别当真/u.test(text)) return null;
  let body = text.trim().replace(/[。！!]+$/u, '');
  const corrects = /^(?:更正一下|纠正一下|刚才说错了)[，,：:]?/u.test(body);
  body = body.replace(/^(?:更正一下|纠正一下|刚才说错了|解释一下)[，,：:]?\s*/u, '')
    .replace(/^(?:在我们群里|我们群里|在群里|群里|这里)[，,：:]?\s*/u, '');
  let match = /^(.{2,28}?)(?:可能|大概|也许|好像|应该|貌似)?(不是|就是|是)(.{2,100}?)的意思$/u.exec(body);
  let surface, intended, stance = 'support', equals = false;
  if (match) { [, surface, , intended] = match; stance = match[2] === '不是' ? 'reject' : 'support'; }
  else if ((match = /^(.{2,28}?)(?:可能|大概|也许|好像|应该|貌似)?(?:指的是|的意思是)(.{2,100})$/u.exec(body))) {
    [, surface, intended] = match;
  } else if ((match = /^(.{2,28}?)\s*[=＝]\s*(.{2,100})$/u.exec(body))) {
    [, surface, intended] = match; equals = true;
  } else return null;
  const quotedSurface = surface.trim() !== unquote(surface);
  surface = unquote(surface); intended = unquote(intended.replace(/^(?:可能|大概|也许|好像|应该|貌似)(?:就是|是)?/u, ''));
  if (!clean(surface, 20) || !clean(intended, 80) || surface.length < 2 || intended.length < 2 ||
    /[\s“”「」『』"'=＝<>:{}\[\]@\\/]/u.test(surface) || /[“”「」『』"<>={}\[\]\\]/u.test(intended) ||
    /说|觉得|认为|表示|告诉|提到|朋友|同学|群友/u.test(surface) ||
    /^(?:我|你|他|她|它|我们|你们|他们)(?:是|的|在|会|要|能)/u.test(surface) ||
    /^\d+$/u.test(surface) || /^(?:wxid_|M_)/iu.test(surface) ||
    reserved.has(normalized(surface)) || blockedTerms.some(term => typeof term === 'string' && normalized(term) === normalized(surface)) ||
    !/[\p{L}]/u.test(intended) || instruction.test(`${surface} ${intended}`) || sensitive.test(`${surface} ${intended}`)) return null;
  // A bare Chinese assignment or arithmetic expression is not evidence of slang.
  if (equals && ((!/^[a-z][a-z\d_-]{1,19}$/iu.test(surface) && !quotedSurface) ||
    /[+*÷×]|^[-\d.\s]+$/u.test(intended) || !/\p{Script=Han}/u.test(intended))) return null;
  return { surface, intended, surfaceKey: normalized(surface), meaningKey: normalized(intended),
    stance, certainty: unsure.test(text) ? 'candidate' : 'explicit', corrects,
    kind: /^[a-z][a-z\d_-]+$/iu.test(surface) ? 'abbreviation' : 'group-expression' };
}

export class LearnedSlangStore {
  constructor(filename, { staticEntries, staticUrl } = {}) {
    mkdirSync(dirname(filename), { recursive: true });
    this.staticEntries = staticEntries; this.staticUrl = staticUrl;
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS learned_slang_scopes (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, cursor INTEGER,
        revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, started_at INTEGER,
        PRIMARY KEY(account_id,group_id));
      CREATE TABLE IF NOT EXISTS learned_slang_evidence (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
        source_id TEXT NOT NULL, speaker_id TEXT NOT NULL, source_at TEXT NOT NULL,
        source_digest TEXT NOT NULL, evidence_quote TEXT NOT NULL,
        surface TEXT NOT NULL, surface_key TEXT NOT NULL, intended TEXT NOT NULL, meaning_key TEXT NOT NULL,
        stance TEXT NOT NULL, certainty TEXT NOT NULL, corrects INTEGER NOT NULL, kind TEXT NOT NULL,
        valid INTEGER NOT NULL DEFAULT 1, invalid_reason TEXT, created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS slang_scope ON learned_slang_evidence(account_id,group_id,valid,surface_key);
      CREATE UNIQUE INDEX IF NOT EXISTS slang_source ON learned_slang_evidence(account_id,group_id,source_id);`);
    if (!this.db.prepare('PRAGMA table_info(learned_slang_scopes)').all().some(row => row.name === 'started_at')) {
      this.db.exec('ALTER TABLE learned_slang_scopes ADD COLUMN started_at INTEGER');
    }
  }
  close() { this.db.close(); }
  ensure(accountId, groupId) {
    scope(accountId, groupId);
    this.db.prepare('INSERT OR IGNORE INTO learned_slang_scopes(account_id,group_id) VALUES (?,?)').run(accountId, groupId);
  }
  protectedTerms(blockedTerms = []) {
    const entries = this.staticEntries ?? loadSlangEntries(this.staticUrl);
    return [...blockedTerms, ...entries.filter(entry => entry.status === 'confirmed')
      .flatMap(entry => [entry.surface, ...(entry.variants ?? [])])];
  }
  bump(accountId, groupId, now) {
    this.db.prepare('UPDATE learned_slang_scopes SET revision=revision+1,updated_at=? WHERE account_id=? AND group_id=?')
      .run(now, accountId, groupId);
  }
  ingest({ accountId, groupId, inboxPath, messages, selfUserId, blockedTerms = [], now = Date.now() }) {
    this.ensure(accountId, groupId);
    if (!Array.isArray(messages) || messages.length > 256 || !clean(selfUserId) || !Number.isFinite(now) ||
      !Array.isArray(blockedTerms) || blockedTerms.length > 10000) throw new Error('Invalid learned slang batch');
    const inbox = openInbox(inboxPath, accountId), stats = { inserted: 0, duplicate: 0, rejected: 0 };
    try {
      const protectedTerms = this.protectedTerms(blockedTerms);
      const startedAt = this.db.prepare('SELECT started_at FROM learned_slang_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId).started_at;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const item of messages) {
          const id = typeof item === 'string' ? item : item?.id ?? item?.sourceMessageId;
          if (!clean(id, 2000)) { stats.rejected++; continue; }
          const source = readSource(inbox, id);
          if (!directSource(source, accountId, groupId, selfUserId)) { stats.rejected++; continue; }
          // Offline catch-up may insert an old event after the new rowid cursor.
          if (startedAt !== null && Date.parse(source.eventTime ?? source.recordedAt) < startedAt) { stats.rejected++; continue; }
          // Optional proposed text/identity must agree with the original; proposals cannot rewrite evidence.
          if (typeof item === 'object' && ((item.accountId && item.accountId !== accountId) ||
            (item.groupId && item.groupId !== groupId) || (item.senderId && item.senderId !== source.userId) ||
            (item.text !== undefined && item.text !== source.text))) { stats.rejected++; continue; }
          const p = extractSlangDefinition(source.text, { blockedTerms: protectedTerms });
          if (!p) { stats.rejected++; continue; }
          const result = this.db.prepare(`INSERT OR IGNORE INTO learned_slang_evidence
            (id,account_id,group_id,source_id,speaker_id,source_at,source_digest,evidence_quote,
            surface,surface_key,intended,meaning_key,stance,certainty,corrects,kind,created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(hash([accountId, groupId, id]), accountId, groupId,
            id, source.userId, new Date(source.eventTime ?? source.recordedAt).toISOString(), sourceDigest(source), source.text,
            p.surface, p.surfaceKey, p.intended, p.meaningKey, p.stance, p.certainty, Number(p.corrects), p.kind, now);
          if (result.changes) stats.inserted++; else stats.duplicate++;
        }
        if (stats.inserted) this.bump(accountId, groupId, now);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return stats;
    } finally { inbox.close(); }
  }
  maintain({ accountId, groupId, inboxPath, now = Date.now() }) {
    this.ensure(accountId, groupId);
    if (!Number.isFinite(now)) throw new Error('Invalid learned slang time');
    const inbox = openInbox(inboxPath, accountId); let invalidated = 0;
    try {
      const rows = this.db.prepare('SELECT * FROM learned_slang_evidence WHERE account_id=? AND group_id=? AND valid=1').all(accountId, groupId);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        for (const row of rows) {
          const source = readSource(inbox, row.source_id);
          if (!directSource(source, accountId, groupId, null) || source.userId !== row.speaker_id || sourceDigest(source) !== row.source_digest) {
            invalidated += this.db.prepare("UPDATE learned_slang_evidence SET valid=0,invalid_reason='source_changed_or_revoked' WHERE id=? AND valid=1").run(row.id).changes;
          }
        }
        if (invalidated) this.bump(accountId, groupId, now);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      return { invalidated };
    } finally { inbox.close(); }
  }
  inspect({ scope: selectedScope, accountId = selectedScope?.accountId, groupId = selectedScope?.groupId,
    inboxPath, blockedTerms = [], now = Date.now() }) {
    if (!Array.isArray(blockedTerms) || blockedTerms.length > 10000 || blockedTerms.some(term => typeof term !== 'string')) {
      throw new Error('Invalid learned slang blocked terms');
    }
    this.maintain({ accountId, groupId, inboxPath, now });
    const protectedTerms = new Set(this.protectedTerms(blockedTerms).map(normalized));
    const rows = this.db.prepare(`SELECT * FROM learned_slang_evidence WHERE account_id=? AND group_id=? AND valid=1
      ORDER BY source_at,rowid`).all(accountId, groupId);
    const corrections = new Map();
    for (const row of rows) if (row.corrects && row.certainty === 'explicit') corrections.set(`${row.surface_key}\0${row.speaker_id}`, row);
    const grouped = new Map();
    for (const row of rows) {
      if (protectedTerms.has(row.surface_key)) continue;
      const correction = corrections.get(`${row.surface_key}\0${row.speaker_id}`);
      if (correction && correction !== row && correction.source_at >= row.source_at) continue;
      const key = `${row.surface_key}\0${row.meaning_key}`;
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(row);
    }
    const entries = [];
    for (const evidence of grouped.values()) {
      const explicit = evidence.filter(row => row.certainty === 'explicit' && row.stance === 'support');
      const candidates = evidence.filter(row => row.certainty === 'candidate' && row.stance === 'support');
      if (!explicit.length && !candidates.length) continue;
      const denied = evidence.filter(row => row.certainty === 'explicit' && row.stance === 'reject');
      const speakers = [...new Set(explicit.map(row => row.speaker_id))];
      const latest = (explicit.length ? explicit : candidates).at(-1);
      const selected = [...explicit, ...candidates, ...denied].sort((a, b) => b.source_at.localeCompare(a.source_at));
      const sourceEvidence = [], seen = new Set();
      for (const row of selected) {
        const identity = `${row.speaker_id}:${row.stance}:${row.certainty}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        sourceEvidence.push({ sourceMessageId: row.source_id, speakerId: row.speaker_id, speakerKey: speakerKey(row.speaker_id),
          at: row.source_at, quote: row.evidence_quote, stance: row.stance, certainty: row.certainty });
      }
      const status = !explicit.length ? 'candidate' : denied.length ? 'contested' : speakers.length >= 2 ? 'confirmed' : 'suggested';
      entries.push({ surface: latest.surface, intended: latest.intended, surfaceKey: latest.surface_key,
        kind: latest.kind, tone: null, status, ambiguous: denied.length > 0, confidence: `learned_${status}`,
        independentSpeakers: speakers.length, sourceCount: evidence.length,
        updatedAt: selected[0].source_at, evidence: sourceEvidence.slice(0, 4) });
    }
    for (const entry of entries) if (entries.some(other => other !== entry && other.surfaceKey === entry.surfaceKey &&
      other.status !== 'candidate' && entry.status !== 'candidate')) entry.ambiguous = true;
    const state = this.db.prepare('SELECT revision,updated_at FROM learned_slang_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
    return { revision: state.revision, updatedAt: state.updated_at, entries };
  }
  createAnnotator({ limit = 6, maxChars = 1600, includeSuggested = true, ...options }) {
    bounds(limit, 1, 20, 'limit'); bounds(maxChars, 200, 20000, 'budget');
    const snapshot = this.inspect(options);
    const entries = snapshot.entries.filter(entry => entry.status !== 'candidate' &&
      (includeSuggested || entry.status === 'confirmed')).sort((a, b) => b.surface.length - a.surface.length);
    const annotate = text => {
      if (typeof text !== 'string' || !text || text.length > 1000000) return [];
      const body = text.normalize('NFKC').toLowerCase(), compact = normalized(text), result = [];
      let used = 2;
      for (const entry of entries) {
        const surface = entry.surface.normalize('NFKC').toLowerCase();
        const matches = /^[a-z][a-z\d_-]+$/iu.test(surface)
          ? new RegExp(`(?:^|[^a-z\\d_])${surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^a-z\\d_])`, 'iu').test(body)
          : compact.includes(entry.surfaceKey);
        if (!matches) continue;
        const { surfaceKey, ...publicEntry } = entry;
        const item = { ...publicEntry,
          evidence: publicEntry.evidence.map(({ speakerId, ...publicEvidence }) => publicEvidence),
          note: entry.ambiguous ? '群友解释存在分歧或多个含义，请结合说话人和语境。' :
          entry.status === 'confirmed' ? '多名群友明确解释一致，仅作为本群用语参考。' : '这是一位群友的明确解释，尚非全群共识。' };
        const cost = JSON.stringify(item).length + (result.length ? 1 : 0);
        if (used + cost > maxChars) continue;
        result.push(item); used += cost;
        if (result.length >= limit) break;
      }
      return result;
    };
    annotate.revision = snapshot.revision; annotate.updatedAt = snapshot.updatedAt;
    return annotate;
  }
  annotate(text, options) { return this.createAnnotator(options)(text); }
}

/** Initial attachment marks the current scoped end; only later messages are learned. */
export function collectLearnedSlang({ store, inboxPath, accountId, groupId, selfUserId,
  blockedTerms = [], now = Date.now(), limit = 256 }) {
  bounds(limit, 1, 256, 'batch limit');
  if (!clean(selfUserId)) throw new Error('Learned slang self identity required');
  if (!Number.isFinite(now)) throw new Error('Invalid learned slang time');
  store.ensure(accountId, groupId);
  const inbox = openInbox(inboxPath, accountId);
  let messages;
  try {
    const prior = store.db.prepare('SELECT cursor,started_at FROM learned_slang_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
    if (prior.cursor === null) {
      const cursor = inbox.prepare(`SELECT COALESCE(MAX(rowid),0) cursor FROM inbox
        WHERE json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?`).get(accountId, groupId).cursor;
      store.db.prepare('UPDATE learned_slang_scopes SET cursor=?,started_at=COALESCE(started_at,?) WHERE account_id=? AND group_id=? AND cursor IS NULL')
        .run(cursor, now, accountId, groupId);
      return { initialized: true, processed: 0, cursor };
    }
    if (prior.started_at === null) store.db.prepare('UPDATE learned_slang_scopes SET started_at=? WHERE account_id=? AND group_id=? AND started_at IS NULL')
      .run(now, accountId, groupId);
    messages = inbox.prepare(`SELECT rowid,id FROM inbox WHERE rowid>? AND
      json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=? ORDER BY rowid LIMIT ?`)
      .all(prior.cursor, accountId, groupId, limit);
  } finally { inbox.close(); }
  const maintenance = store.maintain({ accountId, groupId, inboxPath, now });
  if (!messages.length) return { processed: 0, ...maintenance };
  const result = store.ingest({ accountId, groupId, inboxPath, selfUserId, blockedTerms, messages, now });
  const cursor = messages.at(-1).rowid;
  store.db.prepare('UPDATE learned_slang_scopes SET cursor=MAX(COALESCE(cursor,0),?) WHERE account_id=? AND group_id=?').run(cursor, accountId, groupId);
  return { processed: messages.length, result, cursor, ...maintenance };
}
