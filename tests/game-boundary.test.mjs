import test from 'node:test';
import assert from 'node:assert/strict';
import { gameParticipationViolation, GAME_PARTICIPATION_BOUNDARY } from '../packages/participation/game-boundary.mjs';

test('game capability rejects personal promises and fabricated gaming experience', () => {
  for (const text of [
    '行，那我这就上号，你拉我', '本公主陪你打三角洲', '我来打三角洲',
    '我当你的队友', '我能带你上分', '我玩过英雄联盟', '我昨晚打了两把',
    '这两天有点手痒想打三角洲，还有人在玩吗，带我一个',
    '三角洲我不太会打，去了纯送人头',
    '三角洲啊，刚被群友气完正想找人打两把消消气呢。',
    '我不能亲自打游戏，不过我陪你开黑', '我不是不能打三角洲',
    'yyrjy，等我上线', '“我来打三角洲”',
  ]) assert.equal(gameParticipationViolation(text, { contextText: '有人打三角洲吗' })?.code,
    'cannot_play_games', text);
});

test('brief invitation acceptance requires the current game target', () => {
  for (const text of ['我来', '算我一个', '带我一个', '加我', '拉我', '等我', '好呀，我来']) {
    assert.ok(gameParticipationViolation(text, { contextText: '有人开黑吗' }), text);
    assert.equal(gameParticipationViolation(text, { contextText: '谁来讲个笑话' }), null, text);
  }
});

test('discussion, watching, arranging other members and clear inability remain valid', () => {
  for (const text of [
    '我不能亲自打游戏，但能陪你聊聊三角洲', '我不会打三角洲',
    '我没法上号，你们玩吧', '本公主不能当你的队友',
    '我想看你们打三角洲', '我看你们开黑就行', '我帮你找队友',
    '我问你要不要打三角洲', '我建议你先上号', '你们赶紧上号吧',
    '有人来打三角洲吗', '示例成员47喊你们开黑了', '你们差几个人', 'yyrjy',
    '我跟你聊聊三角洲', '我来讲个笑话', '别拉我，我不能亲自玩',
    '他刚才说“我等会上号”', '示例成员47说：“我陪你打三角洲”',
    '别说“我来打三角洲”这种话', '我在看BLG比赛',
    '我陪你打电话', '我来打个比方', '我打电话问问',
  ]) assert.equal(gameParticipationViolation(text, { contextText: '打三角洲' }), null, text);
});

test('non-text and ordinary lifestyle replies stay unchanged', () => {
  for (const text of [null, undefined, {}, '', '我在躺着', '我想吃火锅', '你们三角洲打得怎么样了']) {
    assert.equal(gameParticipationViolation(text), null);
  }
  assert.match(GAME_PARTICIPATION_BOUNDARY, /不能亲自打游戏/u);
});
