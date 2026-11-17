import test from 'node:test';
import assert from 'node:assert/strict';
import { isGroupTopic, matchTopics } from '../packages/topics/lexicon.mjs';

const topics = text => [...new Set(matchTopics(text).map(hit => hit.topic))];

test('the lexicon matches the group interests without generic words', () => {
  assert.deepEqual(topics('今晚吃饭了吗'), []);
  assert.deepEqual(topics('周末去景区自驾'), ['旅游']);
  assert.deepEqual(topics('英雄联盟新版本'), ['游戏']);
  assert.deepEqual(topics('三角洲行动更新了'), ['游戏']);
  assert.deepEqual(topics('LPL 决赛今晚打'), ['电竞']);
  assert.deepEqual(topics('这家火锅店有人去过吗'), ['美食']);
  assert.equal(isGroupTopic('今天好困'), false);
  assert.equal(isGroupTopic('瓦罗兰特来一把'), true);
});

test('full-width latin and mixed case are normalized before matching', () => {
  assert.deepEqual(topics('ＬＯＬ 新赛季'), ['游戏']);
  assert.deepEqual(topics('Valorant 更新'), ['游戏']);
});
