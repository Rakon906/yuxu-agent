import test from 'node:test';
import assert from 'node:assert/strict';
import { participationMessages } from '../packages/participation/model.mjs';

const at = '2026-11-05T10:00:00.000Z';
const message = (id, text, extra = {}) => ({ id, senderId: 'wxid_b', text, at,
  mentions: { self: false, userIds: [] }, interaction: 'text', ...extra });

test('participation prompt carries quoted context without a private default lexicon', () => {
  const messages = participationMessages({
    target: { ...message('m2', '这段示例还可以怎么表达？'), senderId: 'wxid_a',
      quote: { senderId: 'wxid_b', text: '前面那辆车一直停着不走', type: 1,
        sticker: false, image: false } },
    context: [message('m1', '前面那辆车一直停着不走'), message('m2', '这段示例还可以怎么表达？')],
    kind: 'ordinary', mustReply: false, coreFacts: [], latestDiary: null,
  });
  assert.equal(messages.length, 2);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.target.replyTo.text, '前面那辆车一直停着不走');
  assert.equal(payload.target.replyTo.speakerKey, payload.conversation[0].speakerKey);
  assert.deepEqual(payload.target.interpretations ?? [], []);
  assert.equal(payload.conversation[0].replyTo, null);
});
