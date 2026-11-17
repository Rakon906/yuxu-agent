import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseVoiceReply } from '../packages/voice/selection.mjs';

const row = (text, extra = {}) => ({ text, interaction: 'text', senderId: 'person-a', ...extra });
const options = (extra = {}) => ({ text: '躺着呢，今天不想动', sourceRows: [row('在干嘛')],
  addressed: true, kind: 'mention', isQuestion: false, key: 'account/group/source-1/reply', probability: 1, ...extra });
const choose = extra => chooseVoiceReply(options(extra));

test('explicit original request selects short voice without a model voice flag or a random draw', () => {
  assert.deepEqual(choose({ sourceRows: [row('肥鱼，用语音回答我')], kind: 'question', isQuestion: true, probability: 0 }),
    { selected: true, reason: 'explicit_voice' });
  for (const text of ['发条语音', '来个语音吧', '我想听听你的声音', '语音说一下', '读出来给我听']) {
    assert.equal(choose({ sourceRows: [row(text)], probability: 0 }).selected, true, text);
  }
  assert.equal(choose({ sourceRows: [row('发个语音')], addressed: false }).reason, 'voice_not_addressed');
});

test('last genuine format intent wins, same-row negation wins, and a neutral continuation does not undo it', () => {
  assert.equal(choose({ sourceRows: [row('发语音吧'), row('不要语音，打字就行')] }).reason, 'explicit_text');
  assert.equal(choose({ sourceRows: [row('别发语音'), row('算了，还是用语音吧')] }).reason, 'explicit_voice');
  assert.equal(choose({ sourceRows: [row('发语音吧，不过现在别发语音')] }).reason, 'explicit_text');
  assert.equal(choose({ sourceRows: [row('用文字回复'), row('我刚才说的那个')] }).reason, 'explicit_text');
  for (const text of ['我不想听语音了', '语音不用了', '改成文字吧', '打字就好', '别说话，用文字']) {
    assert.equal(choose({ sourceRows: [row(text)] }).selected, false, text);
  }
});

test('quoted, reported, recalled and pending transcription text cannot authorize a delivery-format change', () => {
  for (const candidate of [row('用语音回答', { quote: { text: '原文' } }), row('他说用语音回答'),
    row('“用语音回答我”'), row('> 发语音'), row('发语音', { recalled: true }),
    row('发语音', { state: 'revoked' }), row('发语音', { interaction: 'image' }),
    row('发语音', { interaction: 'voice', voiceState: 'pending' })]) {
    assert.equal(choose({ sourceRows: [candidate] }).selected, false, JSON.stringify(candidate));
  }
  assert.equal(choose({ sourceRows: [row('发语音'), row('他说不要语音')] }).reason, 'explicit_voice');
  assert.equal(choose({ sourceRows: [row('不要语音'), row('发语音', { quote: {} })] }).reason, 'explicit_text');
  assert.equal(choose({ sourceRows: [row('发语音', { interaction: 'voice', voiceState: 'done' })] }).reason, 'explicit_voice');
});

test('voice discussion alone is not a request and cannot randomly enable voice', () => {
  for (const text of ['这个声音还行', '语音好怪', '我朋友昨天发了条语音', '我发语音给他了', '我以后用语音聊天', '这个音色是什么']) {
    assert.equal(choose({ sourceRows: [row(text)] }).selected, false, text);
  }
});

test('casual selection is bounded by reply kind, factual question signal and length', () => {
  for (const kind of ['ordinary', 'followup', 'mention']) assert.equal(choose({ kind }).selected, true, kind);
  for (const kind of ['plan', 'question', 'life_event', 'interest_update', 'proactive', undefined]) {
    assert.equal(choose({ kind }).selected, false, String(kind));
  }
  assert.equal(choose({ isQuestion: true }).reason, 'question_requires_text');
  assert.equal(choose({ isQuestion: 'false' }).selected, false);
  assert.equal(choose({ text: '好'.repeat(80) }).selected, true);
  assert.equal(choose({ text: '好'.repeat(81) }).reason, 'random_voice_too_long');
  assert.equal(choose({ text: '好'.repeat(160), sourceRows: [row('发语音')] }).selected, true);
  assert.equal(choose({ text: '好'.repeat(161), sourceRows: [row('发语音')] }).reason, 'explicit_voice_too_long');
});

test('voice never replaces empty, punctuation-only, links, code, contact details or serious topics', () => {
  for (const text of ['', '  ', '?', '😂', '看 https://example.test/a', '[链接](https://example.test)',
    '执行 `ls`', 'const value = 1', 'a => a + 1', 'abc@example.test', '手机 13800138000',
    '电话 1-3-8-0-0-1-3-8-0-0-0', '验证码是 1234', '密码我发你', '住院了要先好好休息']) {
    assert.equal(choose({ text, sourceRows: [row('发语音')] }).selected, false, text);
  }
  assert.equal(choose({ sourceRows: [row('今天要去做手术')] }).reason, 'serious_topic');
  assert.equal(choose({ sourceRows: [row('来个语音'), row('life event')], kind: 'life_event' }).selected, false);
  assert.equal(choose({ sourceRows: [row('来个语音')], kind: 'interest_update' }).selected, false);
  assert.equal(choose({ text: '有点困，吃了2口就不想动了' }).selected, true);
});

test('probability is strictly validated and never re-sampled for the same durable reply key', async () => {
  for (const probability of [-1, 1.01, NaN, Infinity, '0.15', null, true]) {
    assert.throws(() => choose({ probability }), /probability/u);
  }
  assert.equal(choose({ probability: 0 }).selected, false);
  assert.equal(choose({ probability: 1 }).selected, true);
  for (const key of [undefined, '', '\0bad']) assert.equal(choose({ key }).reason, 'missing_stable_key');
  // A fresh module instance models a worker restart without invoking an engine or sender.
  const restarted = await import('../packages/voice/selection.mjs?restart-test');
  for (let i = 0; i < 100; i++) {
    const input = options({ probability: 0.15, key: `reply-${i}` });
    const result = chooseVoiceReply(input);
    assert.deepEqual(chooseVoiceReply(input), result);
    assert.deepEqual(restarted.chooseVoiceReply(input), result);
  }
});

test('default deterministic sampling is near 15 percent over distinct keys and is monotonic with configuration', () => {
  let count = 0;
  for (let i = 0; i < 10000; i++) {
    const input = options({ key: `sample-${i}` }); delete input.probability;
    const normal = chooseVoiceReply(input).selected;
    if (normal) count++;
    if (chooseVoiceReply({ ...input, probability: 0.05 }).selected) assert.equal(normal, true);
    if (normal) assert.equal(chooseVoiceReply({ ...input, probability: 0.30 }).selected, true);
  }
  assert.ok(count > 1300 && count < 1700, `15% fixture selected ${count}/10000`);
});
