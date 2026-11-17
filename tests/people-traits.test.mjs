import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { validateDiaryOutput } from '../packages/diary/index.mjs';
import { memberProfile } from '../packages/people/index.mjs';
import { initializeObservations, accumulateDiaryObservations, readObservationProfiles,
  validatePersonObservation } from '../packages/people/observations.mjs';

const scope = { accountId: 'trait-account', groupId: 'trait-group@chatroom' };
const message = (id, day, text) => ({ id, senderId: 'alice', at: `2026-11-${day}T12:00:00Z`, text });
const observed = (source, changes = {}) => ({ text: '记录本人说话方式', sourceMessageIds: [source.id],
  evidenceQuote: source.text, personObservation: { subjectId: 'alice', category: 'speaking_style',
    topic: '用简短反问表达惊讶', stance: 'support', basis: 'pattern', ...changes } });
function fixture(t) {
  const dir = mkdtempSync(join(fileURLToPath(new URL('../.runtime/', import.meta.url)), 'sociomem-traits-'));
  const path = join(dir, 'diary.sqlite'), inboxPath = join(dir, 'inbox.sqlite');
  const db = new DatabaseSync(path); initializeObservations(db);
  const closeBeforeCleanup = [];
  t.after(() => { for (const close of closeBeforeCleanup) close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
  const add = (source, changes = {}) => accumulateDiaryObservations(db, { ...scope,
    segmentId: `segment-${source.id}`, messages: [source], events: [observed(source, changes)] });
  const select = options => readObservationProfiles(path, { ...scope, userIds: ['alice'], ...options });
  return { path, inboxPath, db, add, select, closeBeforeCleanup };
}
const profile = observations => memberProfile({ userId: 'alice', roster: new Map([['alice', '小艾']]),
  contacts: new Map(), curatedNames: new Map(), snapshots: new Map(), observations });

test('a behavioral interpretation stays a candidate until independent evidence spans multiple days', t => {
  const { add, select } = fixture(t);
  add(message('a', '01', '真的假的？'));
  assert.equal(select()[0].state, 'candidate');
  assert.deepEqual(profile(select()).traits, []);
  add(message('b', '01', '还有这种事？'));
  assert.deepEqual(profile(select()).traits, []);
  add(message('c', '02', '这也行？'));
  const result = profile(select()).traits;
  assert.equal(result.length, 1);
  assert.equal(result[0].category, 'speaking_style');
  assert.equal(result[0].description, '多次观察到：用简短反问表达惊讶');
  assert.equal(result[0].basis, 'repeated_evidence');
  assert.equal(result[0].provisional, true);
  assert.equal(result[0].observedDays, 2);
  assert.deepEqual(new Set(result[0].sourceMessageIds), new Set(['a', 'b', 'c']));
});

test('replays and copying one phrase never manufacture a supported trait', t => {
  const { add, select } = fixture(t);
  const first = message('a', '01', '真的假的？');
  assert.equal(add(first), 1); assert.equal(add(first), 0);
  add(message('b', '02', first.text)); add(message('c', '03', first.text));
  assert.equal(select()[0].state, 'repeated');
  assert.deepEqual(profile(select()).traits, []);
});

test('explicit preferences are self-reported, while jokes, hearsay and negative statements cannot become positive labels', t => {
  const { add, select } = fixture(t);
  const changes = { category: 'interest', topic: 'BLG', basis: 'self_report' };
  const source = message('a', '01', '我喜欢看BLG比赛');
  add(source, changes);
  assert.equal(select()[0].state, 'self_reported');
  assert.equal(profile(select()).traits[0].description, '本人自述偏好「BLG」');
  add(message('b', '02', source.text), changes); add(message('c', '03', source.text), changes);
  assert.equal(profile(select()).traits[0].basis, 'self_report');
  for (const text of ['我喜欢BLG？才怪', '他说我喜欢BLG', '我不喜欢BLG', '我喜欢BLG，开玩笑的', 'BLG今天赢了吗']) {
    const current = { ...source, text }; const event = observed(current, changes);
    assert.throws(() => validatePersonObservation(event.personObservation, event, [current]), /self-reported|Self-reported/u);
  }
});

test('unsupported global personality verdicts, other speakers and interpreted media never form behavioral labels', () => {
  const source = message('a', '01', '先别难过，出什么事了？');
  for (const changes of [{ category: 'personality', topic: '外向' },
    { category: 'personality', topic: '低情商' }, { category: 'personality', topic: '有精神病' },
    { subjectId: 'bob' }]) {
    const event = observed(source, changes);
    assert.throws(() => validatePersonObservation(event.personObservation, event, [source]));
  }
  for (const interaction of ['voice', 'image', 'sticker', 'forwarded', 'share']) {
    const event = observed(source);
    assert.throws(() => validatePersonObservation(event.personObservation, event, [{ ...source, interaction }]));
  }
});

test('self-report polarity must agree with the literal declaration before withdrawing a preference', t => {
  const { add, select } = fixture(t);
  const changes = { category: 'interest', topic: 'BLG', basis: 'self_report' };
  add(message('a', '01', '我喜欢BLG'), changes);
  const positive = message('b', '02', '我喜欢BLG');
  const wrongReject = observed(positive, { ...changes, stance: 'reject', corrects: true });
  assert.throws(() => validatePersonObservation(wrongReject.personObservation, wrongReject, [positive]), /Self-reported/u);
  for (const text of ['我不讨厌BLG', '我不是不喜欢BLG', '我以前不喜欢BLG']) {
    const source = message('ambiguous', '02', text);
    const event = observed(source, { ...changes, stance: 'reject' });
    assert.throws(() => validatePersonObservation(event.personObservation, event, [source]), /Self-reported/u);
  }
  const unrelated = message('c', '02', '我喜欢BLG，但我不喜欢熬夜');
  assert.equal(validatePersonObservation(observed(unrelated, changes).personObservation, observed(unrelated, changes), [unrelated]).stance, 'support');
  const correction = message('d', '03', '更正一下，我现在不喜欢BLG了');
  add(correction, { ...changes, stance: 'reject', corrects: true });
  assert.equal(select()[0].state, 'withdrawn');
  assert.deepEqual(profile(select()).traits, []);
});

test('an explicit standalone dislike is a negative self-reported preference, not a missing or positive label', t => {
  const { add, select } = fixture(t);
  const changes = { category: 'preference', topic: '香菜', basis: 'self_report', stance: 'reject' };
  add(message('a', '01', '我不喜欢吃香菜，点菜的时候不用给我放。'), changes);
  assert.equal(select()[0].state, 'self_reported');
  assert.equal(profile(select()).traits[0].description, '本人自述不喜欢「香菜」');
  assert.equal(profile(select()).traits[0].polarity, 'reject');
  assert.equal(profile(select()).traits[0].basis, 'self_report');
  assert.equal(profile(select()).traits[0].provisional, true);
  add(message('b', '02', '我不爱吃香菜'), changes);
  add(message('c', '03', '我不喜欢香菜'), changes);
  assert.equal(profile(select()).traits[0].polarity, 'reject');
  add(message('d', '04', '我喜欢吃香菜'), { ...changes, stance: 'support' });
  assert.equal(select()[0].state, 'conflicted');
  assert.deepEqual(profile(select()).traits, []);
});

test('a non-explicit negative guess stays a candidate rather than a dislike trait', t => {
  const { add, select } = fixture(t);
  add(message('a', '01', '这顿饭有香菜'), { category: 'preference', topic: '香菜', basis: 'pattern', stance: 'reject' });
  assert.equal(select()[0].state, 'candidate');
  assert.deepEqual(profile(select()).traits, []);
});

test('conflicting observations remove a label and an explicit correction starts a fresh history', t => {
  const { add, select } = fixture(t);
  for (const [id, day, text] of [['a', '01', '真的假的？'], ['b', '01', '这也能行？'], ['c', '02', '不会吧？']]) add(message(id, day, text));
  assert.equal(profile(select()).traits.length, 1);
  add(message('d', '03', '今天我正常说话'), { stance: 'reject' });
  assert.equal(select()[0].state, 'conflicted');
  assert.deepEqual(profile(select()).traits, []);
  add(message('e', '04', '更正一下，我不会一直这样说话'), { stance: 'reject', corrects: true });
  assert.equal(select()[0].state, 'withdrawn');
  assert.equal(select()[0].observedMessages, 1);
  assert.deepEqual(profile(select()).traits, []);
});

test('recalled evidence immediately downgrades a previously supported trait at read time', t => {
  const { add, select, inboxPath, closeBeforeCleanup } = fixture(t);
  const inbox = new AdapterStore(inboxPath, scope.accountId); closeBeforeCleanup.push(() => inbox.close());
  for (const [id, day, text] of [['a', '01', '真的假的？'], ['b', '01', '这也能行？'], ['c', '02', '不会吧？']]) {
    const source = message(id, day, text);
    inbox.commitEvent(id, { ...scope, sourceMessageId: id, userId: 'alice', text, eventTime: source.at }, 'text'); add(source);
  }
  assert.equal(profile(select({ inboxPath })).traits.length, 1);
  const raw = JSON.parse(inbox.db.prepare('SELECT message FROM inbox WHERE id=?').get('c').message);
  inbox.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify({ ...raw, recalled: true }), 'c');
  assert.deepEqual(profile(select({ inboxPath })).traits, []);
  assert.equal(select({ inboxPath })[0].observedMessages, 2);
});

test('new generic quotations do not crowd grounded traits out of the six-observation profile', t => {
  const { db, add, select } = fixture(t);
  add(message('interest', '01', '我喜欢看BLG比赛'), { category: 'interest', topic: 'BLG', basis: 'self_report' });
  for (let n = 0; n < 8; n++) {
    const source = message(`raw-${n}`, '02', `普通说话${n}`);
    accumulateDiaryObservations(db, { ...scope, segmentId: `raw-${n}`, messages: [source],
      events: [{ text: source.text, sourceMessageIds: [source.id], evidenceQuote: source.text }] });
  }
  assert.equal(select().length, 6);
  assert.equal(profile(select()).traits[0].topic, 'BLG');
});

test('behavioral core replacements require repeated evidence too, with days measured in Beijing time', () => {
  const old = [{ id: 'a', senderId: 'alice', at: '2026-11-01T15:58:00Z', text: '真的假的？' },
    { id: 'b', senderId: 'alice', at: '2026-11-01T15:59:00Z', text: '这也行？' }];
  const current = [{ id: 'c', senderId: 'alice', at: '2026-11-01T16:01:00Z', text: '不会吧？' }];
  const coreFacts = [{ id: 'old-fact', subjectId: 'alice', category: 'personality', fact: '旧的行为印象' }];
  const update = { action: 'replace', targetMemoryId: 'old-fact', subjectId: 'alice', category: 'personality',
    fact: '多次用简短反问接话', sourceMessageIds: ['c'], evidenceQuote: current[0].text };
  const output = { diary: { title: '观察', summary: '新的一段聊天', events: [] }, coreUpdates: [update] };
  assert.throws(() => validateDiaryOutput(output, current, coreFacts, old), /repeated self evidence/u);
  update.sourceMessageIds = ['a', 'b', 'c'];
  assert.equal(validateDiaryOutput(output, current, coreFacts, old).coreUpdates.length, 1);
});
