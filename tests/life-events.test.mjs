import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { LifeEventStore, resolveLifeEventDate, extractLifeEventProposals } from '../packages/life-events/index.mjs';

const ACCOUNT = 'life-account', GROUP = 'life@chatroom';
const now = Date.parse('2026-11-13T13:00:00+08:00');
const scope = { accountId: ACCOUNT, groupId: GROUP };
function fixture(t) {
  const root = mkdtempSync(resolve('.runtime/test-tmp/life-events-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const source = new AdapterStore(inboxPath, ACCOUNT);
  let life = new LifeEventStore(join(root, 'life.sqlite'));
  let sequence = 0;
  const insert = (id, text, fields = {}) => {
    const raw = { platform: 'wechat', ...scope, userId: 'alice', sourceMessageId: id,
      text, eventTime: new Date(now).toISOString(), ...fields };
    source.commitEvent(String(++sequence), raw, 'fixture');
    return { id, senderId: raw.userId, text: raw.text, at: raw.eventTime,
      accountId: raw.accountId, groupId: raw.groupId, interaction: raw.interaction ?? 'text',
      ...(raw.recall ? { recall: raw.recall } : {}) };
  };
  const ingest = (message, options = {}) => life.ingest({ ...scope, messages: [message], now, ...options });
  const all = () => life.list({ ...scope, states: ['pending', 'evaluating', 'dispatching', 'sent', 'pending_receipt', 'needs_review', 'skipped', 'cancelled', 'resolved', 'invalidated', 'expired'] });
  t.after(() => { life.close(); source.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, source, inboxPath, insert, ingest, all,
    get life() { return life; }, restart() { life.close(); life = new LifeEventStore(join(root, 'life.sqlite')); } };
}

test('literal dates use source Beijing day, handle month/year/week boundaries and reject ambiguity', () => {
  const next = resolveLifeEventDate('明天', '2026-12-31T23:50:00+08:00', { kind: 'interview', timeText: '下午三点半' });
  assert.equal(new Date(next.at).toISOString(), '2027-01-01T07:30:00.000Z');
  assert.equal(resolveLifeEventDate('下周一', '2026-11-15T17:00:00+08:00', { kind: 'exam' }).day, '2026-11-16');
  assert.equal(resolveLifeEventDate('周一', '2026-11-13T17:00:00+08:00', { kind: 'exam' }).day, '2026-11-16');
  assert.equal(resolveLifeEventDate('12月1日', '2026-12-10T17:00:00+08:00', { kind: 'birthday' }).day, '2027-12-01');
  assert.equal(resolveLifeEventDate('2月29日', '2026-11-13T17:00:00+08:00', { kind: 'birthday' }).day, '2028-02-29');
  for (const date of ['周末', '下个月', '2026-02-30', '13月1日', '2026-11-31']) {
    assert.throws(() => resolveLifeEventDate(date, new Date(now).toISOString(), { kind: 'exam' }));
  }
  assert.throws(() => resolveLifeEventDate('明天', new Date(now).toISOString(), { kind: 'exam', timeText: '25:00' }));
});

test('clear own future events are recorded once even without a participation model call', t => {
  const f = fixture(t), message = f.insert('interview', '我明天下午三点面试，有点紧张');
  assert.equal(f.ingest(message).created, 1);
  assert.equal(f.ingest(message).duplicate, 1);
  const event = f.all()[0];
  assert.equal(event.subjectId, 'alice');
  assert.equal(event.eventAt, '2026-11-14T07:00:00.000Z');
  assert.equal(event.dueAt, '2026-11-14T09:00:00.000Z');
  assert.equal(event.evidenceQuote, message.text);
  assert.equal(f.life.due({ ...scope, now }).length, 0);
  assert.equal(f.life.due({ ...scope, now: Date.parse('2026-11-14T17:01:00+08:00') }).length, 1);
  assert.equal(f.life.due({ ...scope, now: Date.parse('2026-11-15T08:00:00+08:00') }).length, 0);
});

test('third-party, hypothetical, uncertain, multiple-date and voice statements do not become own events', t => {
  const f = fixture(t);
  const statements = ['我朋友明天面试', '小王明天面试，我祝他好运', '我明天陪小王面试',
    '我听说明天考试', '我明天可能去面试', '如果我明天面试就好了',
    '我明天面试吗？', '我明天或后天考试', '我农历11月14日生日', '我明天没有考试',
    '我明天不是生日', '小王说：“我明天面试”', '我的朋友说我明天面试'];
  for (const [index, text] of statements.entries()) assert.equal(f.ingest(f.insert(`no-${index}`, text)).created, 0, text);
  assert.equal(f.ingest(f.insert('voice', '我明天面试', { interaction: 'voice' })).created, 0);
  assert.equal(f.all().length, 0);
});

test('model proposals cannot change host scope, speaker, quote or invent a date', t => {
  const f = fixture(t), source = f.insert('source', '我明天考试');
  const base = { action: 'upsert', kind: 'exam', topic: '考试', sourceMessageId: source.id,
    evidenceQuote: source.text, dateText: '明天' };
  for (const patch of [{ subjectId: 'bob' }, { evidenceQuote: '我后天考试' }, { dateText: '后天' },
    { sourceMessageId: 'missing' }, { topic: '生日' }, { timeText: '上午九点' }]) {
    assert.equal(f.ingest(source, { extract: false, proposals: [{ ...base, ...patch }] }).created, 0);
  }
  const foreign = f.insert('foreign', '我明天考试', { groupId: 'other@chatroom' });
  assert.equal(f.ingest(foreign).created, 0);
  assert.equal(f.ingest(source, { extract: false, proposals: [base] }).created, 1);
  assert.equal(f.life.list({ accountId: ACCOUNT, groupId: 'other@chatroom' }).length, 0);
});

test('model phrasing and cheap extraction share one event key, and source context cannot be sliced away', t => {
  const f = fixture(t), source = f.insert('same', '我明天面试，有点紧张');
  const outcome = f.ingest(source, { proposals: [{ action: 'upsert', kind: 'interview', topic: '面试，有点紧张',
    sourceMessageId: source.id, evidenceQuote: source.text, dateText: '明天' }] });
  assert.equal(outcome.created, 1);
  assert.equal(outcome.duplicate, 1);
  const other = f.insert('report', '我的朋友说我明天面试');
  assert.equal(f.ingest(other, { extract: false, proposals: [{ action: 'upsert', kind: 'interview', topic: '面试',
    sourceMessageId: other.id, evidenceQuote: '我明天面试', dateText: '明天' }] }).created, 0);
  const fullYear = f.insert('future-year', '我2027年11月14日面试');
  assert.equal(f.ingest(fullYear, { extract: false, proposals: [{ action: 'upsert', kind: 'interview', topic: '面试',
    sourceMessageId: fullYear.id, evidenceQuote: fullYear.text, dateText: '11月14日' }] }).created, 0);
});

test('old imports and elapsed events are not replayed as fresh followups', t => {
  const f = fixture(t);
  assert.equal(f.ingest(f.insert('old', '我明天考试', { eventTime: '2026-11-01T13:00:00+08:00' })).created, 0);
  assert.equal(f.ingest(f.insert('past', '我11月1日考试')).created, 0);
  const message = f.insert('new', '我明天面试');
  f.ingest(message);
  const late = Date.parse('2026-11-18T14:00:00+08:00');
  assert.equal(f.life.due({ ...scope, now: late }).length, 0);
  assert.equal(f.life.maintain({ ...scope, inboxPath: f.inboxPath, now: late }).expired, 1);
  assert.equal(f.all()[0].state, 'expired');
});

test('explicit rescheduling keeps one event and cancellation is authoritative and idempotent', t => {
  const f = fixture(t);
  f.ingest(f.insert('initial', '我明天面试'));
  const original = f.all()[0];
  const changeAt = now + HOUR;
  const moved = f.insert('move', '我面试改到后天', { eventTime: new Date(changeAt).toISOString() });
  assert.equal(f.ingest(moved, { now: changeAt }).updated, 1);
  const changed = f.all()[0];
  assert.equal(changed.id, original.id);
  assert.equal(changed.occurrence, '2026-11-15');
  assert.equal(changed.revision, 2);
  const cancel = f.insert('cancel', '我的面试取消了', { eventTime: new Date(changeAt + 1).toISOString() });
  assert.equal(f.ingest(cancel, { now: changeAt + 1 }).cancelled, 1);
  assert.equal(f.ingest(cancel, { now: changeAt + 1, extract: false, proposals: [{ action: 'cancel', eventId: changed.id,
    kind: 'interview', topic: '面试', sourceMessageId: cancel.id, evidenceQuote: cancel.text }] }).duplicate, 1);
  assert.equal(f.all()[0].state, 'cancelled');
});

const HOUR = 3600000;
test('own outcome stops followup, but a result before the planned event cannot close it', t => {
  const f = fixture(t);
  f.ingest(f.insert('exam', '我明天考试'));
  const early = f.insert('early-result', '我考试结束了');
  assert.equal(f.ingest(early).resolved, 0);
  const later = now + 24 * HOUR;
  const result = f.insert('result', '我今天考试结束了', { eventTime: new Date(later).toISOString() });
  assert.equal(f.ingest(result, { now: later }).resolved, 1);
  assert.equal(f.life.due({ ...scope, now: later + 8 * HOUR }).length, 0);
});

test('withdrawn or edited original evidence invalidates followup before model or dispatch', t => {
  const f = fixture(t);
  f.ingest(f.insert('recall', '我明天面试'));
  const event = f.all()[0];
  const row = JSON.parse(f.source.db.prepare('SELECT message FROM inbox WHERE id=?').get('recall').message);
  row.recalled = true;
  f.source.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(row), 'recall');
  assert.equal(f.life.claim({ ...scope, id: event.id, revision: event.revision, inboxPath: f.inboxPath,
    now: Date.parse('2026-11-14T19:00:00+08:00') }), null);
  assert.equal(f.life.maintain({ ...scope, inboxPath: f.inboxPath, now }).invalidated, 1);
  assert.equal(f.all()[0].state, 'invalidated');
});

test('claims survive restart, bind revision and never retry an unknown dispatch', t => {
  const f = fixture(t);
  f.ingest(f.insert('claim', '我明天面试'));
  const event = f.all()[0], due = Date.parse('2026-11-14T19:00:00+08:00');
  assert.equal(f.life.claim({ ...scope, id: event.id, revision: 0, inboxPath: f.inboxPath, now: due }), null);
  const claimed = f.life.claim({ ...scope, id: event.id, revision: event.revision, inboxPath: f.inboxPath, now: due });
  assert.ok(claimed.claimKey);
  assert.equal(f.life.claim({ ...scope, id: event.id, revision: event.revision, inboxPath: f.inboxPath, now: due }), null);
  assert.equal(f.life.beginDispatch({ ...scope, id: event.id, claimKey: claimed.claimKey, outboxKey: 'outbox:life', inboxPath: f.inboxPath, now: due }), true);
  f.restart();
  assert.equal(f.life.due({ ...scope, now: due + 1000 }).length, 0);
  assert.equal(f.life.pendingReceipts(scope)[0].outboxKey, 'outbox:life');
  f.life.settle({ ...scope, id: event.id, claimKey: claimed.claimKey, state: 'needs_review', now: due });
  assert.equal(f.life.due({ ...scope, now: due + HOUR }).length, 0);
  f.life.settle({ ...scope, id: event.id, claimKey: claimed.claimKey, state: 'sent', now: due });
  assert.equal(f.all()[0].state, 'sent');
});

test('a source changed while the model is deciding cannot pass the final dispatch guard', t => {
  const f = fixture(t);
  f.ingest(f.insert('during-model', '我明天面试'));
  const event = f.all()[0], due = Date.parse('2026-11-14T19:00:00+08:00');
  const claimed = f.life.claim({ ...scope, id: event.id, revision: event.revision, inboxPath: f.inboxPath, now: due });
  const raw = JSON.parse(f.source.db.prepare('SELECT message FROM inbox WHERE id=?').get('during-model').message);
  raw.text = '我明天没有面试';
  f.source.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(raw), 'during-model');
  assert.equal(f.life.beginDispatch({ ...scope, id: event.id, claimKey: claimed.claimKey,
    outboxKey: 'must-not-send', inboxPath: f.inboxPath, now: due }), false);
  assert.equal(f.all()[0].state, 'invalidated');
});

test('conversation-change deferral is bounded and interrupted evaluation stays closed', t => {
  const f = fixture(t);
  f.ingest(f.insert('defer', '我明天面试'));
  const event = f.all()[0];
  let at = Date.parse('2026-11-14T19:00:00+08:00');
  for (let i = 0; i < 2; i++) {
    const claim = f.life.claim({ ...scope, id: event.id, revision: event.revision, inboxPath: f.inboxPath, now: at });
    assert.ok(claim);
    f.life.defer({ ...scope, id: event.id, claimKey: claim.claimKey, now: at });
    at += 31 * 60000;
  }
  assert.equal(f.all()[0].state, 'skipped');
  assert.equal(f.life.due({ ...scope, now: at }).length, 0);
  const source = f.insert('other', '我明天考试');
  f.ingest(source);
  const next = f.all().find(x => x.kind === 'exam');
  f.life.claim({ ...scope, id: next.id, revision: next.revision, inboxPath: f.inboxPath, now: at });
  assert.equal(f.life.maintain({ ...scope, inboxPath: f.inboxPath, now: at + 11 * 60000 }).uncertain, 1);
});

test('explicit Gregorian birthday recurs annually without replaying a missed birthday', t => {
  const f = fixture(t);
  f.ingest(f.insert('birthday', '我的生日是11月14日'));
  let event = f.all()[0];
  assert.equal(event.repeatRule, 'yearly:11-14');
  const late = Date.parse('2026-11-15T13:00:00+08:00');
  assert.equal(f.life.maintain({ ...scope, inboxPath: f.inboxPath, now: late }).rolled, 1);
  event = f.all()[0];
  assert.equal(event.occurrence, '2027-11-14');
  assert.equal(f.life.due({ ...scope, now: late }).length, 0);
  assert.equal(f.life.db.prepare('SELECT state FROM life_event_occurrences').get().state, 'expired');
  assert.equal(f.life.maintain({ ...scope, inboxPath: f.inboxPath, now: late }).rolled, 0);
});

test('sources must not turn ambiguous multi-event cancellations into arbitrary closures', t => {
  const f = fixture(t);
  f.ingest(f.insert('first', '我明天面试'));
  f.ingest(f.insert('second', '我后天面试'));
  const cancelled = f.insert('cancel', '我的面试取消了', { eventTime: new Date(now + 1).toISOString() });
  const outcome = f.ingest(cancelled, { now: now + 1 });
  assert.equal(outcome.cancelled, 0);
  assert.ok(outcome.rejected.some(x => /Ambiguous/.test(x.reason)));
  assert.equal(f.life.list(scope).length, 2);
});

test('source maintenance batches more than one thousand active events without exceeding evidence limits', t => {
  const f = fixture(t);
  f.ingest(f.insert('seed', '我明天面试'));
  const seed = f.life.db.prepare('SELECT * FROM life_events').get();
  const columns = Object.keys(seed);
  const insert = f.life.db.prepare(`INSERT INTO life_events(${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
  f.life.transaction(() => {
    for (let i = 0; i < 1001; i++) {
      const row = { ...seed, id: `synthetic-${i}`, source_id: `missing-source-${i}` };
      insert.run(...columns.map(key => row[key]));
    }
  });
  const result = f.life.maintain({ ...scope, inboxPath: f.inboxPath, now });
  assert.equal(result.invalidated, 1001);
  assert.equal(f.life.list(scope).length, 1);
});
