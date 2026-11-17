import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger, runParticipationCycle, observeNewMessages } from '../packages/participation/index.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
const accountId = 'a', groupId = 'g@chatroom', now = Date.parse('2026-11-13T06:00:00Z');
const reply = extra => ({ shouldReply: true, reply: '咋啦，我在听呢', reason: 'test',
  isQuestion: false, isAddressed: true, isFollowup: false, answeredByHuman: false, ...extra });
function fixture(t, text = '肥鱼，发个语音') {
  const dir = mkdtempSync(join(tmpdir(), 'social-runtime-')), inboxPath = join(dir, 'inbox.sqlite');
  const inbox = new AdapterStore(inboxPath, accountId), store = new AdapterStore(join(dir, 'out.sqlite'), accountId);
  const ledger = new ParticipationLedger(store); let sends = 0, sentQuote;
  const client = { accountId, message: async id => ({ id, accountId, threadId: groupId, senderId: 'friend', type: 1, serverId: '9007199254740999' }),
    send: async (thread, body, key, signal, mentions, quote) => { sends++; sentQuote = quote; return { id: 'receipt', accountId, destination: thread, state: 'accepted' }; } };
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId: 'self', sendingEnabled: true, cooldownMs: 0 });
  inbox.commitEvent('1', { accountId, groupId, userId: 'friend', sourceMessageId: 'm1', text,
    serverId: '9007199254740999', eventTime: new Date(now).toISOString(), recordedAt: new Date(now).toISOString(), mentions: { self: true, state: 'known', userIds: [] } }, 'text');
  observeNewMessages({ ledger, inboxPath, accountId, groupId, now, startAtLatest: false });
  t.after(() => { inbox.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const run = extra => runParticipationCycle({ ledger, adapter, model: async () => reply({}),
    inboxPath, accountId, groupId, now: now + 30000, startAtLatest: false, sendEnabled: true, ...extra });
  return { run, ledger, store, inbox, inboxPath, client, adapter, get sends() { return sends; }, get sentQuote() { return sentQuote; } };
}
test('model-selected quote is persisted and passed to the actual send with uint64 string intact', async t => {
  const f = fixture(t, '肥鱼，刚才这句你怎么看');
  const quote = { messageId: 'm1', serverId: '9007199254740999' };
  const result = await f.run({ model: async () => reply({ quoteMessageId: 'm1', focusMessageId: 'm1' }), resolveQuote: () => quote });
  assert.equal(result.status, 'sent'); assert.deepEqual(f.sentQuote, quote);
  assert.deepEqual(JSON.parse(f.store.sendRecord(result.key).quote_json), quote);
  assert.throws(() => f.store.draft(result.key, groupId, f.store.sendRecord(result.key).text, [], { ...quote, serverId: '7' }), /conflict/);
});
test('revoked remote quote source fails before posting and voice records bypass text reconciliation', async t => {
  const f = fixture(t); f.client.message = async id => ({ id, accountId, threadId: groupId, serverId: '1', recall: true });
  f.adapter.propose({ key: 'q', groupId, text: '引用回复', quote: { messageId: 'm1', serverId: '1' } }); f.store.approve('q');
  assert.equal((await f.adapter.sendApproved('q')).state, 'failed'); assert.equal(f.sends, 0);
  f.store.draft('v', groupId, '已发语音'); f.store.receipt('v', 'needs_review', { channel: 'voice', voiceKey: 'voice-1' });
  assert.equal((await f.adapter.reconcile('v')).state, 'needs_review');
});
test('explicit voice request uses one voice path and unknown receipt never adds text', async t => {
  const f = fixture(t); let voices = 0;
  const result = await f.run({ model: async () => reply({ voice: true }), sendVoice: async () => { voices++; return { state: 'pending_receipt', safeToFallback: false }; } });
  assert.equal(result.status, 'needs_review'); assert.equal(voices, 1); assert.equal(f.sends, 0);
});
test('model voice alone cannot override random rate zero; known synthesis failure falls back to text', async t => {
  const first = fixture(t, '肥鱼，你在干嘛'); let voices = 0;
  await first.run({ voiceRandomProbability: 0, model: async () => reply({ voice: true }), sendVoice: async () => { voices++; } });
  assert.equal(voices, 0); assert.equal(first.sends, 1);
  const second = fixture(t);
  await second.run({ model: async () => reply({ voice: true }), sendVoice: async () => ({ state: 'not_sent', safeToFallback: true }) });
  assert.equal(second.sends, 1);
});
test('existing decision may record life-event evidence without a second model request', async t => {
  const f = fixture(t, '肥鱼，我明天面试'); let models = 0, proposals;
  await f.run({ model: async input => { models++; assert.equal(input.futureEvents[0].id, 'e1'); return reply({ lifeEvents: [{ sourceMessageId: 'm1', action: 'upsert' }] }); },
    lookupLifeEvents: () => [{ id: 'e1' }], recordLifeEvents: (p, messages) => { proposals = p; assert.ok(messages.some(x => x.id === 'm1')); } });
  assert.equal(models, 1); assert.equal(proposals.length, 1);
  const prompt = participationMessages({ target: { id: 'm1', text: '', sourceIds: [] }, context: [], kind: 'mention', mustReply: true,
    coreFacts: [], latestDiary: null, futureEvents: [{ id: 'e1', subjectId: 'friend' }] });
  const future = JSON.parse(prompt[1].content).futureEvents[0]; assert.match(future.speakerKey, /^M_/); assert.equal(future.subjectId, undefined);
});
test('negative and reported voice requests never invoke synthesis or voice send', async t => {
  for (const text of ['肥鱼，别发语音', '肥鱼，不要用语音回复', '肥鱼，他说用语音回答']) {
    const f = fixture(t, text); let voices = 0;
    await f.run({ model: async () => reply({ voice: true }), sendVoice: async () => { voices++; throw new Error('must not send'); } });
    assert.equal(voices, 0); assert.equal(f.sends, 1);
  }
});

test('later cancellation in the same merged turn overrides the earlier voice request', async t => {
  const f = fixture(t); let voices = 0;
  f.inbox.commitEvent('2', { accountId, groupId, userId: 'friend', sourceMessageId: 'm2',
    text: '算了别发语音了，打字吧', eventTime: new Date(now + 1000).toISOString(),
    recordedAt: new Date(now + 1000).toISOString() }, 'text');
  observeNewMessages({ ledger: f.ledger, inboxPath: f.inboxPath, accountId, groupId, now: now + 1000, startAtLatest: false });
  await f.run({ model: async () => reply({ voice: true }), sendVoice: async () => { voices++; throw new Error('cancelled voice must not send'); } });
  assert.equal(voices, 0); assert.equal(f.sends, 1);
});

test('casual voice replacement uses the existing model reply exactly once', async t => {
  const f = fixture(t, '肥鱼，今天又在躺着呢'); let voices = 0, models = 0;
  const result = await f.run({ voiceRandomProbability: 1,
    model: async () => { models++; return reply({ voice: false }); },
    sendVoice: async ({ text }) => { voices++; assert.equal(text, '咋啦，我在听呢'); return { state: 'sent', safeToFallback: false }; } });
  assert.equal(result.status, 'sent'); assert.equal(models, 1); assert.equal(voices, 1); assert.equal(f.sends, 0);
});

test('explicit voice works with random disabled and without a model voice flag', async t => {
  const f = fixture(t); let voices = 0;
  await f.run({ voiceRandomProbability: 0, model: async () => reply({ voice: false }),
    sendVoice: async () => { voices++; return { state: 'sent', safeToFallback: false }; } });
  assert.equal(voices, 1); assert.equal(f.sends, 0);
});

test('negative requests, factual questions, links and selected quotes remain text at rate one', async t => {
  for (const [text, decision] of [
    ['肥鱼，别发语音', {}],
    ['肥鱼，现在几点了', { isQuestion: true, reply: '现在两点。' }],
    ['肥鱼，发我看看', { reply: '在这里：https://example.com' }],
    ['肥鱼，今天又在躺着呢', { quoteMessageId: 'm1' }],
  ]) {
    const f = fixture(t, text); let voices = 0;
    await f.run({ voiceRandomProbability: 1, model: async () => reply(decision),
      sendVoice: async () => { voices++; throw new Error('must stay text'); } });
    assert.equal(voices, 0); assert.equal(f.sends, 1);
  }
});

test('random voice with unknown receipt never adds text and malformed rate safely keeps text', async t => {
  const f = fixture(t, '肥鱼，今天又在躺着呢');
  const result = await f.run({ voiceRandomProbability: 1,
    sendVoice: async () => ({ state: 'pending_receipt', safeToFallback: false }) });
  assert.equal(result.status, 'needs_review'); assert.equal(f.sends, 0);
  const second = fixture(t, '肥鱼，今天又在躺着呢');
  await second.run({ voiceRandomProbability: NaN, sendVoice: async () => { throw new Error('must not synthesize'); } });
  assert.equal(second.sends, 1);
});
