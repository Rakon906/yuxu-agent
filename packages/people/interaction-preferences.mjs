import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DEFAULT_ALIASES = ['肥鱼不肥', '肥鱼', 'agent', 'SocioMem'];
const invalidated = value => !value || ['recall', 'recalled', 'revoked', 'deleted'].some(key => value[key]) ||
  ['recalled', 'revoked', 'deleted'].includes(String(value.state ?? '').toLowerCase());
const cleanId = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nameKey = value => value.normalize('NFKC').toLowerCase();
const future = /^(?:从今以后|从现在起|从此以后|今后|以后|往后)(?:都|一直)?\s*/u;
const temporary = /这次|此次|本次|今天|今晚|这回|暂时|现在先|先别|先不要|等会|一会儿|等一下|这几天/u;
const reported = /(?:他说|她说|他们说|你说|有人说|听说|据说|原话|转发|转述|引用|比如|例如|举例|假设|假如|如果|要是)|(?:说|表示|告诉)[：:]/u;
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const deny = '(?:不要|别|不用|不准|禁止)(?:再)?';
const allow = '(?:可以|允许|欢迎)(?:继续|再)?';
const voiceAction = '(?:(?:用)?语音(?:回复|回答|回|答复)我|(?:给|向)我(?:发|发送)语音(?:消息)?|(?:发|发送)语音(?:消息)?给我)';
const patAction = '拍(?:一拍)?我';
const mentionAction = '(?:主动)?(?:@|艾特|点名)我';
const boolPatterns = [
  ['voice', new RegExp(`^${deny}${voiceAction}(?:了)?$`, 'u'), new RegExp(`^${allow}${voiceAction}(?:了)?$`, 'u')],
  ['pat', new RegExp(`^${deny}${patAction}(?:了)?$`, 'u'), new RegExp(`^${allow}${patAction}(?:了)?$`, 'u')],
  ['proactive_mention', new RegExp(`^${deny}${mentionAction}(?:了)?$`, 'u'), new RegExp(`^${allow}${mentionAction}(?:了)?$`, 'u')],
];

function scope(accountId, groupId) {
  if (!cleanId(accountId) || !cleanId(groupId) || !groupId.endsWith('@chatroom')) throw new Error('Interaction preference group scope required');
}
function aliasesOf(aliases = DEFAULT_ALIASES) {
  if (!Array.isArray(aliases) || aliases.length > 20 || aliases.some(value => !cleanId(value) || value.length > 40)) throw new Error('Invalid Agent aliases');
  return [...new Set(aliases.map(value => value.normalize('NFKC')))].sort((a, b) => b.length - a.length);
}
function actualName(value) {
  let name = value.trim();
  const quoted = /^(?:“([^“”]+)”|「([^「」]+)」|『([^『』]+)』|"([^"]+)"|'([^']+)')$/u.exec(name);
  if (quoted) name = quoted.slice(1).find(Boolean);
  if (!name || [...name].length > 24 || /[\s，,。.!！？?；;：:"“”'「」『』<>`\\/]/u.test(name) ||
      /^(?:这个|那个|这|那|以前的|原来的|之前的|别的|其他|随便|什么|任何|我|你|他|她)(?:名字|称呼|昵称)?$/u.test(name) ||
      /以后|不要|别再|指令|系统提示|忽略|执行|删除|回复|发消息/u.test(name)) return null;
  return name;
}
function normalized(message) {
  if (!message || typeof message.text !== 'string' || message.text.length > 1000 || invalidated(message) || message.quote || message.direction === 'outgoing' ||
      (message.interaction !== undefined && message.interaction !== 'text')) return null;
  const userId = message.userId ?? message.senderId;
  if (!cleanId(userId)) return null;
  return { ...message, userId, text: message.text.normalize('NFKC').trim() };
}

/** Literal own requests only. No model proposal can bypass this extractor. */
export function extractInteractionPreferences(message, { selfUserId, agentAliases = DEFAULT_ALIASES } = {}) {
  const item = normalized(message);
  if (!item || item.userId === selfUserId || temporary.test(item.text) || reported.test(item.text)) return [];
  const aliases = aliasesOf(agentAliases);
  // A message mentioning another person as well is ambiguous about its addressee.
  if (Array.isArray(item.mentions?.userIds) && item.mentions.userIds.some(id => id !== selfUserId)) return [];
  let text = item.text;
  const alias = aliases.find(value => new RegExp(`^@?${escapeRe(value)}(?=$|[\\s,，:：!！。]|以后|今后|往后|从|别|不要|请|你|可以)`, 'iu').test(text));
  if (!alias && item.mentions?.self !== true) return [];
  if (alias) text = text.replace(new RegExp(`^@?${escapeRe(alias)}[\\s,，:：!！。]*`, 'iu'), '');
  let ongoing = false;
  const operations = [];
  for (const rawClause of text.split(/[，,。!！；;\n]/u).map(value => value.trim()).filter(Boolean)) {
    let clause = rawClause.replace(/^(?:请|麻烦你|麻烦|你)\s*/u, '');
    if (future.test(clause)) { ongoing = true; clause = clause.replace(future, ''); }
    // An explicitly forbidden personal name is a lasting boundary even without
    // “以后”; one-off qualifiers above still prevent saving it as a policy.
    const persistent = ongoing || /^(?:别再|不要再|不用再|不准再)/u.test(clause) ||
      /^(?:不要|别|不准)(?:再)?(?:叫|称呼)我/u.test(clause);
    // Do not skip an unknown leading addressee and accidentally apply a later
    // clause meant for another group member (even when the Agent was also @ed).
    if (!persistent) break;
    clause = clause.replace(/^(?:请|你)\s*/u, '').replace(/(?:吧|哦|啊|哈)$/u, '');
    let operation = null;
    const actionClause = clause.replace(/\s*@\s*/gu, '@');
    for (const [kind, negative, positive] of boolPatterns) {
      if (negative.test(actionClause)) operation = { kind, action: 'deny', name: null };
      else if (positive.test(actionClause)) operation = { kind, action: 'allow', name: null };
      if (operation) break;
    }
    if (!operation) {
      const blocked = /^(?:不要|别|不准)(?:再)?(?:叫|称呼)我(.+?)(?:了)?$/u.exec(clause);
      const unblocked = /^(?:可以|允许)(?:继续|再)?(?:叫|称呼)我(.+?)(?:了)?$/u.exec(clause);
      const preferred = /^(?:就)?(?:叫|称呼)我(.+?)(?:就行|就好)?$/u.exec(clause);
      const match = blocked ?? unblocked ?? preferred;
      const name = match ? actualName(match[1]) : null;
      if (name) operation = { kind: preferred && !blocked && !unblocked ? 'preferred_name' : 'blocked_name',
        action: blocked ? 'deny' : unblocked ? 'allow' : 'set', name };
      else if (/^(?:不用|不必)专门给我起昵称(?:了)?$/u.test(clause)) operation = { kind: 'preferred_name', action: 'clear', name: null };
    }
    if (operation) operations.push({ ...operation, evidenceQuote: rawClause });
    else break;
    if (operations.length >= 12) break;
  }
  return operations;
}

function openInbox(filename, accountId) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=5000');
    if (db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) throw new Error('Interaction preference Inbox account mismatch');
    return db;
  } catch (error) { db.close(); throw error; }
}
function source(row, accountId, groupId) {
  if (!row) return null;
  let item;
  try { item = JSON.parse(row.message); } catch { return null; }
  const at = item.eventTime ?? item.recordedAt;
  if (item.accountId !== accountId || item.groupId !== groupId || item.sourceMessageId !== row.id || !cleanId(item.userId) ||
      !Number.isFinite(Date.parse(at)) || !normalized(item)) return null;
  return { ...item, rowid: Number(row.rowid), at };
}
const sourceDigest = item => hash([item.accountId, item.groupId, item.sourceMessageId, item.userId, item.text,
  item.at, item.interaction ?? 'text', item.quote ?? null, item.mentions ?? null]);
const emptyPolicy = (accountId, groupId, userId) => ({ accountId, groupId, userId,
  voiceDisabled: false, patDisabled: false, proactiveMentionDisabled: false,
  blockedNames: [], preferredName: null, evidence: [], initialized: false });

export class InteractionPreferenceStore {
  constructor(filename) {
    filename = typeof filename === 'object' ? filename.filename : filename;
    if (typeof filename !== 'string' || !filename.trim()) throw new Error('Interaction preference database path required');
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS interaction_preference_scopes (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, inbox_path TEXT NOT NULL,
        self_id TEXT NOT NULL, aliases_json TEXT NOT NULL, cursor INTEGER NOT NULL,
        initialized_at INTEGER NOT NULL, PRIMARY KEY(account_id,group_id));
      CREATE TABLE IF NOT EXISTS interaction_preference_events (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, subject_id TEXT NOT NULL,
        source_id TEXT NOT NULL, source_rowid INTEGER NOT NULL, source_at INTEGER NOT NULL,
        source_digest TEXT NOT NULL, ordinal INTEGER NOT NULL, kind TEXT NOT NULL,
        action TEXT NOT NULL, name TEXT, quote TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,group_id,source_id,ordinal));
      CREATE INDEX IF NOT EXISTS interaction_preference_subject ON interaction_preference_events(account_id,group_id,subject_id,source_at,source_rowid);`);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  /** First run deliberately seeds the current end. All writes stay in this store. */
  collect({ accountId, groupId, inboxPath, selfUserId, agentAliases, now = Date.now(), limit = 512 }) {
    scope(accountId, groupId);
    if (!Number.isFinite(now) || !Number.isInteger(limit) || limit < 1 || limit > 4096) throw new Error('Invalid interaction preference collection limit');
    const prior = this.db.prepare('SELECT * FROM interaction_preference_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
    const selfId = selfUserId ?? prior?.self_id;
    if (!cleanId(selfId)) throw new Error('Interaction preference self identity required');
    const aliases = aliasesOf(agentAliases ?? (prior ? JSON.parse(prior.aliases_json) : DEFAULT_ALIASES));
    const path = resolve(inboxPath ?? prior?.inbox_path ?? '');
    if (!inboxPath && !prior) throw new Error('Interaction preference Inbox path required');
    if (prior && (prior.inbox_path !== path || prior.self_id !== selfId)) throw new Error('Interaction preference source binding changed');
    const inbox = openInbox(path, accountId);
    try {
      const latest = Number(inbox.prepare("SELECT COALESCE(MAX(rowid),0) AS value FROM inbox WHERE json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?").get(accountId, groupId).value);
      if (!prior) {
        this.db.prepare('INSERT INTO interaction_preference_scopes VALUES (?,?,?,?,?,?,?)').run(accountId, groupId, path, selfId, JSON.stringify(aliases), latest, now);
        return { initialized: true, processed: 0, created: 0, cursor: latest, pending: false };
      }
      if (latest < prior.cursor) throw new Error('Interaction preference Inbox was replaced or truncated');
      const rows = inbox.prepare("SELECT rowid,id,message FROM inbox WHERE rowid>? AND json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=? ORDER BY rowid LIMIT ?")
        .all(prior.cursor, accountId, groupId, limit);
      let created = 0;
      this.transaction(() => {
        const insert = this.db.prepare('INSERT OR IGNORE INTO interaction_preference_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
        for (const row of rows) {
          const item = source(row, accountId, groupId);
          if (!item || item.userId === selfId) continue;
          const at = Date.parse(item.at);
          // Do not activate old catch-up history inserted after installation.
          if (at < prior.initialized_at - 60000 || at > now + 60000) continue;
          const operations = extractInteractionPreferences(item, { selfUserId: selfId, agentAliases: aliases });
          for (const [ordinal, operation] of operations.entries()) {
            created += Number(insert.run(accountId, groupId, item.userId, row.id, row.rowid, at, sourceDigest(item),
              ordinal, operation.kind, operation.action, operation.name, operation.evidenceQuote, now).changes);
          }
        }
        const cursor = rows.at(-1)?.rowid ?? prior.cursor;
        this.db.prepare('UPDATE interaction_preference_scopes SET cursor=?,aliases_json=? WHERE account_id=? AND group_id=?')
          .run(cursor, JSON.stringify(aliases), accountId, groupId);
      });
      const cursor = Number(rows.at(-1)?.rowid ?? prior.cursor);
      return { initialized: false, processed: rows.length, created, cursor, pending: cursor < latest };
    } finally { inbox.close(); }
  }
  /** Re-read before dispatch. refresh also consumes messages that arrived during model work. */
  effective({ accountId, groupId, userId, inboxPath, refresh = false, now = Date.now() }) {
    scope(accountId, groupId);
    if (!cleanId(userId)) throw new Error('Interaction preference subject required');
    let prior = this.db.prepare('SELECT * FROM interaction_preference_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
    const result = emptyPolicy(accountId, groupId, userId);
    if (!prior) return result;
    if (refresh) {
      const collected = this.collect({ accountId, groupId, inboxPath, now, limit: 4096 });
      if (collected.pending) throw new Error('Interaction preference backlog needs collection before dispatch');
      prior = this.db.prepare('SELECT * FROM interaction_preference_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
    }
    const path = resolve(inboxPath ?? prior.inbox_path);
    if (path !== prior.inbox_path) throw new Error('Interaction preference source binding changed');
    result.initialized = true;
    const inbox = openInbox(path, accountId);
    try {
      const getSource = inbox.prepare('SELECT rowid,id,message FROM inbox WHERE id=?');
      const events = this.db.prepare('SELECT * FROM interaction_preference_events WHERE account_id=? AND group_id=? AND subject_id=? ORDER BY source_at,source_rowid,ordinal')
        .all(accountId, groupId, userId);
      const blocked = new Map(), sources = new Map();
      const evidence = new Map();
      for (const event of events) {
        if (!sources.has(event.source_id)) sources.set(event.source_id, source(getSource.get(event.source_id), accountId, groupId));
        const item = sources.get(event.source_id);
        if (!item || item.userId !== userId || item.rowid !== event.source_rowid || sourceDigest(item) !== event.source_digest) continue;
        if (event.kind === 'voice') result.voiceDisabled = event.action === 'deny';
        else if (event.kind === 'pat') result.patDisabled = event.action === 'deny';
        else if (event.kind === 'proactive_mention') result.proactiveMentionDisabled = event.action === 'deny';
        else if (event.kind === 'blocked_name') {
          if (event.action === 'deny') {
            blocked.set(nameKey(event.name), event.name);
            if (result.preferredName && nameKey(result.preferredName) === nameKey(event.name)) result.preferredName = null;
          } else blocked.delete(nameKey(event.name));
        } else if (event.kind === 'preferred_name') {
          result.preferredName = event.action === 'clear' ? null : event.name;
          if (event.name) blocked.delete(nameKey(event.name));
        }
        const key = `${event.kind}:${event.kind === 'blocked_name' ? nameKey(event.name) : ''}`;
        evidence.set(key, { sourceMessageId: event.source_id, userId, kind: event.kind, action: event.action,
          name: event.name, quote: event.quote, at: new Date(event.source_at).toISOString() });
      }
      result.blockedNames = [...blocked.values()];
      result.evidence = [...evidence.values()];
      return result;
    } finally { inbox.close(); }
  }
}
