import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createBehaviorModel, applyInteractionPreferences } from '../packages/participation/behavior-model.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { runProactiveCycle } from '../packages/participation/proactive.mjs';

const input = () => ({ target: { id: 'msg', senderId: 'alice', text: '肥鱼，来打三角洲', at: new Date().toISOString(), sourceIds: ['msg'] },
  context: [], coreFacts: [], personProfile: { userId: 'alice', displayName: '阿甲', preferredNames: ['小胖', '阿甲'] }, relatedProfiles: [] });
test('valid ordinary reply costs one call; game promises receive at most one correction', async () => {
  let calls = 0;
  const model = createBehaviorModel({ model: async x => {
    calls++;
    if (calls === 1) return { shouldReply: true, reply: '我这就上号，你拉我', pat: true };
    assert.match(x.behaviorCorrection, /不能/);
    return { shouldReply: true, reply: '我只能围观，你们打吧' };
  } });
  assert.equal((await model(input())).reply, '我只能围观，你们打吧');
  assert.equal(calls, 2);
  calls = 0;
  const good = createBehaviorModel({ model: async () => { calls++; return { reply: '好哇，看看你们打得咋样' }; } });
  await good(input());
  assert.equal(calls, 1);
  calls = 0;
  const bad = createBehaviorModel({ model: async () => { calls++; return { shouldReply: true, reply: '我这就上号，你拉我', pat: true, voice: true }; } });
  assert.deepEqual(await bad(input()), { shouldReply: false, reply: '', reason: 'host_behavior_constraint', confidence: 1 });
  assert.equal(calls, 2);
});
test('per-person names override curated aliases, with no mutation or cross-person bleed', async () => {
  const original = input(); let seen;
  const model = createBehaviorModel({ lookupPreferences: id => id === 'alice'
    ? { voiceDisabled: true, blockedNames: ['小胖'], preferredName: '小林' } : {},
    model: async x => { seen = x; return { reply: '小林，来啦' }; } });
  await model(original);
  assert.deepEqual(seen.personProfile.preferredNames, ['小林', '阿甲']);
  assert.equal(seen.personProfile.interactionPreferences.voiceDisabled, true);
  assert.deepEqual(original.personProfile.preferredNames, ['小胖', '阿甲']);
  assert.equal(applyInteractionPreferences({ displayName: '乙', preferredNames: ['小胖'] }).preferredNames[0], '小胖');
});
test('learned interpretations reach the user data, never the system prompt', () => {
  const messages = participationMessages({ ...input(), learnedSlangAnnotator: () => [{ surface: '新梗', intended: '自定义释义', confidence: 'learned_suggestion', status: 'suggested' }] });
  assert.ok(!messages[0].content.includes('自定义释义'));
  const data = JSON.parse(messages[1].content);
  assert.equal(data.learnedSlangDefinitions[0].intended, '自定义释义');
  assert.equal(data.target.learnedSlangRefs[0], data.learnedSlangDefinitions[0].ref);
});

function fixture(t) {
  const base = new URL('../.runtime/test-tmp/', import.meta.url);
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base.pathname.replace(/^\/(\w:)/u, '$1'), 'behavior-'));
  const accountId = 'account-test', groupId = 'group@chatroom', selfUserId = 'self';
  const source = new AdapterStore(join(dir, 'source.sqlite'), accountId);
  const store = new AdapterStore(join(dir, 'ledger.sqlite'), accountId);
  const ledger = new ParticipationLedger(store);
  const sent = [];
  const client = { accountId, send: async (destination, text, key, _signal, mentions) => {
    sent.push({ text, mentions }); return { id: key, accountId, destination, state: 'accepted' }; } };
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId, sendingEnabled: true, cooldownMs: 0 });
  const now = Date.parse('2026-11-13T13:00:00Z');
  const insert = (text, at = now) => source.commitEvent('1', { accountId, groupId, userId: 'alice', sourceMessageId: 'msg', text,
    eventTime: new Date(at).toISOString(), recordedAt: new Date(at).toISOString(), mentions: { self: true, userIds: [] }, interaction: 'text' }, 'text');
  t.after(() => { source.close(); store.close(); });
  return { source, store, ledger, adapter, accountId, groupId, inboxPath: join(dir, 'source.sqlite'), now, insert, sent };
}
test('persistent voice opt-out keeps a mandatory reply as text without synthesizing', async t => {
  const f = fixture(t); f.insert('肥鱼在吗'); let voices = 0;
  const options = { ...f, sendEnabled: true, startAtLatest: false, lookupInteractionPreferences: () => ({ voiceDisabled: true }),
    voiceRandomProbability: 1, sendVoice: async () => { voices++; throw new Error('must not synthesize'); },
    model: async () => ({ shouldReply: true, reply: '在呢，咋啦', isAddressed: true,
      isQuestion: false, isFollowup: false, answeredByHuman: false, reason: 'called' }) };
  await runParticipationCycle(options);
  const result = await runParticipationCycle({ ...options, now: f.now + 20000 });
  assert.equal(result.status, 'sent'); assert.equal(voices, 0); assert.equal(f.sent.length, 1);
});
test('adapter evaluates the last-moment policy before it claims or sends a draft', async t => {
  const f = fixture(t);
  f.adapter.propose({ key: 'test-key', groupId: f.groupId, text: '小胖，来了' }); f.store.approve('test-key');
  const result = await f.adapter.sendApproved('test-key', undefined, { authorize: () => false });
  assert.equal(result.state, 'cancelled'); assert.equal(f.sent.length, 0);
});
test('proactive mentions exclude opt-outs, and recheck if changed during generation', async t => {
  const f = fixture(t); f.insert('今晚玩啥', f.now - 20 * 60000); let blocked = false;
  const result = await runProactiveCycle({ ...f, sendEnabled: true, lookupInteractionPreferences: () => ({ proactiveMentionDisabled: blocked }),
    memberCandidates: [{ userId: 'alice', displayName: '阿甲' }], model: async x => {
      assert.equal(x.initiative.mentionCandidates.length, 1); blocked = true;
      return { shouldReply: true, reply: '阿甲，今天玩啥呀', mentionUserId: 'alice' };
    } });
  assert.equal(f.sent.length, 0); assert.equal(result.status, 'needs_review');
});
test('a nickname opt-out is checked even for an unmentioned proactive subject', async t => {
  const f = fixture(t); f.insert('今晚玩啥', f.now - 20 * 60000); let blocked = false;
  const result = await runProactiveCycle({ ...f, sendEnabled: true,
    lookupInteractionPreferences: () => ({ blockedNames: blocked ? ['小胖'] : [] }),
    memberCandidates: [{ userId: 'alice', displayName: '阿甲' }], model: async () => {
      blocked = true; return { shouldReply: true, reply: '小胖最近忙啥呢', mentionUserId: null };
    } });
  assert.equal(f.sent.length, 0); assert.equal(result.status, 'needs_review');
});
test('a reply checks names of other context participants, not only its focus', async t => {
  const f = fixture(t);
  f.source.commitEvent('0', { accountId: f.accountId, groupId: f.groupId, userId: 'bob', sourceMessageId: 'msg-b',
    text: '刚吃完饭', eventTime: new Date(f.now - 1000).toISOString(), recordedAt: new Date(f.now).toISOString() }, 'text');
  f.insert('肥鱼在吗'); let blocked = false;
  const options = { ...f, sendEnabled: true, startAtLatest: false,
    lookupInteractionPreferences: id => ({ blockedNames: blocked && id === 'bob' ? ['小胖'] : [] }),
    model: async () => { blocked = true; return { shouldReply: true, reply: '在呢，阿甲和小胖都来啦',
      isAddressed: true, isQuestion: false, isFollowup: false, answeredByHuman: false, reason: 'called' }; } };
  await runParticipationCycle(options);
  const result = await runParticipationCycle({ ...options, now: f.now + 20000 });
  assert.equal(result.status, 'deferred'); assert.equal(f.sent.length, 0);
});
