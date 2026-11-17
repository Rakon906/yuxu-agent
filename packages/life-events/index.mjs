import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readTaskEvidence } from '../participation/tools.mjs';

const HOUR = 3600000, DAY = 24 * HOUR, ZONE = 8 * HOUR;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = (value, max = 200) => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const kinds = { interview: /面试/u, exam: /考试|考研|考公|答辩/u,
  travel: /旅行|旅游|出发|出游/u, gathering: /聚会|聚餐|约饭|集合|打球|打游戏/u,
  birthday: /生日/u, appointment: /预约|复查|体检|看医生|看病/u };
const revoked = item => !item || ['recall', 'recalled', 'revoked', 'deleted'].some(key => item[key]) ||
  ['recalled', 'revoked', 'deleted'].includes(item.state);
const sourceHash = item => hash([item.senderId, item.at, item.text]);
const localDate = at => new Date(at + ZONE).toISOString().slice(0, 10);
const localStart = at => Date.parse(`${localDate(at)}T00:00:00+08:00`);
const hourAt = (at, hour) => localStart(at) + hour * HOUR;
const iso = at => new Date(at).toISOString();
const scope = (accountId, groupId) => {
  if (!clean(accountId) || !clean(groupId) || !groupId.endsWith('@chatroom')) throw new Error('Life event scope required');
};
function validSource(source, accountId, groupId) {
  return !revoked(source) && clean(source.id) && clean(source.senderId) &&
    typeof source.text === 'string' && Number.isFinite(Date.parse(source.at)) &&
    (source.interaction === undefined || source.interaction === 'text') &&
    (!source.accountId || source.accountId === accountId) && (!source.groupId || source.groupId === groupId);
}
function ownStatement(quote, kind = null) {
  return /我|本人/u.test(quote) &&
    (!kind || new RegExp(`(?:我|本人)[^，,。！？!?；;\\n]{0,45}(?:${kinds[kind].source})`, 'u').test(quote)) &&
    !/(?:我(?:的)?)(?:朋友|同学|同事|室友|对象|爸爸|妈妈|爸|妈|老婆|老公|哥哥|姐姐|弟弟|妹妹)|我(?:听说|听|看到|看见|觉得|猜|想问|祝|希望|问|提醒)|(?:陪|替|帮).{0,12}(?:面试|考试|答辩|复查|体检)|(?:他说|她说|你说)|可能|也许|如果|假如|不确定|大概|要是|要不要|有没有|[?？]/u.test(quote);
}
const reportedSpeech = source => source.quote || /(?:说|表示|原话)[：:]|转发|引用|[“”「」『』"]/u.test(source.text);
function calendarDate(year, month, day) {
  if (![year, month, day].every(Number.isInteger) || year < 2020 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const value = Date.UTC(year, month - 1, day) - ZONE;
  return localDate(value) === `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` ? value : null;
}
function number(word) {
  if (/^\d{1,2}$/u.test(word)) return Number(word);
  const digit = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (word === '十') return 10;
  if (word.includes('十')) { const [a, b] = word.split('十'); return (a ? digit[a] : 1) * 10 + (b ? digit[b] : 0); }
  return digit[word] ?? NaN;
}

/** Resolve only literal, unambiguous Gregorian dates, anchored to the source's Beijing day. */
export function resolveLifeEventDate(dateText, sourceAt, { kind, timeText = null } = {}) {
  if (!clean(dateText, 40) || !Number.isFinite(Date.parse(sourceAt))) throw new Error('Explicit event date required');
  const base = localStart(Date.parse(sourceAt));
  const year = new Date(base + ZONE).getUTCFullYear();
  let date = null, monthDay = null;
  if (/^(今天|明天|后天|大后天)$/u.test(dateText)) date = base + ['今天', '明天', '后天', '大后天'].indexOf(dateText) * DAY;
  else if (/^(?:(?:本|这|下)周|(?:本|这|下)?星期|周)[一二三四五六日天]$/u.test(dateText)) {
    const target = '一二三四五六日'.indexOf(dateText.at(-1).replace('天', '日'));
    const current = (new Date(base + ZONE).getUTCDay() + 6) % 7;
    const monday = base - current * DAY;
    date = monday + target * DAY + (dateText.startsWith('下') ? 7 * DAY : 0);
    if (/^(周|星期)/u.test(dateText) && date < base) date += 7 * DAY;
  } else {
    const full = /^(\d{4})[-年](\d{1,2})[-月](\d{1,2})(?:日|号)?$/u.exec(dateText);
    const short = /^(\d{1,2})月(\d{1,2})(?:日|号)$/u.exec(dateText);
    if (full) date = calendarDate(Number(full[1]), Number(full[2]), Number(full[3]));
    else if (short) {
      const month = Number(short[1]), day = Number(short[2]);
      date = calendarDate(year, month, day);
      if (kind === 'birthday') {
        monthDay = `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        for (let y = year; y < year + 9; y++) {
          const candidate = calendarDate(y, month, day);
          if (candidate !== null && candidate >= base) { date = candidate; break; }
        }
      }
    }
  }
  if (!Number.isFinite(date) || date === null) throw new Error('Unrecognized or impossible event date');
  let hour = null, minute = 0;
  if (timeText !== null && timeText !== undefined) {
    if (!clean(timeText, 30)) throw new Error('Invalid event time');
    const clock = /^(?:(上午|早上|中午|下午|晚上|晚间))?([\d零一二两三四五六七八九十]{1,3})(?::(\d{2})|点(?:(半)|([\d零一二两三四五六七八九十]{1,3})分?)?)$/u.exec(timeText);
    if (!clock) throw new Error('Unrecognized event time');
    hour = number(clock[2]); minute = clock[3] ? Number(clock[3]) : clock[4] ? 30 : clock[5] ? number(clock[5]) : 0;
    if (['下午', '晚上', '晚间'].includes(clock[1]) && hour < 12) hour += 12;
    if (clock[1] === '中午' && hour < 11) hour += 12;
    if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new Error('Impossible event time');
  }
  return { day: localDate(date), at: date + (hour ?? 0) * HOUR + minute * 60000,
    precise: hour !== null, monthDay };
}

function schedule(parsed, kind) {
  let dueAt;
  if (kind === 'birthday') dueAt = hourAt(parsed.at, 12.5);
  else if (parsed.precise) dueAt = parsed.at + (kind === 'travel' ? 24 : 2) * HOUR;
  else dueAt = hourAt(parsed.at + (kind === 'travel' ? DAY : 0), 18.5);
  const localHour = (dueAt + ZONE) % DAY / HOUR;
  if (localHour < 12) dueAt = hourAt(dueAt, 12.5);
  else if (localHour >= 23.5) dueAt = hourAt(dueAt + DAY, 12.5);
  const expiresAt = kind === 'birthday' ? localStart(parsed.at) + DAY : localStart(dueAt) + 2 * DAY;
  return { eventAt: parsed.at, dueAt, expiresAt, occurrence: parsed.day,
    repeatRule: kind === 'birthday' && parsed.monthDay ? `yearly:${parsed.monthDay}` : null };
}

const datePattern = /\d{4}(?:年\d{1,2}月\d{1,2}(?:日|号)?|-\d{1,2}-\d{1,2})|\d{1,2}月\d{1,2}(?:日|号)|大后天|后天|明天|今天|(?:(?:本|这|下)周|(?:本|这|下)?星期|周)[一二三四五六日天]/gu;
const timePattern = /(?:(?:上午|早上|中午|下午|晚上|晚间))?[\d零一二两三四五六七八九十]{1,3}(?::\d{2}|点(?:半|[\d零一二两三四五六七八九十]{1,3}分?)?)/gu;
const cancelPattern = /取消|不去了|不去|不考了|不考|不面试|不旅行|不旅游|不聚会|不聚餐|不约饭|不打球|不打游戏|不复查|不体检|延期|推迟/u;
const donePattern = /面试完|考完|考试结束|答辩完|回来了|回来啦|旅行结束|结束了|搞定了|已经完成/u;

/** Cheap conservative extraction; no new model request is made for quiet/ignored chat. */
export function extractLifeEventProposals(messages) {
  const proposals = [];
  for (const source of messages) {
    if (source.interaction && source.interaction !== 'text') continue;
    if (reportedSpeech(source)) continue;
    const quote = source.text?.trim();
    if (!clean(quote, 500) || !ownStatement(quote)) continue;
    const matchedKinds = Object.entries(kinds).filter(([, pattern]) => pattern.test(quote));
    if (matchedKinds.length !== 1) continue;
    const [kind, kindPattern] = matchedKinds[0];
    if (!ownStatement(quote, kind)) continue;
    const topic = quote.match(kindPattern)[0];
    const dateTexts = [...quote.matchAll(datePattern)].map(match => match[0]);
    const action = cancelPattern.test(quote) && !/改到|改成|推迟到|延期到/u.test(quote) ? 'cancel'
      : donePattern.test(quote) ? 'resolve' : 'upsert';
    if (action === 'upsert' && dateTexts.length !== 1) continue;
    if (action === 'upsert' && cancelPattern.test(quote) && !/改到|改成|推迟到|延期到/u.test(quote)) continue;
    if (action === 'upsert' && /(?:没有|不用|无需|不是).{0,8}(?:面试|考试|答辩|生日|旅行|旅游|聚会|聚餐|体检)/u.test(quote)) continue;
    const times = [...quote.matchAll(timePattern)].map(match => match[0]);
    if (times.length > 1) continue;
    proposals.push({ action, sourceMessageId: source.id, kind, topic, evidenceQuote: quote,
      ...(action === 'upsert' ? { dateText: dateTexts[0], timeText: times[0] ?? null } : {}) });
  }
  return proposals;
}

function publicEvent(row) {
  if (!row) return null;
  return { id: row.id, subjectId: row.subject_id, kind: row.kind, topic: row.topic,
    sourceMessageId: row.source_id, evidenceQuote: row.source_quote, sourceAt: row.source_at,
    eventAt: iso(row.event_at), dueAt: iso(row.due_at), expiresAt: iso(row.expires_at),
    occurrence: row.occurrence, repeatRule: row.repeat_rule, state: row.state,
    revision: row.revision, claimKey: row.claim_key, outboxKey: row.outbox_key,
    reason: row.reason, evaluations: row.evaluations, updatedAt: row.updated_at };
}

export class LifeEventStore {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS life_events (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, subject_id TEXT NOT NULL,
        kind TEXT NOT NULL, topic TEXT NOT NULL, source_id TEXT NOT NULL, source_quote TEXT NOT NULL,
        source_digest TEXT NOT NULL, source_at TEXT NOT NULL, date_text TEXT NOT NULL,
        event_at INTEGER NOT NULL, due_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        occurrence TEXT NOT NULL, repeat_rule TEXT, state TEXT NOT NULL DEFAULT 'pending',
        revision INTEGER NOT NULL DEFAULT 1, evaluations INTEGER NOT NULL DEFAULT 0,
        claim_key TEXT, outbox_key TEXT, reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS life_events_due ON life_events(account_id,group_id,state,due_at);
      CREATE TABLE IF NOT EXISTS life_event_evidence (
        event_id TEXT NOT NULL, source_id TEXT NOT NULL, action TEXT NOT NULL,
        source_digest TEXT NOT NULL, quote TEXT NOT NULL, recorded_at INTEGER NOT NULL,
        PRIMARY KEY(event_id,source_id,action));
      CREATE TABLE IF NOT EXISTS life_event_occurrences (
        event_id TEXT NOT NULL, occurrence TEXT NOT NULL, state TEXT NOT NULL,
        outbox_key TEXT, settled_at INTEGER NOT NULL, PRIMARY KEY(event_id,occurrence));`);
  }
  close() { this.db.close(); }
  transaction(callback) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = callback(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  row(accountId, groupId, id) {
    scope(accountId, groupId);
    return this.db.prepare('SELECT * FROM life_events WHERE account_id=? AND group_id=? AND id=?').get(accountId, groupId, id);
  }
  list({ accountId, groupId, states = ['pending'], limit = 12 }) {
    scope(accountId, groupId);
    if (!Array.isArray(states) || !states.length || states.length > 20 || states.some(s => !clean(s, 40)) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid life event selection');
    return this.db.prepare(`SELECT * FROM life_events WHERE account_id=? AND group_id=? AND state IN (${states.map(() => '?').join(',')}) ORDER BY due_at,id LIMIT ?`)
      .all(accountId, groupId, ...states, limit).map(publicEvent);
  }
  ingest({ accountId, groupId, messages, proposals = [], now = Date.now(), extract = true }) {
    scope(accountId, groupId);
    if (!Array.isArray(messages) || messages.length > 2000 || !Array.isArray(proposals) || proposals.length > 100 || !Number.isFinite(now)) throw new Error('Invalid life event input');
    const sources = new Map(messages.filter(item => validSource(item, accountId, groupId)).map(item => [item.id, item]));
    const candidates = [...proposals, ...(extract ? extractLifeEventProposals([...sources.values()]) : [])];
    const result = { created: 0, updated: 0, cancelled: 0, resolved: 0, duplicate: 0, rejected: [] };
    for (const proposal of candidates) {
      try {
        this.transaction(() => this.apply({ accountId, groupId, proposal, sources, now, result }));
      } catch (error) { result.rejected.push({ sourceMessageId: proposal?.sourceMessageId ?? null, reason: error.message }); }
    }
    return result;
  }
  apply({ accountId, groupId, proposal: p, sources, now, result }) {
    const source = sources.get(p?.sourceMessageId);
    if (!source || reportedSpeech(source) || !['upsert', 'cancel', 'resolve'].includes(p.action) || !Object.hasOwn(kinds, p.kind) ||
        !clean(p.topic, 80) || !clean(p.evidenceQuote, 500) || !source.text.includes(p.evidenceQuote) ||
        !p.evidenceQuote.includes(p.topic) || !kinds[p.kind].test(p.evidenceQuote) || !ownStatement(p.evidenceQuote, p.kind) ||
        !ownStatement(source.text, p.kind) ||
        (p.subjectId !== undefined && p.subjectId !== source.senderId) ||
        /sk-[A-Za-z0-9_-]{12,}|\b\d{11,19}\b/u.test(p.evidenceQuote)) throw new Error('Life event needs literal own evidence');
    const sourceAt = Date.parse(source.at);
    if (sourceAt > now + 60000 || now - sourceAt > 2 * DAY) throw new Error('Life event source is stale');
    let previous = p.eventId ? this.row(accountId, groupId, p.eventId) : null;
    if (p.eventId && (!previous || previous.subject_id !== source.senderId || previous.kind !== p.kind)) throw new Error('Life event target mismatch');
    if (p.action !== 'upsert') {
      if (p.action === 'cancel' ? !cancelPattern.test(p.evidenceQuote) : !donePattern.test(p.evidenceQuote)) throw new Error('Explicit cancellation or outcome required');
      if (!previous) {
        const matching = this.db.prepare(`SELECT * FROM life_events WHERE account_id=? AND group_id=? AND subject_id=? AND kind=? AND state IN ('pending','sent','skipped') ORDER BY event_at DESC LIMIT 2`)
          .all(accountId, groupId, source.senderId, p.kind);
        if (matching.length !== 1) throw new Error('Ambiguous life event target');
        previous = matching[0];
      }
      if (sourceAt < Date.parse(previous.source_at)) throw new Error('Out-of-order life event update');
      if (p.action === 'resolve' && sourceAt < localStart(previous.event_at)) throw new Error('Outcome predates planned event');
      const state = p.action === 'cancel' ? 'cancelled' : 'resolved';
      if (this.db.prepare('SELECT 1 FROM life_event_evidence WHERE event_id=? AND source_id=? AND action=?').get(previous.id, source.id, p.action)) { result.duplicate++; return; }
      if (['dispatching', 'pending_receipt', 'needs_review'].includes(previous.state)) throw new Error('Life event send needs reconciliation');
      this.db.prepare('UPDATE life_events SET state=?,reason=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(state, 'explicit_own_update', now, previous.id);
      this.recordEvidence(previous.id, source, p.action, p.evidenceQuote, now);
      result[state]++;
      return;
    }
    if (!clean(p.dateText, 40) || !p.evidenceQuote.includes(p.dateText) ||
        (p.timeText != null && (!clean(p.timeText, 30) || !p.evidenceQuote.includes(p.timeText)))) throw new Error('Literal date/time evidence required');
    const quotedDates = [...new Set([...p.evidenceQuote.matchAll(datePattern)].map(match => match[0]))];
    if (quotedDates.length !== 1 || quotedDates[0] !== p.dateText) throw new Error('Event date must match the complete unambiguous literal');
    const quotedTimes = [...new Set([...p.evidenceQuote.matchAll(timePattern)].map(match => match[0]))];
    if (quotedTimes.length > 1 || (p.timeText != null && quotedTimes[0] !== p.timeText)) throw new Error('Ambiguous or truncated event time');
    if (/农历|阴历/u.test(p.evidenceQuote)) throw new Error('Lunar dates need a supported calendar');
    if (/(?:没有|不用|无需|不是).{0,8}(?:面试|考试|答辩|生日|旅行|旅游|聚会|聚餐|体检)/u.test(p.evidenceQuote)) throw new Error('Negative statements are not future commitments');
    if (donePattern.test(source.text)) throw new Error('Completed statements are not future commitments');
    if (cancelPattern.test(source.text) && !/改到|改成|推迟到|延期到/u.test(source.text)) throw new Error('Cancelled plans cannot be added');
    const parsed = resolveLifeEventDate(p.dateText, source.at, { kind: p.kind, timeText: p.timeText ?? quotedTimes[0] ?? null });
    const plan = schedule(parsed, p.kind);
    if (plan.eventAt < localStart(sourceAt) || plan.eventAt > now + (plan.repeatRule ? 8 * 366 : 366) * DAY || plan.expiresAt <= now) throw new Error('Life event date outside future window');
    if (cancelPattern.test(p.evidenceQuote) && !/改到|改成|推迟到|延期到/u.test(p.evidenceQuote)) throw new Error('Cancelled plans cannot be added');
    if (!previous && /改到|改成|推迟到|延期到/u.test(p.evidenceQuote)) {
      const matches = this.db.prepare(`SELECT * FROM life_events WHERE account_id=? AND group_id=? AND subject_id=? AND kind=? AND state='pending' LIMIT 2`)
        .all(accountId, groupId, source.senderId, p.kind);
      if (matches.length !== 1) throw new Error('Ambiguous rescheduled event');
      previous = matches[0];
    }
    // A model's longer topic wording and the cheap extractor must identify the
    // same occurrence, rather than produce two followups for one source.
    const literalTopic = p.evidenceQuote.match(kinds[p.kind])[0];
    const id = previous?.id ?? `life:${hash([accountId, groupId, source.senderId, p.kind, plan.repeatRule ?? plan.occurrence, literalTopic]).slice(0, 32)}`;
    const existing = this.row(accountId, groupId, id);
    if (existing && this.db.prepare('SELECT 1 FROM life_event_evidence WHERE event_id=? AND source_id=? AND action=?').get(id, source.id, 'upsert')) { result.duplicate++; return; }
    if (existing) {
      if (sourceAt < Date.parse(existing.source_at) || existing.state !== 'pending') throw new Error('Closed or out-of-order life event');
      this.db.prepare(`UPDATE life_events SET topic=?,source_id=?,source_quote=?,source_digest=?,source_at=?,date_text=?,
        event_at=?,due_at=?,expires_at=?,occurrence=?,repeat_rule=?,revision=revision+1,updated_at=?,reason='source_updated' WHERE id=?`)
        .run(p.topic, source.id, p.evidenceQuote, sourceHash(source), source.at, p.dateText,
          plan.eventAt, plan.dueAt, plan.expiresAt, plan.occurrence, plan.repeatRule, now, id);
      result.updated++;
    } else {
      this.db.prepare(`INSERT INTO life_events (id,account_id,group_id,subject_id,kind,topic,source_id,source_quote,
        source_digest,source_at,date_text,event_at,due_at,expires_at,occurrence,repeat_rule,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, accountId, groupId, source.senderId, p.kind, p.topic,
          source.id, p.evidenceQuote, sourceHash(source), source.at, p.dateText,
          plan.eventAt, plan.dueAt, plan.expiresAt, plan.occurrence, plan.repeatRule, now, now);
      result.created++;
    }
    this.recordEvidence(id, source, 'upsert', p.evidenceQuote, now);
  }
  recordEvidence(id, source, action, quote, now) {
    this.db.prepare(`INSERT OR IGNORE INTO life_event_evidence(event_id,source_id,action,source_digest,quote,recorded_at) VALUES (?,?,?,?,?,?)`)
      .run(id, source.id, action, sourceHash(source), quote, now);
  }
  maintain({ accountId, groupId, inboxPath, now = Date.now() }) {
    scope(accountId, groupId);
    const rows = this.db.prepare(`SELECT * FROM life_events WHERE account_id=? AND group_id=? AND
      (state IN ('pending','evaluating','dispatching','pending_receipt','needs_review') OR
        (repeat_rule IS NOT NULL AND state IN ('sent','skipped')))`)
      .all(accountId, groupId);
    const evidence = new Map();
    const ids = [...new Set(rows.map(row => row.source_id))];
    for (let offset = 0; offset < ids.length; offset += 500) {
      for (const [id, value] of readTaskEvidence(inboxPath, { accountId, groupId, ids: ids.slice(offset, offset + 500) })) evidence.set(id, value);
    }
    const result = { invalidated: 0, expired: 0, rolled: 0, uncertain: 0 };
    this.transaction(() => {
      for (const row of rows) {
        const source = evidence.get(row.source_id);
        if (!source || source.senderId !== row.subject_id || sourceHash(source) !== row.source_digest) {
          if (['dispatching', 'pending_receipt', 'needs_review'].includes(row.state)) {
            this.db.prepare("UPDATE life_events SET reason='source_changed_after_dispatch' WHERE id=?").run(row.id);
          } else {
            this.db.prepare("UPDATE life_events SET state='invalidated',reason='source_changed',updated_at=? WHERE id=?").run(now, row.id); result.invalidated++;
          }
          continue;
        }
        if (row.state === 'evaluating' && now - row.updated_at > 10 * 60000) {
          this.db.prepare("UPDATE life_events SET state='needs_review',reason='interrupted_evaluation',updated_at=? WHERE id=?").run(now, row.id); result.uncertain++; continue;
        }
        if (['dispatching', 'pending_receipt', 'needs_review', 'evaluating'].includes(row.state)) continue;
        if (row.expires_at > now) continue;
        if (row.repeat_rule?.startsWith('yearly:')) {
          const [month, day] = row.repeat_rule.slice(7).split('-').map(Number);
          const year = new Date(now + ZONE).getUTCFullYear();
          let next = null;
          for (let y = year; y < year + 9; y++) {
            const candidate = calendarDate(y, month, day);
            if (candidate !== null && candidate > localStart(now)) { next = candidate; break; }
          }
          if (next === null) continue;
          this.archive(row, now);
          const plan = schedule({ at: next, day: localDate(next), monthDay: row.repeat_rule.slice(7), precise: false }, 'birthday');
          this.db.prepare(`UPDATE life_events SET event_at=?,due_at=?,expires_at=?,occurrence=?,state='pending',
            claim_key=NULL,outbox_key=NULL,evaluations=0,revision=revision+1,reason='next_annual_occurrence',updated_at=? WHERE id=?`)
            .run(plan.eventAt, plan.dueAt, plan.expiresAt, plan.occurrence, now, row.id); result.rolled++;
        } else if (row.state === 'pending') {
          this.db.prepare("UPDATE life_events SET state='expired',reason='followup_window_elapsed',updated_at=? WHERE id=?").run(now, row.id); result.expired++;
        }
      }
    });
    return result;
  }
  archive(row, now) {
    this.db.prepare('INSERT OR IGNORE INTO life_event_occurrences(event_id,occurrence,state,outbox_key,settled_at) VALUES (?,?,?,?,?)')
      .run(row.id, row.occurrence, row.state === 'pending' ? 'expired' : row.state, row.outbox_key, now);
  }
  due({ accountId, groupId, now = Date.now(), limit = 3 }) {
    scope(accountId, groupId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid life event due limit');
    const localHour = (now + ZONE) % DAY / HOUR;
    if (localHour < 12 || localHour >= 24) return [];
    return this.db.prepare(`SELECT * FROM life_events WHERE account_id=? AND group_id=? AND state='pending' AND due_at<=? AND expires_at>? AND evaluations<2 ORDER BY due_at,id LIMIT ?`)
      .all(accountId, groupId, now, now, limit).map(publicEvent);
  }
  claim({ accountId, groupId, id, revision, inboxPath, now = Date.now() }) {
    const sourceRow = this.row(accountId, groupId, id);
    if (!sourceRow) return null;
    const source = readTaskEvidence(inboxPath, { accountId, groupId, ids: [sourceRow.source_id] }).get(sourceRow.source_id);
    if (!source || source.senderId !== sourceRow.subject_id || sourceHash(source) !== sourceRow.source_digest) return null;
    if ((now + ZONE) % DAY < 12 * HOUR) return null;
    const claimKey = `life-event:${hash([accountId, groupId, id, sourceRow.occurrence]).slice(0, 40)}`;
    return this.transaction(() => {
      const changed = this.db.prepare(`UPDATE life_events SET state='evaluating',claim_key=?,evaluations=evaluations+1,updated_at=?
        WHERE account_id=? AND group_id=? AND id=? AND revision=? AND state='pending' AND due_at<=? AND expires_at>? AND evaluations<2`)
        .run(claimKey, now, accountId, groupId, id, revision, now, now).changes;
      return changed ? publicEvent(this.row(accountId, groupId, id)) : null;
    });
  }
  defer({ accountId, groupId, id, claimKey, now = Date.now(), delayMs = 30 * 60000, reason = 'conversation_changed' }) {
    scope(accountId, groupId);
    if (!Number.isFinite(delayMs) || delayMs < 60000 || delayMs > DAY) throw new Error('Invalid life event deferral');
    this.db.prepare(`UPDATE life_events SET state=CASE WHEN evaluations>=2 OR expires_at<=? THEN 'skipped' ELSE 'pending' END,
      due_at=?,claim_key=NULL,reason=?,updated_at=? WHERE account_id=? AND group_id=? AND id=? AND state='evaluating' AND claim_key=? AND outbox_key IS NULL`)
      .run(now + delayMs, now + delayMs, reason, now, accountId, groupId, id, claimKey);
    return publicEvent(this.row(accountId, groupId, id));
  }
  beginDispatch({ accountId, groupId, id, claimKey, outboxKey, inboxPath, now = Date.now() }) {
    scope(accountId, groupId);
    if (!clean(outboxKey)) throw new Error('Life event outbox key required');
    const row = this.row(accountId, groupId, id);
    if (!row || row.state !== 'evaluating' || row.claim_key !== claimKey) return false;
    const source = readTaskEvidence(inboxPath, { accountId, groupId, ids: [row.source_id] }).get(row.source_id);
    if (!source || source.senderId !== row.subject_id || sourceHash(source) !== row.source_digest) {
      this.db.prepare("UPDATE life_events SET state='invalidated',reason='source_changed_before_send',updated_at=? WHERE id=? AND state='evaluating' AND claim_key=?")
        .run(now, id, claimKey);
      return false;
    }
    return Boolean(this.db.prepare(`UPDATE life_events SET state='dispatching',outbox_key=?,updated_at=?
      WHERE account_id=? AND group_id=? AND id=? AND state='evaluating' AND claim_key=? AND expires_at>?`)
      .run(outboxKey, now, accountId, groupId, id, claimKey, now).changes);
  }
  settle({ accountId, groupId, id, claimKey, state, reason = null, now = Date.now() }) {
    scope(accountId, groupId);
    if (!['sent', 'pending_receipt', 'needs_review', 'skipped'].includes(state)) throw new Error('Invalid life event settlement');
    this.db.prepare(`UPDATE life_events SET state=?,reason=?,updated_at=? WHERE account_id=? AND group_id=? AND id=? AND claim_key=?
      AND state IN ('evaluating','dispatching','pending_receipt','needs_review')`)
      .run(state, reason, now, accountId, groupId, id, claimKey);
    return publicEvent(this.row(accountId, groupId, id));
  }
  pendingReceipts({ accountId, groupId }) {
    return this.list({ accountId, groupId, states: ['dispatching', 'pending_receipt', 'needs_review'], limit: 100 }).filter(item => item.outboxKey);
  }
}
