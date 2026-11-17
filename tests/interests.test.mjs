import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { deriveMemberInterests, interestsFromFacts, mergeInterests }
  from '../packages/participation/interests.mjs';

const accountId = 'account-test';
const groupId = 'group@chatroom';
const base = Date.parse('2026-11-10T10:00:00Z');

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sociomem-interests-'));
  const store = new AdapterStore(join(dir, 'source.sqlite'), accountId);
  let index = 0;
  const say = (userId, text, at = base) => store.commitEvent(String(++index), {
    accountId, groupId, userId, sourceMessageId: `m${index}`, text,
    eventTime: new Date(at).toISOString(), recordedAt: new Date(at).toISOString(),
  }, 'text');
  return { store, say, inboxPath: join(dir, 'source.sqlite'),
    close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('specific game names count once, vague topics need two messages', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.say('alice', '今晚打三角洲吗');
  f.say('alice', 'lpl 决赛看了吗');
  f.say('bob', '想去旅游');
  f.say('bob', '周末旅行走不走');
  f.say('carol', '今天火锅真好吃');
  f.say('dave', '今天吃饭了');
  const interests = deriveMemberInterests({ inboxPath: f.inboxPath, accountId, groupId, now: base });
  assert.deepEqual(interests.get('alice').map(item => item.topic).sort(), ['游戏', '电竞']);
  assert.equal(interests.get('alice').find(item => item.topic === '游戏').terms[0], '三角洲');
  assert.deepEqual(interests.get('bob').map(item => item.topic), ['旅游']);
  assert.equal(interests.has('carol'), false);
  assert.equal(interests.has('dave'), false);
});

test('old messages outside the window are ignored', async t => {
  const f = fixture();
  t.after(() => f.close());
  f.say('alice', '三角洲', base - 40 * 86400000);
  const interests = deriveMemberInterests({ inboxPath: f.inboxPath, accountId, groupId, now: base,
    days: 30 });
  assert.equal(interests.has('alice'), false);
});

test('diary interest facts merge with derived interests', () => {
  const facts = [{ category: 'interest', fact: '爱玩瓦罗兰特' },
    { category: 'identity', fact: '住在天津' }];
  const fromFacts = interestsFromFacts(facts);
  assert.deepEqual(fromFacts.map(item => item.topic), ['游戏']);
  const merged = mergeInterests([{ topic: '游戏', terms: ['三角洲'], messages: 3 }], fromFacts);
  assert.deepEqual(merged[0].terms.sort(), ['三角洲', '瓦罗兰特'].sort());
  assert.equal(merged[0].messages, 3);
});
