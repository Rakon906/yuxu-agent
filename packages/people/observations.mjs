import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (value, max = 200) => typeof value === 'string' && value.length > 0 &&
  value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const scope = (accountId, groupId) => {
  if (!text(accountId) || !text(groupId)) throw new Error('Observation scope is required');
};
const day = at => new Date(Date.parse(at) + 8 * 3600000).toISOString().slice(0, 10);
const categories = new Set(['identity', 'nickname', 'interest', 'preference', 'speaking_style',
  'activity_pattern', 'personality', 'relationship', 'general']);
const behavioralCategories = new Set(['speaking_style', 'activity_pattern', 'personality']);
const unsafeTrait = /政治|宗教|性取向|种族|民族|精神病|抑郁症|躁郁|自闭症|人格障碍|智商|情商|低能|蠢|自私|人品|外向|内向|冷漠|懒惰/u;
const concreteBehavior = /反问|短句|长句|解释|表情|玩笑|接话|提问|复述|回复|描述|称呼|口头禅|表达|安慰|鼓励|确认|询问|分享|讨论|提醒|帮助|道歉|承认|聊天|发言|上线/u;
function explicitPreference(quote, topic, stance) {
  if (/[？?]|开玩笑|说反话|才怪|哈哈|听说|他说|她说|有人说/u.test(quote)) return false;
  const topicAt = quote.indexOf(topic);
  const before = quote.slice(0, topicAt).split(/[，。！!；;\n]/u).at(-1);
  if (/不是不|并非不|没有不|不讨厌|(?:以前|过去|曾经)(?!.*现在)/u.test(before)) return false;
  const self = /(?:^|[，。！!；;\s])我(?:本人|自己|一直|平时|最近|现在|真的|最|很|挺|就|也|还|特别|比较|其实|还是|不再|已经|不|并不|不是)*[^，。！？!?；;]{0,8}(?:喜欢|偏爱|爱好|爱看|爱玩|爱吃|讨厌|不想|不爱)/u.test(before);
  const negative = /不喜欢|不爱|不想|讨厌|不再|并不|不是/u.test(before);
  return self && (stance === 'support' ? !negative : stance === 'reject' ? negative : false);
}
const usableSource = message => message && (message.interaction ?? 'text') === 'text' &&
  !sourceRevoked(message) && text(message.senderId) && typeof message.text === 'string' && Number.isFinite(Date.parse(message.at));
function sourceRevoked(message) {
  return ['recall', 'recalled', 'revoked', 'deleted'].some(key => Boolean(message?.[key])) ||
    ['recalled', 'revoked', 'deleted'].includes(String(message?.state ?? '').toLowerCase());
}

export function initializeObservations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS person_observations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
    subject_id TEXT NOT NULL, category TEXT NOT NULL, topic TEXT NOT NULL,
    source_message_id TEXT NOT NULL, source_at TEXT NOT NULL, evidence_quote TEXT NOT NULL,
    source_digest TEXT NOT NULL, segment_id TEXT NOT NULL, stance TEXT NOT NULL,
    corrects INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS observations_scope ON
      person_observations(account_id,group_id,subject_id,source_at);`);
}

/** Optional classification; labels remain revisable interpretations of verbatim self evidence. */
export function validatePersonObservation(value, event, messages) {
  if (value === undefined || value === null) return null;
  if (!value || typeof value !== 'object' || !text(value.subjectId) ||
      !categories.has(value.category) || !text(value.topic, 60) ||
      !['support', 'reject', 'uncertain'].includes(value.stance) ||
      (value.basis !== undefined && !['self_report', 'pattern'].includes(value.basis)) ||
      (value.corrects !== undefined && typeof value.corrects !== 'boolean')) {
    throw new Error('Invalid person observation');
  }
  const cited = new Set(event.sourceMessageIds);
  const own = messages.filter(item => cited.has(item.id) && usableSource(item) &&
    item.senderId === value.subjectId && item.text.includes(event.evidenceQuote));
  const behavioralPattern = value.basis === 'pattern' && behavioralCategories.has(value.category);
  if (!own.length || (!behavioralPattern && !event.evidenceQuote.includes(value.topic))) {
    throw new Error('Person observation needs literal self evidence and topic');
  }
  if (unsafeTrait.test(value.topic) || (behavioralPattern && !concreteBehavior.test(value.topic))) {
    throw new Error('Person observation must describe a concrete non-sensitive behavior');
  }
  if (value.basis === 'self_report' && (!['interest', 'preference'].includes(value.category) ||
      !explicitPreference(event.evidenceQuote, value.topic, value.stance))) {
    throw new Error('Self-reported preference needs an explicit non-joking first-person statement');
  }
  if (/sk-[A-Za-z0-9]{12,}|\b\d{11,19}\b/u.test(event.evidenceQuote)) {
    throw new Error('Person observation contains sensitive evidence');
  }
  return { subjectId: value.subjectId, category: value.category, topic: value.topic,
    stance: value.stance, corrects: value.corrects === true,
    ...(value.basis ? { basis: value.basis } : {}) };
}

/** Called inside DiaryStore.save's transaction. No extra model calls or permanent personality verdicts. */
export function accumulateDiaryObservations(db, { accountId, groupId, segmentId, events, messages }) {
  scope(accountId, groupId);
  if (!text(segmentId) || !Array.isArray(events) || !Array.isArray(messages)) throw new Error('Invalid observation batch');
  const byId = new Map(messages.map(item => [item.id, item]));
  let inserted = 0;
  for (const event of events) {
    if (!text(event.evidenceQuote) || /sk-[A-Za-z0-9]{12,}|\b\d{11,19}\b/u.test(event.evidenceQuote)) continue;
    const cited = [...new Set(event.sourceMessageIds ?? [])].map(id => byId.get(id))
      .filter(item => usableSource(item) && item.text.includes(event.evidenceQuote));
    const observation = validatePersonObservation(event.personObservation, event, messages);
    const owners = new Set(cited.map(item => item.senderId));
    // Do not attribute an event narrative to everyone who participated in it.
    if (!observation && owners.size !== 1) continue;
    for (const source of cited.filter(item => !observation || item.senderId === observation.subjectId)) {
      const category = observation?.category ?? 'general';
      const topic = observation?.topic ?? `quote:${digest(event.evidenceQuote).slice(0, 20)}`;
      const id = digest([accountId, groupId, source.senderId, source.id, category, topic]);
      const existing = db.prepare('SELECT source_digest,evidence_quote,state FROM person_observations WHERE id=?').get(id);
      const sourceDigest = digest([source.senderId, source.at, source.text]);
      if (existing && existing.source_digest !== sourceDigest) {
        // Edited/retracted original evidence must not silently keep an old profile active.
        db.prepare("UPDATE person_observations SET state='source_changed' WHERE id=?").run(id);
        continue;
      }
      inserted += db.prepare(`INSERT OR IGNORE INTO person_observations
        (id,account_id,group_id,subject_id,category,topic,source_message_id,source_at,
         evidence_quote,source_digest,segment_id,stance,corrects,kind,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, groupId, source.senderId,
        category, topic, source.id, source.at, event.evidenceQuote, sourceDigest, segmentId,
        observation?.stance ?? 'uncertain', observation?.corrects ? 1 : 0,
        observation?.basis === 'self_report' ? 'self_report'
          : observation?.basis === 'pattern' ? 'pattern_observation'
          : observation ? 'topic_observation' : 'observed_utterance', new Date().toISOString()).changes;
    }
  }
  return inserted;
}

function tableExists(db) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='person_observations'").get());
}

/** Only explicitly selected people in exactly one authorized account/group are returned. */
export function readObservationProfiles(diaryPath, { accountId, groupId, userIds, limitPerPerson = 6,
  inboxPath = null } = {}) {
  scope(accountId, groupId);
  if (!Array.isArray(userIds) || userIds.length > 30 || userIds.some(id => !text(id)) ||
      !Number.isInteger(limitPerPerson) || limitPerPerson < 1 || limitPerPerson > 12) throw new Error('Invalid observation selection');
  if (!diaryPath || !existsSync(diaryPath) || !userIds.length) return [];
  const db = new DatabaseSync(diaryPath, { readOnly: true });
  let inbox;
  try {
    if (!tableExists(db)) return [];
    if (inboxPath) {
      if (!existsSync(inboxPath)) return [];
      inbox = new DatabaseSync(inboxPath, { readOnly: true });
      if (inbox.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) {
        throw new Error('Observation Inbox account mismatch');
      }
    }
    const find = inbox?.prepare('SELECT message FROM inbox WHERE id=?');
    const profiles = [];
    for (const userId of new Set(userIds)) {
      const rows = db.prepare(`SELECT * FROM person_observations WHERE account_id=? AND group_id=?
        AND subject_id=? AND state='active' ORDER BY source_at DESC,id DESC LIMIT 300`).all(accountId, groupId, userId);
      const topics = new Map();
      for (const row of rows) {
        if (find) {
          const sourceRow = find.get(row.source_message_id);
          if (!sourceRow) continue;
          const source = JSON.parse(sourceRow.message);
          if (sourceRevoked(source) || source.accountId !== accountId || source.groupId !== groupId ||
              source.sourceMessageId !== row.source_message_id || source.userId !== userId ||
              (source.interaction ?? 'text') !== 'text' ||
              digest([source.userId, source.eventTime ?? source.recordedAt, source.text]) !== row.source_digest) continue;
        }
        const key = JSON.stringify([row.category, row.topic]);
        if (!topics.has(key)) topics.set(key, []);
        topics.get(key).push(row);
      }
      const person = [];
      for (const history of topics.values()) {
        const ordered = history.sort((a, b) => Date.parse(a.source_at) - Date.parse(b.source_at) || a.id.localeCompare(b.id));
        const correction = ordered.findLastIndex(row => row.corrects === 1);
        const current = correction < 0 ? ordered : ordered.slice(correction);
        const stances = new Set(current.map(row => row.stance));
        const days = new Set(current.map(row => day(row.source_at))).size;
        const messages = new Set(current.map(row => row.source_message_id)).size;
        const distinctQuotes = new Set(current.map(row => row.evidence_quote.normalize('NFKC').replace(/\s+/gu, ''))).size;
        const last = current.at(-1);
        const state = stances.has('support') && stances.has('reject') ? 'conflicted'
          : current[0].stance === 'reject' && current[0].corrects && !stances.has('support') ? 'withdrawn'
          : last.kind === 'observed_utterance' ? 'observed'
          : stances.size === 1 && stances.has('support') && days >= 2 && messages >= 3 ? 'repeated'
          : stances.size === 1 && !stances.has('uncertain') && current.some(row => row.kind === 'self_report') ? 'self_reported' : 'candidate';
        // Replaying the same wording cannot manufacture a stable personality/interest label.
        const supported = state === 'repeated' && distinctQuotes >= 2;
        const reported = !supported && ['self_reported', 'repeated'].includes(state) &&
          stances.size === 1 && !stances.has('uncertain') && current.some(row => row.kind === 'self_report');
        const trait = (supported || reported) &&
          ['interest', 'preference', 'speaking_style', 'activity_pattern', 'personality'].includes(last.category)
          ? { description: reported ? (last.stance === 'reject' ? `本人自述不喜欢「${last.topic}」` : `本人自述偏好「${last.topic}」`)
              : ['interest', 'preference'].includes(last.category) ? `多次表现出对「${last.topic}」的兴趣或偏好`
              : `多次观察到：${last.topic}`,
            basis: reported ? 'self_report' : 'repeated_evidence', polarity: last.stance, provisional: true } : null;
        const evidence = current.slice(-6).map(row => ({ id: row.id, sourceMessageId: row.source_message_id,
          speakerId: row.subject_id, at: row.source_at, quote: row.evidence_quote, segmentId: row.segment_id,
          stance: row.stance, corrects: row.corrects === 1 }));
        person.push({ subjectId: userId, category: last.category,
          topic: last.kind === 'observed_utterance' ? null : last.topic, kind: last.kind, state,
          trait,
          uncertainty: trait ? '有原话依据的当前印象，可随新证据修正，不是固定人格结论'
            : state === 'repeated' ? '重复的原话观察，仍不是确定性格或永久标签'
            : state === 'conflicted' ? '存在相互矛盾的原话，不据此下结论'
            : state === 'withdrawn' ? '本人已明确否定，不沿用此前观察'
            : '只是有来源的说过的话，不等于爱好、承诺或稳定特征',
          observedMessages: messages, observedDays: days, firstSeenAt: current[0].source_at,
          lastSeenAt: last.source_at, evidence });
      }
      const priority = item => item.trait ? 0 : ['conflicted', 'withdrawn'].includes(item.state) ? 1
        : item.state === 'candidate' ? 2 : 3;
      person.sort((a, b) => priority(a) - priority(b) || Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
      profiles.push(...person.slice(0, limitPerPerson));
    }
    return profiles;
  } finally { inbox?.close(); db.close(); }
}

/** Recheck originals while backfilling; do not rewrite old diaries or infer labels from their prose. */
export function backfillDiaryObservations({ diaryPath, inboxPath, accountId, groupId }) {
  scope(accountId, groupId);
  const inbox = new DatabaseSync(inboxPath, { readOnly: true });
  let db;
  try {
    if (inbox.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) {
      throw new Error('Observation Inbox account mismatch');
    }
    db = new DatabaseSync(diaryPath);
    db.exec('PRAGMA busy_timeout=5000');
    initializeObservations(db);
    const find = inbox.prepare('SELECT message FROM inbox WHERE id=?');
    const getSource = id => {
      const row = find.get(id);
      if (!row) return null;
      const item = JSON.parse(row.message);
      if (item.accountId !== accountId || item.groupId !== groupId || item.sourceMessageId !== id || sourceRevoked(item)) return null;
      return { id, senderId: item.userId, at: item.eventTime ?? item.recordedAt,
        text: item.text, interaction: item.interaction ?? 'text' };
    };
    let inserted = 0, retired = 0;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const row of db.prepare(`SELECT * FROM person_observations WHERE account_id=? AND group_id=? AND state='active'`).all(accountId, groupId)) {
        const source = getSource(row.source_message_id);
        if (!usableSource(source) || source.senderId !== row.subject_id ||
            digest([source.senderId, source.at, source.text]) !== row.source_digest) {
          retired += db.prepare("UPDATE person_observations SET state='source_changed' WHERE id=?").run(row.id).changes;
        }
      }
      for (const segment of db.prepare('SELECT id,events_json FROM segments WHERE account_id=? AND group_id=? ORDER BY end_rowid').all(accountId, groupId)) {
        const events = JSON.parse(segment.events_json);
        const messages = [...new Set(events.flatMap(event => event.sourceMessageIds ?? []))].map(getSource).filter(Boolean);
        // Legacy text is only an observation of a quoted utterance, never a new inferred fact.
        const safe = events.filter(event => messages.some(item => usableSource(item) && item.text.includes(event.evidenceQuote)))
          .map(event => {
            try { validatePersonObservation(event.personObservation, event, messages); return event; }
            catch { return { ...event, personObservation: null }; }
          });
        inserted += accumulateDiaryObservations(db, { accountId, groupId, segmentId: segment.id, events: safe, messages });
      }
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return { inserted, retired };
  } finally { db?.close(); inbox.close(); }
}
