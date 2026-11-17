import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { DiaryStore, runDiary, validateDiaryOutput } from '../packages/diary/index.mjs';
import { memberProfile } from '../packages/people/index.mjs';
import { initializeObservations, accumulateDiaryObservations, readObservationProfiles,
  backfillDiaryObservations, validatePersonObservation } from '../packages/people/observations.mjs';

const accountId = 'observation-account', groupId = 'observation-group@chatroom';
const source = (id, date = '2026-11-01', extra = {}) => ({ id, senderId: 'alice',
  at: `${date}T12:00:00Z`, text: '我喜欢看BLG比赛', interaction: 'text', ...extra });
const event = (message, changes = {}) => ({ text: '记录本人关于BLG的原话',
  sourceMessageIds: [message.id], evidenceQuote: message.text,
  personObservation: { subjectId: message.senderId, category: 'interest', topic: 'BLG',
    stance: 'support', corrects: false, ...changes } });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'people-observations-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, 'diary.sqlite'), inboxPath: join(root, 'inbox.sqlite') };
}
const select = path => readObservationProfiles(path, { accountId, groupId, userIds: ['alice'] });

test('profile fact limit is 500 independently of the 80-character identity limit', () => {
  const args = { userId: 'alice', roster: new Map([['alice', '爱丽丝']]), contacts: new Map(),
    curatedNames: new Map(), snapshots: new Map(), observations: [{ subjectId: 'alice', state: 'candidate' },
      { subjectId: 'bob', state: 'repeated' }] };
  const result = memberProfile({ ...args, coreFacts: [81, 500, 501].map(n =>
    ({ subjectId: 'alice', id: `f${n}`, fact: '字'.repeat(n) })) });
  assert.deepEqual(result.facts.map(fact => fact.fact.length), [81, 500]);
  assert.deepEqual(result.observations, [{ subjectId: 'alice', state: 'candidate' }]);
  assert.throws(() => memberProfile({ ...args, userId: 'a'.repeat(81) }), /identity/);
});

test('observation validation rejects invented topic, wrong speaker and interpreted media', () => {
  const message = source('m1');
  const input = event(message);
  assert.equal(validatePersonObservation(input.personObservation, input, [message]).subjectId, 'alice');
  for (const change of [{ subjectId: 'bob' }, { topic: '足球' }, { stance: 'sure' }]) {
    assert.throws(() => validatePersonObservation({ ...input.personObservation, ...change }, input, [message]));
  }
  for (const interaction of ['voice', 'image', 'sticker']) {
    assert.throws(() => validatePersonObservation(input.personObservation, input, [{ ...message, interaction }]));
  }
  const output = { diary: { title: '观察', summary: '候选', events: [input] }, coreUpdates: [] };
  assert.equal(validateDiaryOutput(output, [message]).diary.events[0].personObservation.topic, 'BLG');
  const bad = { ...output, diary: { ...output.diary, events: [event(message, { subjectId: 'bob' })] } };
  const degraded = validateDiaryOutput(bad, [message]).diary.events[0];
  assert.equal(degraded.personObservation, undefined);
  assert.equal(degraded.classificationRejected, 'invalid_person_observation');
  assert.equal(degraded.evidenceQuote, message.text);
  bad.diary.events[0].evidenceQuote = '没有来源的文字';
  assert.throws(() => validateDiaryOutput(bad, [message]), /evidence is absent/);
});

test('cross-day accumulation persists, deduplicates sources and keeps corrections/conflicts separate', t => {
  const { path } = fixture(t);
  let db = new DatabaseSync(path); initializeObservations(db);
  const add = (message, changes = {}) => accumulateDiaryObservations(db, { accountId, groupId,
    segmentId: `seg-${message.id}`, events: [event(message, changes)], messages: [message] });
  const a = source('a');
  assert.equal(add(a), 1); assert.equal(add(a), 0);
  assert.equal(select(path)[0].state, 'candidate');
  add(source('b')); add(source('c', '2026-11-02'));
  db.close(); db = new DatabaseSync(path);
  assert.equal(select(path)[0].state, 'repeated');
  assert.equal(select(path)[0].observedMessages, 3);
  assert.equal(readObservationProfiles(path, { accountId, groupId: 'foreign', userIds: ['alice'] }).length, 0);
  add(source('d', '2026-11-03', { text: '不喜欢BLG了' }), { stance: 'reject' });
  assert.equal(select(path)[0].state, 'conflicted');
  add(source('e', '2026-11-04', { text: '更正一下，我不喜欢BLG了' }), { stance: 'reject', corrects: true });
  const withdrawn = select(path)[0];
  assert.equal(withdrawn.state, 'withdrawn');
  assert.equal(withdrawn.evidence.length, 1);
  assert.equal(db.prepare('SELECT count(*) n FROM person_observations').get().n, 5);
  db.close();
});

test('diary and observations commit atomically, and the same batch cannot increment twice', t => {
  const { path } = fixture(t);
  const store = new DiaryStore(path);
  try {
    const message = source('a');
    const segment = { id: 'seg', accountId, groupId, previousRowid: 0, startRowid: 1,
      endRowid: 1, startAt: message.at, endAt: message.at, title: '观察', summary: '观察',
      sourceMessageIds: ['a'], events: [event(message, { subjectId: 'bob' })] };
    assert.throws(() => store.save(segment, [], [message]));
    assert.equal(store.progress(accountId, groupId), 0);
    segment.events = [event(message)];
    store.save(segment, [], [message]); store.save(segment, [], [message]);
    assert.equal(select(path)[0].observedMessages, 1);
    assert.equal(store.progress(accountId, groupId), 1);
  } finally { store.close(); }
});

test('legacy backfill checks original scoped quote speaker, not diary narrative or participant list', t => {
  const { path, inboxPath } = fixture(t);
  const adapter = new AdapterStore(inboxPath, accountId);
  const diary = new DiaryStore(path);
  const messages = [source('a', '2026-11-01', { text: '听说鲍勃喜欢做饭' }),
    source('b', '2026-11-01', { senderId: 'bob', text: '谁说的' })];
  try {
    for (const [i, message] of messages.entries()) adapter.commitEvent(String(i + 1), {
      accountId, groupId, userId: message.senderId, sourceMessageId: message.id,
      text: message.text, eventTime: message.at }, 'text');
    diary.save({ id: 'old', accountId, groupId, previousRowid: 0, startRowid: 1, endRowid: 2,
      startAt: messages[0].at, endAt: messages[1].at, title: '做饭', summary: '旧日记',
      events: [{ text: '鲍勃喜欢做饭', sourceMessageIds: ['a', 'b'], evidenceQuote: messages[0].text }],
      sourceMessageIds: ['a', 'b'] }, []);
    assert.equal(backfillDiaryObservations({ diaryPath: path, inboxPath, accountId, groupId }).inserted, 1);
    assert.equal(backfillDiaryObservations({ diaryPath: path, inboxPath, accountId, groupId }).inserted, 0);
    const profile = select(path)[0];
    assert.equal(profile.subjectId, 'alice'); assert.equal(profile.state, 'observed');
    assert.equal(profile.evidence[0].quote, messages[0].text);
    assert.equal(readObservationProfiles(path, { accountId, groupId, userIds: ['bob'] }).length, 0);
    const raw = JSON.parse(adapter.db.prepare('SELECT message FROM inbox WHERE id=?').get('a').message);
    raw.text = '消息已撤回';
    raw.recalled = true;
    adapter.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify(raw), 'a');
    assert.deepEqual(readObservationProfiles(path, { accountId, groupId, userIds: ['alice'], inboxPath }), []);
    assert.equal(backfillDiaryObservations({ diaryPath: path, inboxPath, accountId, groupId }).retired, 1);
    assert.equal(select(path).length, 0);
  } finally { diary.close(); adapter.close(); }
});

test('read-only observation lookup tolerates old schemas without writing migrations', t => {
  const { path } = fixture(t);
  const db = new DatabaseSync(path); db.exec('CREATE TABLE unrelated (id TEXT)'); db.close();
  assert.deepEqual(select(path), []);
  const reopened = new DatabaseSync(path, { readOnly: true });
  assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE name='person_observations'").get(), undefined);
  reopened.close();
});

test('later diaries retrieve verified observation evidence beyond the recent 512-message window', async t => {
  const { path, inboxPath } = fixture(t);
  const adapter = new AdapterStore(inboxPath, accountId);
  const diary = new DiaryStore(path);
  const old = source('old', '2026-11-01', { text: '普通聊天。'.repeat(100) + '我喜欢看BLG比赛' });
  const commit = (id, userId, text, at) => adapter.commitEvent(id, {
    accountId, groupId, sourceMessageId: id, userId, text, eventTime: at }, 'text');
  try {
    commit(old.id, old.senderId, old.text, old.at);
    for (let n = 0; n < 520; n++) commit(`f${n}`, 'bob', '普通闲聊', '2026-11-02T12:00:00Z');
    const oldEvent = { ...event(old), evidenceQuote: '我喜欢看BLG比赛' };
    diary.save({ id: 'old-segment', accountId, groupId, previousRowid: 0, startRowid: 1,
      endRowid: 521, startAt: old.at, endAt: '2026-11-02T12:00:00Z', title: '旧日记', summary: '旧观察',
      sourceMessageIds: ['old'], events: [oldEvent] }, [], [old]);
    diary.db.prepare('UPDATE segments SET indexed=1').run();
    commit('current', 'alice', '今天继续看BLG比赛', '2026-11-03T12:00:00Z');
    let seen;
    const memory = { getAll: async () => ({ results: [] }),
      add: async (_, { metadata }) => ({ results: [{ id: `mem-${metadata.segmentId}`, metadata }] }) };
    const result = await runDiary({ store: diary, memory, inboxPath, accountId, groupId, force: true,
      model: async input => { seen = input; return { diary: { title: '新日记', summary: '新的观察', events: [] }, coreUpdates: [] }; } });
    assert.equal(result.status, 'written');
    const evidence = seen.personHistory.find(item => item.id === 'old');
    assert.equal(evidence.senderId, 'alice');
    assert.ok(evidence.text.includes('我喜欢看BLG比赛'));
    assert.equal(evidence.observation.topic, 'BLG');
    assert.ok(seen.personHistory.every(item => item.senderId === 'alice'));
  } finally { diary.close(); adapter.close(); }
});
