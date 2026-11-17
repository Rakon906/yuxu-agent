import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readInbox } from '../diary/index.mjs';
import { resolveLifeEventDate } from '../life-events/index.mjs';

const DAY = 86400000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const speakerKey = id => `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}`;
const clean = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\u0000-\u001f]/u.test(value);
const revoked = value => ['recall', 'recalled', 'revoked', 'deleted'].some(key => value?.[key]) ||
  ['recalled', 'revoked', 'deleted'].includes(value?.state);
const digestSource = source => hash([source.senderId, source.at, source.text]);
const scope = (accountId, groupId) => {
  if (!clean(accountId) || !clean(groupId) || !groupId.endsWith('@chatroom')) throw new Error('Social context scope required');
};
const report = /(?:他说|她说|别人说|朋友说|听说|转发|引用|开玩笑|说着玩)|(?:说|表示|原话)[：:]|\S{1,20}说[，,：:]?(?:我|你|他|她|加我|算我|带我)|[“”「」『』"]|^\s*>/u;
const uncertain = /可能|也许|如果|假如|不确定|大概|要是|似乎|好像/u;
// Intent or deliberation is not a confirmed join/leave/reschedule, even if an
// otherwise affirmative verb appears later in the same original message.
const activityUncertain = /不一定|未决定|尚未|还没|没(?:有)?(?:决定|想好|定下来)|再说|看情况|考虑|再看看|待定|要不要|去不去|参不参加|能不能|可不可以|(?:想|打算|准备考虑).{0,4}(?:去|来|参加|加入|报名|打球|打游戏|打三角洲|退出|取消)|(?:去|来|参加|加入|报名|退出|取消).{0,3}(?:吗|么)[，,。！!？?]*$/u;
const topics = ['三角洲', '开黑', '羽毛球', '乒乓球', '篮球', '足球', '打球', '打游戏', '聚餐', '约饭', '聚会'];
const dates = /\d{4}(?:年\d{1,2}月\d{1,2}(?:日|号)?|-\d{1,2}-\d{1,2})|\d{1,2}月\d{1,2}(?:日|号)|大后天|后天|明天|今天|今晚|明晚|(?:(?:本|这|下)周|(?:本|这|下)?星期|周)[一二三四五六日天]/gu;
const times = /(?:(?:上午|早上|中午|下午|晚上|晚间))?[\d零一二两三四五六七八九十]{1,3}(?::\d{2}|点(?:半|\d{1,2}分?|[零一二两三四五六七八九十]{1,3}分)?)/gu;
const relationKinds = { 同学: 'classmate', 同事: 'colleague', 队友: 'teammate', 室友: 'roommate' };

function membersIndex(members) {
  if (!Array.isArray(members) || members.length > 2000) throw new Error('Known members required');
  const byId = new Map(), aliases = new Map();
  for (const member of members) {
    const id = member.userId ?? member.id;
    if (!clean(id)) continue;
    byId.set(id, member);
    for (const name of [id, speakerKey(id), member.displayName, member.name, member.wechatName, member.groupName,
      ...(Array.isArray(member.preferredNames) ? member.preferredNames : [])].filter(x => clean(x))) {
      const key = name.replace(/^@/u, '').trim().normalize('NFKC').toLowerCase();
      if (!aliases.has(key)) aliases.set(key, new Set());
      aliases.get(key).add(id);
    }
  }
  return { byId, aliases, resolve(name) {
    const ids = aliases.get(String(name).replace(/^@/u, '').trim().normalize('NFKC').toLowerCase());
    return ids?.size === 1 ? [...ids][0] : null;
  } };
}

function validSource(source, accountId, groupId, members) {
  return source && clean(source.id, 2000) && members.byId.has(source.senderId) && clean(source.text, 500) &&
    Number.isFinite(Date.parse(source.at)) && !revoked(source) && !source.quote &&
    (!source.interaction || source.interaction === 'text') && !report.test(source.text) &&
    (!source.accountId || source.accountId === accountId) && (!source.groupId || source.groupId === groupId);
}

function exactDate(text, at, fallbackDay = null) {
  const found = [...text.matchAll(dates)].map(x => x[0]);
  const clocks = [...text.matchAll(times)].map(x => x[0]);
  if (found.length > 1 || clocks.length > 1 || (!found.length && (!clocks.length || !fallbackDay))) return null;
  const dateText = found[0] ?? fallbackDay;
  const normalized = dateText === '今晚' ? '今天' : dateText === '明晚' ? '明天' : dateText;
  let timeText = clocks[0] ?? null;
  if (timeText && /^(今|明)晚$/u.test(dateText) && !/^(上午|早上|中午|下午|晚上|晚间)/u.test(timeText)) timeText = `晚上${timeText}`;
  try {
    const parsed = resolveLifeEventDate(normalized, at, { kind: 'gathering', timeText });
    return { eventAt: new Date(parsed.at).toISOString(), day: parsed.day, precise: parsed.precise,
      dateText, timeText };
  } catch { return null; }
}

function relationFrom(source, members) {
  if (uncertain.test(source.text) || /[?？]/u.test(source.text)) return null;
  const statement = source.text.trim().replace(/^[，,。\s]*(?:更正一下[，,：:]?|其实[，,]?|说错了[，,：:]?)/u, '');
  const match = /^我(?:和|跟)(.+?)(不再是|不是|是)(?:(?:大学|高中|初中|小学|以前的|以前|老|固定|游戏)\s*)?(同学|同事|队友|室友)(?:[，,。！!；;]|$)/u.exec(statement);
  if (!match) return null;
  if ((match[2] === '是' && /不是|不再是|不对|说错/u.test(statement)) ||
      (match[2] !== '是' && /(?:其实|应该)是/u.test(statement))) return null;
  const otherId = members.resolve(match[1]);
  if (!otherId || otherId === source.senderId) return null;
  return { type: 'relationship', action: match[2] === '是' ? 'assert' : 'deny',
    otherId, relationType: relationKinds[match[3]] };
}

function activityFrom(source, activities, requestedId = null) {
  const text = source.text.trim();
  if (uncertain.test(text) || activityUncertain.test(text) ||
      /我(?:的)?(?:朋友|同学|同事|室友|对象|爸爸|妈妈|哥哥|姐姐)/u.test(text)) return null;
  const mentionedDates = [...text.matchAll(dates)];
  if (mentionedDates.length > 1) return null;
  const matches = topics.filter(topic => text.includes(topic));
  // A specific term wins over its contained generic spelling; unrelated topics stay ambiguous.
  const uniqueTopics = matches.filter(topic => !matches.some(other => other !== topic && other.includes(topic)));
  if (uniqueTopics.length > 1) return null;
  const topic = uniqueTopics[0] ?? null;
  const sourceAt = Date.parse(source.at);
  const active = activities.filter(item => item.state === 'active' && Date.parse(item.eventAt) >= sourceAt - DAY &&
    (!topic || item.topic === topic));
  const choose = () => {
    const recent = active.filter(item => sourceAt >= Date.parse(item.createdAt) && sourceAt - Date.parse(item.lastSourceAt) <= 6 * 3600000);
    // A model ID cannot disambiguate a bare "我也去" when multiple activities fit.
    let options = topic ? active : recent;
    if (mentionedDates.length && ['join', 'leave'].includes(action)) {
      const specified = exactDate(text, source.at);
      if (!specified) return null;
      options = options.filter(item => item.day === specified.day);
    }
    if (options.length !== 1) return null;
    return requestedId && requestedId !== options[0].id ? null : options[0];
  };
  let action = null;
  if (/(?:取消|解散|不办了)/u.test(text)) action = 'cancel';
  else if (/改到|改成|改为|推迟到|提前到/u.test(text)) action = 'reschedule';
  else if (/(?:我|本人).{0,6}(?:不去|不来|不参加|退出|不打了)/u.test(text)) action = 'leave';
  else if (/(?:我|本人).{0,6}(?:也去|也来|参加|报名|加入|去|来|打)|(?:加我|算我一个|带我一个)(?:[，,。！!\s]|$)/u.test(text)) action = 'join';
  if (action) {
    const target = choose();
    if (target) {
      if (['cancel', 'reschedule'].includes(action) && source.senderId !== target.organizerId) return null;
      if (/不是|不取消|别取消|不要取消|不改|别改|不要改|[?？]/u.test(text)) return null;
      const date = action === 'reschedule' ? exactDate(text, source.at, target.day) : null;
      if (action === 'reschedule' && !date) return null;
      if (date && (Date.parse(date.eventAt) < sourceAt - DAY || Date.parse(date.eventAt) > sourceAt + 90 * DAY)) return null;
      return { type: 'activity', action, activityId: target.id, ...(date ?? {}) };
    }
    if (action !== 'join') return null;
  }
  if (!topic || requestedId || /不去|不来|不参加|退出|不打|取消|改到|改成|改为/u.test(text) ||
      !/(?:一起|约|组队|有人|谁来|谁打|谁去|集合|定了|我|本人)/u.test(text)) return null;
  const date = exactDate(text, source.at);
  if (!date || Date.parse(date.eventAt) < sourceAt - DAY || Date.parse(date.eventAt) > sourceAt + 90 * DAY) return null;
  return { type: 'activity', action: 'create', topic, ...date };
}

/** Host-bound source ledger. Model proposals select interpretations; never invent evidence or identities. */
export class SocialContextStore {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS social_scopes(account_id TEXT NOT NULL,group_id TEXT NOT NULL,
        cursor INTEGER,revision INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(account_id,group_id));
      CREATE TABLE IF NOT EXISTS social_operations(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,
        account_id TEXT NOT NULL,group_id TEXT NOT NULL,type TEXT NOT NULL,source_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,source_at TEXT NOT NULL,source_digest TEXT NOT NULL,evidence_quote TEXT NOT NULL,
        payload TEXT NOT NULL,valid INTEGER NOT NULL DEFAULT 1,invalid_reason TEXT,created_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS social_scope_sources ON social_operations(account_id,group_id,source_id);
      CREATE INDEX IF NOT EXISTS social_scope_seq ON social_operations(account_id,group_id,seq);`);
  }
  close() { this.db.close(); }
  ensure(accountId, groupId) {
    scope(accountId, groupId);
    this.db.prepare('INSERT OR IGNORE INTO social_scopes(account_id,group_id) VALUES (?,?)').run(accountId, groupId);
  }
  rows(accountId, groupId) {
    scope(accountId, groupId);
    return this.db.prepare('SELECT * FROM social_operations WHERE account_id=? AND group_id=? ORDER BY source_at,seq').all(accountId, groupId);
  }
  rebuild(accountId, groupId) {
    const activities = new Map(), relations = new Map();
    const all = this.rows(accountId, groupId);
    const revision = this.db.prepare('SELECT revision FROM social_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId)?.revision ?? 0;
    for (const row of all.filter(item => item.valid)) {
      const p = JSON.parse(row.payload), evidence = { sourceMessageId: row.source_id, speakerId: row.sender_id,
        at: row.source_at, quote: row.evidence_quote, action: p.action };
      if (p.type === 'activity') {
        if (p.action === 'create') {
          activities.set(p.activityId, { id: p.activityId, topic: p.topic, organizerId: row.sender_id,
            eventAt: p.eventAt, day: p.day, precise: p.precise, dateText: p.dateText, timeText: p.timeText,
            state: 'active', createdAt: row.source_at, lastSourceAt: row.source_at, revision,
            participants: [{ userId: row.sender_id, state: 'organizer' }], evidence: [evidence] });
          continue;
        }
        const activity = activities.get(p.activityId);
        if (!activity || activity.state !== 'active') continue;
        if (['cancel', 'reschedule'].includes(p.action) && activity.organizerId !== row.sender_id) continue;
        if (p.action === 'cancel') activity.state = 'cancelled';
        if (p.action === 'reschedule') Object.assign(activity, { eventAt: p.eventAt, day: p.day, precise: p.precise,
          dateText: p.dateText, timeText: p.timeText });
        if (['join', 'leave'].includes(p.action)) {
          activity.participants = activity.participants.filter(item => item.userId !== row.sender_id);
          activity.participants.push({ userId: row.sender_id, state: p.action === 'join' ? 'joined' : 'left' });
        }
        activity.evidence.push(evidence); activity.lastSourceAt = row.source_at;
      } else {
        const ids = [row.sender_id, p.otherId].sort();
        const key = hash([accountId, groupId, ids, p.relationType]);
        if (!relations.has(key)) relations.set(key, { id: key, userIds: ids, relationType: p.relationType,
          claims: new Map(), evidence: [], revision });
        const relation = relations.get(key);
        relation.claims.set(row.sender_id, { action: p.action, sourceMessageId: row.source_id });
        relation.evidence.push(evidence); relation.lastSourceAt = row.source_at;
      }
    }
    const relationships = [...relations.values()].map(({ claims, ...relation }) => {
      const assertions = [...claims].filter(([, p]) => p.action === 'assert').map(([id]) => id);
      const denials = [...claims].filter(([, p]) => p.action === 'deny').map(([id]) => id);
      return { ...relation, status: denials.length ? assertions.length ? 'disputed' : 'denied' :
        assertions.length === 2 ? 'mutually_confirmed' : 'self_reported', assertedBy: assertions, deniedBy: denials };
    });
    return { revision, activities: [...activities.values()], relationships };
  }
  ingest({ accountId, groupId, messages, knownMembers, proposals = [], extract = true, now = Date.now() }) {
    this.ensure(accountId, groupId);
    if (!Array.isArray(messages) || messages.length > 1000 || !Array.isArray(proposals) || proposals.length > 40 || !Number.isFinite(now)) throw new Error('Invalid social context batch');
    const members = membersIndex(knownMembers);
    const stats = { inserted: 0, duplicate: 0, rejected: 0 };
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const source of [...messages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
        if (!validSource(source, accountId, groupId, members)) continue;
        const suggested = proposals.filter(p => p?.sourceMessageId === source.id);
        const candidates = [...suggested, ...(extract ? [{ type: 'activity' }, { type: 'relationship' }] : [])];
        for (const proposed of candidates) {
          const modelProposal = proposed.sourceMessageId !== undefined;
          if (modelProposal && (Object.keys(proposed).some(key => !['type', 'action', 'sourceMessageId', 'evidenceQuote', 'activityId', 'otherSpeakerKey', 'relationType'].includes(key)) ||
              !clean(proposed.evidenceQuote, 500) || !proposed.evidenceQuote.trim() ||
              !source.text.includes(proposed.evidenceQuote))) { stats.rejected++; continue; }
          let p = proposed.type === 'relationship' ? relationFrom(source, members) : proposed.type === 'activity'
            ? activityFrom(source, this.rebuild(accountId, groupId).activities, proposed.activityId ?? null) : null;
          if (!p || (modelProposal && (proposed.action !== p.action ||
              (proposed.relationType && proposed.relationType !== p.relationType) ||
              (proposed.otherSpeakerKey && (!p.otherId || proposed.otherSpeakerKey !== speakerKey(p.otherId)))))) { if (modelProposal) stats.rejected++; continue; }
          const id = hash([accountId, groupId, source.id, p.type]);
          const existing = this.db.prepare('SELECT source_digest FROM social_operations WHERE id=?').get(id);
          if (existing) { stats.duplicate++; continue; }
          if (p.action === 'create') p = { ...p, activityId: `activity_${id.slice(0, 24)}` };
          this.db.prepare(`INSERT INTO social_operations(id,account_id,group_id,type,source_id,sender_id,
            source_at,source_digest,evidence_quote,payload,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
            id, accountId, groupId, p.type, source.id, source.senderId, source.at, digestSource(source), source.text.trim(), JSON.stringify(p), now);
          this.db.prepare('UPDATE social_scopes SET revision=revision+1 WHERE account_id=? AND group_id=?').run(accountId, groupId);
          stats.inserted++;
        }
      }
      this.db.exec('COMMIT'); return stats;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  applyProposals(options) { return this.ingest({ ...options, extract: false }); }
  maintain({ accountId, groupId, inboxPath }) {
    this.ensure(accountId, groupId);
    const inbox = new DatabaseSync(inboxPath, { readOnly: true }); let invalidated = 0, transaction = false;
    try {
      if (inbox.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) throw new Error('Social Inbox account mismatch');
      this.db.exec('BEGIN IMMEDIATE'); transaction = true;
      const get = inbox.prepare('SELECT message FROM inbox WHERE id=?');
      for (const row of this.rows(accountId, groupId).filter(item => item.valid)) {
        const original = get.get(row.source_id);
        let message;
        try { message = original && JSON.parse(original.message); } catch {}
        if (!message || message.accountId !== accountId || message.groupId !== groupId || message.sourceMessageId !== row.source_id ||
            message.userId !== row.sender_id || revoked(message) || message.quote ||
            (message.interaction && message.interaction !== 'text') || digestSource({ senderId: message.userId,
              at: message.eventTime ?? message.recordedAt, text: message.text }) !== row.source_digest) {
          invalidated += this.db.prepare("UPDATE social_operations SET valid=0,invalid_reason='source_changed_or_revoked' WHERE id=? AND valid=1").run(row.id).changes;
        }
      }
      if (invalidated) this.db.prepare('UPDATE social_scopes SET revision=revision+? WHERE account_id=? AND group_id=?').run(invalidated, accountId, groupId);
      this.db.exec('COMMIT'); transaction = false;
      return { invalidated };
    } catch (error) { if (transaction) this.db.exec('ROLLBACK'); throw error; }
    finally { inbox.close(); }
  }
  context({ accountId, groupId, userIds = [], query = '', inboxPath = null, knownMembers = [], now = Date.now(), limit = 8 }) {
    scope(accountId, groupId);
    if (!Array.isArray(userIds) || userIds.length > 30 || userIds.some(id => !clean(id)) ||
        typeof query !== 'string' || query.length > 200 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid social lookup');
    if (inboxPath) this.maintain({ accountId, groupId, inboxPath });
    const value = this.rebuild(accountId, groupId), members = membersIndex(knownMembers);
    const normalized = query.trim().normalize('NFKC').toLowerCase();
    const mentionedTopics = topics.filter(topic => normalized.includes(topic));
    const mentionedMembers = new Set();
    for (const [alias, ids] of members.aliases) {
      if (alias.length >= 2 && ids.size === 1 && normalized.includes(alias)) mentionedMembers.add([...ids][0]);
    }
    const mentionedRelations = Object.entries(relationKinds).filter(([name]) => normalized.includes(name)).map(([, type]) => type);
    let queryDay = null;
    if (normalized.includes('昨天')) queryDay = new Date(now + 8 * 3600000 - DAY).toISOString().slice(0, 10);
    else if (normalized.includes('前天')) queryDay = new Date(now + 8 * 3600000 - 2 * DAY).toISOString().slice(0, 10);
    else queryDay = exactDate(normalized, new Date(now).toISOString())?.day ?? null;
    const historical = /上次|之前|以前|过去|取消|上周/u.test(normalized);
    const specificActivity = mentionedTopics.length || mentionedMembers.size || queryDay || historical;
    const activities = value.activities.filter(item => (specificActivity || item.state === 'active') &&
      (specificActivity || Date.parse(item.eventAt) >= now - DAY) &&
      (!mentionedTopics.length || mentionedTopics.includes(item.topic)) &&
      (!mentionedMembers.size || item.participants.some(p => mentionedMembers.has(p.userId))) &&
      (!queryDay || item.day === queryDay))
      .sort((a, b) => Date.parse(b.lastSourceAt) - Date.parse(a.lastSourceAt)).slice(0, limit)
      .map(item => ({ ...item, evidence: item.evidence.slice(-12) }));
    const relevantUsers = mentionedMembers.size ? [...mentionedMembers] : userIds;
    const relationships = value.relationships.filter(item => (!relevantUsers.length || item.userIds.some(id => relevantUsers.includes(id))) &&
      (!mentionedRelations.length || mentionedRelations.includes(item.relationType)))
      .sort((a, b) => Date.parse(b.lastSourceAt) - Date.parse(a.lastSourceAt)).slice(0, limit)
      .map(item => ({ ...item, evidence: item.evidence.slice(-8) }));
    return { revision: value.revision, activities, relationships };
  }
}

/** Incremental local extraction also runs for chat that does not call the model. */
export function collectSocialContext({ store, inboxPath, accountId, groupId, knownMembers,
  startAtLatest = true, now = Date.now() }) {
  store.ensure(accountId, groupId);
  if (!membersIndex(knownMembers).byId.size) return { processed: 0, reason: 'roster_unavailable' };
  const row = store.db.prepare('SELECT cursor FROM social_scopes WHERE account_id=? AND group_id=?').get(accountId, groupId);
  if (row.cursor === null && startAtLatest) {
    const cursor = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0]?.rowid ?? 0;
    store.db.prepare('UPDATE social_scopes SET cursor=? WHERE account_id=? AND group_id=?').run(cursor, accountId, groupId);
    return { initialized: true, processed: 0 };
  }
  const messages = readInbox(inboxPath, { accountId, groupId, afterRowid: row.cursor ?? 0, limit: 256 });
  store.maintain({ accountId, groupId, inboxPath });
  if (!messages.length) return { processed: 0 };
  const result = store.ingest({ accountId, groupId, messages, knownMembers, now });
  store.db.prepare('UPDATE social_scopes SET cursor=? WHERE account_id=? AND group_id=?').run(messages.at(-1).rowid, accountId, groupId);
  return { processed: messages.length, result };
}
