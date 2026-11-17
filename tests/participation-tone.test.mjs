import test from 'node:test';
import assert from 'node:assert/strict';
import { isNeedlesslyCruel } from '../packages/participation/tone.mjs';

test('rejects recent personal attacks while allowing ordinary teasing and concise replies', () => {
  for (const reply of [
    '示例成员9，你这嘴是从下水道里捞出来的吧？',
    '文明？你这嘴也就剩这点遮羞布了。',
    '你脑子是租的吗。',
    '调个东西能调半天，你这手速是跟乌龟学的？',
    '怎么又有人开始发癫了？',
    '示例成员47，你这自我感觉良好的程度真是令人叹为观止。',
    '啧，示例成员13你管得挺宽啊。',
  ]) assert.equal(isNeedlesslyCruel(reply), true, reply);
  for (const reply of [
    '行，我刚才说重了，收着点。',
    '你怎么还没睡？',
    '这游戏名字挺抽象。',
    '哦，那我继续躺着。',
    '不想动，你替我动一下。',
  ]) assert.equal(isNeedlesslyCruel(reply), false, reply);
});
