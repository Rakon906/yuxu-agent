import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openIntimacyStore, DEFAULT_INTIMACY, intimacyLevel } from '../packages/intimacy/index.mjs';
import { judgeIntimacy } from '../packages/intimacy/judge.mjs';
import { memberProfile } from '../packages/people/index.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const ACCOUNT = 'account-test';
const GROUP = 'group@chatroom';

async function setup(t) {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'intimacy-test-'));
  const store = openIntimacyStore(join(root, 'intimacy.sqlite'));
  t.after(() => store.close());
  return { root, store };
}

test('new members start at 6 and report a friendly level', async t => {
  const { store } = await setup(t);
  const profile = store.get(ACCOUNT, GROUP, 'u1');
  assert.equal(profile.score, DEFAULT_INTIMACY);
  assert.equal(profile.level, 'friendly');
  assert.equal(intimacyLevel(10).key, 'best');
  assert.equal(intimacyLevel(9.5).key, 'close');
  assert.equal(intimacyLevel(3).key, 'distant');
  assert.equal(intimacyLevel(0).key, 'guarded');
});

test('daily changes are capped at half a point and keep one decimal', async t => {
  const { store } = await setup(t);
  const day = Date.parse('2026-11-11T10:00:00+08:00');
  for (let index = 0; index < 4; index++) {
    store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', delta: 0.3,
      reason: '聊得来', taskId: `t${index}`, now: day + index * 1000 });
  }
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', day).score, 6.5);
  const nextDay = day + 24 * 3600000;
  store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', delta: -0.4,
    reason: '闹别扭', taskId: 't9', now: nextDay });
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', nextDay).score, 6.1);
});

test('a task only changes intimacy once and scores stay between 0 and 10', async t => {
  const { store } = await setup(t);
  const now = Date.parse('2026-11-11T10:00:00+08:00');
  const first = store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1',
    delta: 0.2, reason: '谢谢', taskId: 'same', now });
  assert.equal(first.applied, 0.2);
  const again = store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1',
    delta: 0.2, reason: '重复', taskId: 'same', now: now + 1000 });
  assert.equal(again.applied, 0);
  assert.equal(again.duplicate, true);
  store.setScore({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', score: 99, now });
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', now).score, 10);
  store.setScore({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', score: -5, now });
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', now).score, 0);
  store.setScore({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', score: 6.25, now });
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', now).score, 6.3);
});

test('locked members ignore automatic changes until unlocked', async t => {
  const { store } = await setup(t);
  const now = Date.parse('2026-11-11T10:00:00+08:00');
  store.setScore({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', score: 10, now });
  const locked = store.lock({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', now });
  assert.equal(locked.locked, true);
  const blocked = store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1',
    delta: -0.4, reason: '自动下降', taskId: 'lock-test', now });
  assert.equal(blocked.applied, 0);
  assert.equal(blocked.locked, true);
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', now).score, 10);
  store.lock({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1', locked: false, now });
  store.apply({ accountId: ACCOUNT, groupId: GROUP, userId: 'u1',
    delta: -0.4, reason: '解锁后下降', taskId: 'lock-test-2', now });
  assert.equal(store.get(ACCOUNT, GROUP, 'u1', now).score, 9.6);
});

test('member profiles carry the current intimacy', () => {
  const profile = memberProfile({ userId: 'u1',
    roster: new Map([['u1', '示例成员19']]), contacts: new Map(),
    curatedNames: new Map(), snapshots: new Map(),
    intimacy: { score: 8.2, level: 'close', label: '熟络', reason: '常聊天' } });
  assert.equal(profile.intimacy.score, 8.2);
  assert.equal(profile.intimacy.label, '熟络');
});

test('diary judgment applies model changes and inactivity decay stops at 6', async t => {
  const { root, store } = await setup(t);
  const inboxPath = join(root, 'inbox.sqlite');
  const db = new DatabaseSync(inboxPath);
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL)');
  const now = Date.parse('2026-11-11T12:00:00+08:00');
  const insert = db.prepare('INSERT INTO inbox (id,message) VALUES (?,?)');
  for (const userId of ['b', 'c']) {
    insert.run(userId, JSON.stringify({ sourceMessageId: userId, accountId: ACCOUNT, groupId: GROUP, userId,
      eventTime: new Date(now - 10 * 86400000).toISOString(), text: '很久没来了' }));
  }
  insert.run('a-message', JSON.stringify({ sourceMessageId: 'a-message', accountId: ACCOUNT,
    groupId: GROUP, userId: 'a', text: '说了很不合适的话', eventTime: new Date(now).toISOString() }));
  db.close();
  store.ensureMembers(ACCOUNT, GROUP, ['a', 'b', 'c'], now);
  store.setScore({ accountId: ACCOUNT, groupId: GROUP, userId: 'b', score: 6.2, now });
  const result = await judgeIntimacy({ store, inboxPath, accountId: ACCOUNT, groupId: GROUP,
    batch: [{ id: 'a-message', senderId: 'a', text: '说了很不合适的话' }],
    diary: { title: '不愉快', summary: 'a 说了让人不舒服的话' }, segmentId: 'seg1', now,
    model: async () => ({ changes: [{ userId: 'p1', delta: -0.4, reason: '言语冒犯',
      sourceMessageIds: ['m1'], evidenceQuote: '说了很不合适的话' }] }) });
  assert.equal(result.applied.length, 1);
  assert.equal(store.get(ACCOUNT, GROUP, 'a', now).score, 5.6);
  assert.equal(result.decayed.length, 1);
  assert.equal(store.get(ACCOUNT, GROUP, 'b', now).score, 6);
  assert.equal(store.get(ACCOUNT, GROUP, 'c', now).score, 6);
});
