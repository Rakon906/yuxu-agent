import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { contactDirectory, groupRoster, loadPeopleConfig, memberProfile,
  readMemberActivity, selectRelatedMemberIds } from '../packages/people/index.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const account = 'account-people-test';
const group = 'people@chatroom';

test('curated names stay bound to verified member IDs and unknown members use WeChat names', async () => {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'people-config-test-'));
  const config = join(root, 'people.json');
  await writeFile(config, JSON.stringify({ schemaVersion: 1, accountId: account, groupId: group,
    namesByUserId: { 'person-a': ['小艾'], 'person-b': ['小贝'], 'person-c': ['阿丙'] },
    identitySnapshots: {
      'person-a': { wechatNickname: '原微信昵称', groupNickname: '原群昵称', wechatAccount: 'custom-id' },
      'person-b': { wechatNickname: '乙', groupNickname: '乙', wechatAccount: null },
      'person-c': { wechatNickname: '丙', groupNickname: '丙', wechatAccount: null },
    } }));
  const { names, snapshots } = loadPeopleConfig(config, account, group);
  assert.equal(names.size, 3);
  assert.throws(() => loadPeopleConfig(config, account, 'other@chatroom'), /outside/);
  const roster = groupRoster([
    { id: 'person-a', roomDisplayName: '新群昵称' },
    { id: 'person-b', displayName: '已改微信昵称' },
    { id: 'unknown', displayName: '新来的朋友' },
  ]);
  const contacts = contactDirectory([
    { id: 'person-a', nickname: '新微信昵称', alias: 'new-custom-id' },
    { id: 'unknown', nickname: '微信上的昵称', alias: null },
  ]);
  const profile = userId => memberProfile({ userId, roster, contacts, curatedNames: names, snapshots });
  assert.deepEqual(profile('person-b').preferredNames, ['小贝']);
  assert.equal(profile('unknown').displayName, '新来的朋友');
  assert.equal(profile('unknown').wechatNickname, '微信上的昵称');
  assert.deepEqual(profile('unknown').preferredNames, []);
  assert.deepEqual(profile('person-c').preferredNames, []);
  assert.deepEqual(profile('person-a').preferredNames, ['小艾']);
  assert.equal(profile('person-a').groupNickname, '新群昵称');
  assert.equal(profile('person-a').wechatNickname, '新微信昵称');
  assert.equal(snapshots.get('person-a').wechatAccount, 'custom-id');
  assert.deepEqual(memberProfile({ userId: 'unknown', roster, contacts, curatedNames: names, snapshots,
    coreFacts: [
    { id: 'a', subjectId: 'unknown', fact: '喜欢做饭', category: 'interest' },
    { id: 'b', subjectId: 'someone-else', fact: '喜欢打游戏' },
    ] }).facts, [{ id: 'a', fact: '喜欢做饭', category: 'interest' }]);
});

test('activity observations require enough messages across multiple local dates', async t => {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'people-test-'));
  const store = new AdapterStore(join(root, 'inbox.sqlite'), account);
  t.after(() => store.close());
  for (let n = 0; n < 19; n++) {
    store.commitEvent(String(n + 1), { accountId: account, groupId: group, userId: 'alice',
      sourceMessageId: `m-${n}`, text: '你好', eventTime: `2026-11-0${1 + Math.floor(n / 7)}T12:00:00Z` }, 'text');
  }
  assert.equal(readMemberActivity(join(root, 'inbox.sqlite'), account, group, 'alice'), null);
  store.commitEvent('20', { accountId: account, groupId: group, userId: 'alice',
    sourceMessageId: 'm-19', text: '你好', eventTime: '2026-11-03T12:00:00Z' }, 'text');
  const activity = readMemberActivity(join(root, 'inbox.sqlite'), account, group, 'alice');
  assert.deepEqual(activity, { observedMessages: 20, observedDays: 3,
    periods: { night: 0, morning: 0, afternoon: 0, evening: 20 } });
  assert.equal(readMemberActivity(join(root, 'inbox.sqlite'), account, 'other@chatroom', 'alice'), null);
});

test('related profiles prioritize named non-speakers and omit unrelated members', () => {
  const roster = new Map([['alice', '小艾'], ['bob', '示例成员12'], ['carol', '示例成员19'],
    ['dave', '其他成员']]);
  const contacts = new Map();
  const names = new Map([['bob', ['示例成员16']]]);
  const selected = selectRelatedMemberIds({ target: { senderId: 'alice', text: '示例成员16上次说的事呢？' },
    context: [{ senderId: 'carol', text: '我刚来' }, { senderId: 'alice', text: '你们说啥' }],
    roster, contacts, curatedNames: names });
  assert.deepEqual(selected, ['bob', 'carol']);
  assert.deepEqual(selectRelatedMemberIds({ target: { senderId: 'alice', text: '上次那事后来呢？' },
    context: [], roster, contacts, curatedNames: names,
    relatedText: '相关日记写到示例成员12约了周末见面' }), ['bob']);
});
