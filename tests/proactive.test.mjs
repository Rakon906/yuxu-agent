import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { proactiveOpportunity, runProactiveCycle } from '../packages/participation/proactive.mjs';
import { createConversationMemoryContext } from '../packages/participation/memory-context.mjs';

const accountId = 'account-test';
const groupId = 'group@chatroom';
const now = Date.parse('2026-11-04T13:00:00Z'); // 21:00 in Shanghai

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'sociomem-proactive-'));
  const source = new AdapterStore(join(dir, 'source.sqlite'), accountId);
  const store = new AdapterStore(join(dir, 'participation.sqlite'), accountId);
  const ledger = new ParticipationLedger(store);
  let sends = 0;
  const adapter = {
    propose({ key, groupId: destination, text, mentionUserIds }) {
      return store.draft(key, destination, text, mentionUserIds);
    },
    async sendApproved(key) { sends++;
      store.db.prepare('UPDATE outbox SET attempted_at=? WHERE key=?').run(now, key);
      return store.receipt(key, 'accepted', {
      id: `send-${sends}`, accountId, destination: groupId, state: 'accepted' }); },
  };
  const incoming = (id, at = now - 20 * 60000) => source.commitEvent(String(Number(id) + 1), {
    accountId, groupId, userId: 'friend', sourceMessageId: id, text: '今晚有人打游戏吗',
    eventTime: new Date(at).toISOString(), recordedAt: new Date(at).toISOString(),
  }, 'text');
  const run = (model, options = {}) => runProactiveCycle({ ledger, adapter, model,
    inboxPath: join(dir, 'source.sqlite'), accountId, groupId, sendEnabled: true, now,
    routineMember: { displayName: '示例成员37', preferredNames: ['示例成员47'] },
    lookupIdentity: () => ({ displayName: '群友' }), ...options });
  return { dir, source, store, ledger, adapter, incoming, run, get sends() { return sends; },
    close() { source.close(); store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('Shanghai time allows open checks from noon and reserves nine o’clock', () => {
  assert.equal(proactiveOpportunity(now)?.name, 'nine');
  assert.equal(proactiveOpportunity(now - 3 * 3600000)?.name, 'open');
  assert.equal(proactiveOpportunity(now - 10 * 3600000), null);
  assert.equal(proactiveOpportunity(now + 3 * 3600000), null);
});

test('model can decline an initiative; once evaluated it is not polled repeatedly', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const model = async input => { calls++; assert.equal(input.initiative.routine.preferredName, '示例成员47');
      assert.equal(input.initiative.dailyMinimumDue, undefined);
      assert.match(input.initiative.instruction, /没有合适内容就不发/);
      return { shouldReply: false, reply: '', reason: '没合适的话题' }; };
    assert.equal((await f.run(model)).status, 'skipped');
    assert.equal((await f.run(model)).status, 'waiting');
    assert.equal(calls, 1);
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('natural initiative sends once and cannot duplicate after another cycle', async () => {
  const f = fixture();
  try {
    f.incoming('1');
    const model = async input => {
      assert.equal(input.context.length, 1);
      return { shouldReply: true, reply: '今晚怎么都这么安静，示例成员47呢。', reason: '晚间开话题' };
    };
    assert.equal((await f.run(model)).status, 'sent');
    assert.equal((await f.run(model)).status, 'waiting');
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('new incoming message during model call cancels stale initiative', async () => {
  const f = fixture();
  try {
    f.incoming('1');
    const result = await f.run(async () => {
      f.incoming('2', now + 1000);
      return { shouldReply: true, reply: '今晚聊点啥', reason: '开话题' };
    });
    assert.equal(result.status, 'skipped');
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('recent agent post suppresses initiative without a model call', async () => {
  const f = fixture();
  try {
    f.store.draft('prior', groupId, '先前的回复');
    f.store.db.prepare(`UPDATE outbox SET state='accepted',attempted_at=? WHERE key='prior'`)
      .run(now - 30 * 60000);
    assert.equal((await f.run(() => { throw new Error('model should not be called'); })).status, 'waiting');
  } finally { f.close(); }
});

test('open topic checks are spaced, durable, and can run again later the same day', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const model = async () => { calls++; return { shouldReply: false, reply: '', reason: '暂时没话题' }; };
    const afternoon = now - 3 * 3600000;
    assert.equal((await f.run(model, { now: afternoon })).status, 'skipped');
    assert.equal((await f.run(model, { now: afternoon + 5 * 60000 })).status, 'waiting');
    assert.equal((await f.run(model, { now: afternoon + 100 * 60000 })).status, 'skipped');
    assert.equal(calls, 2);
  } finally { f.close(); }
});

test('a model-selected member is actually mentioned and an ignored mention gets one optional reaction', async () => {
  const f = fixture();
  try {
    const candidates = [{ userId: 'friend', displayName: '示例成员47', preferredNames: ['示例成员47'] }];
    const first = await f.run(async input => {
      assert.equal(input.initiative.mentionCandidates[0].userId, 'friend');
      return { shouldReply: true, reply: '示例成员47，今天还开黑吗',
        mentionUserId: 'friend', reason: '找群友聊天' };
    }, { memberCandidates: candidates });
    assert.equal(first.status, 'sent');
    assert.equal(f.store.sendRecord(first.key).mentions_json, '["friend"]');
    const followup = await f.run(async input => {
      assert.equal(input.kind, 'proactive_followup');
      assert.equal(input.target.senderId, 'friend');
      return { shouldReply: true, reply: '好吧，示例成员47这回装没听见。',
        mentionUserId: null, reason: '轻微吐槽' };
    }, { now: now + 45 * 60000, memberCandidates: candidates });
    assert.equal(followup.status, 'sent');
    assert.equal(f.sends, 2);
    assert.equal((await f.run(() => { throw new Error('no third reply'); },
      { now: now + 46 * 60000 })).status, 'waiting');
  } finally { f.close(); }
});

test('target member speaking after an @ cancels the ignored-member reaction', async () => {
  const f = fixture();
  try {
    await f.run(async () => ({ shouldReply: true, reply: '示例成员47在吗',
      mentionUserId: 'friend', reason: '找人' }),
    { memberCandidates: [{ userId: 'friend', displayName: '示例成员47' }] });
    f.incoming('3', now + 5 * 60000);
    assert.equal((await f.run(() => { throw new Error('model should not run'); },
      { now: now + 45 * 60000 })).status, 'answered');
    assert.equal(f.sends, 1);
  } finally { f.close(); }
});

test('trend context reaches the proactive model and an interest-matched mention sends', async t => {
  const f = fixture();
  try {
    f.incoming('1');
    const trendTopics = [{ title: '三角洲新赛季上线', summary: '新干员和新地图',
      topic: '游戏', category: '游戏', source: 'zhihu', lastSeenAt: new Date(now).toISOString() }];
    const candidates = [{ userId: 'friend', displayName: '示例成员47',
      interests: [{ topic: '游戏', terms: ['三角洲'], messages: 4 }] }];
    const result = await f.run(async input => {
      assert.equal(input.trendContext[0].title, '三角洲新赛季上线');
      assert.equal(input.trendContext[0].topic, '游戏');
      assert.equal(input.initiative.mentionCandidates[0].interests[0].topic, '游戏');
      assert.deepEqual(input.memorySubjectIds, ['friend']);
      return { shouldReply: true, reply: '三角洲新赛季你们玩了吗',
        mentionUserId: 'friend', reason: '新赛季话题' };
    }, { trendTopics, memberCandidates: candidates });
    assert.equal(result.status, 'sent');
    assert.equal(f.store.sendRecord(result.key).mentions_json, '["friend"]');
  } finally { f.close(); }
});

test('proactive model boundary loads diary and profiles once, waiting cycles do no retrieval', async () => {
  const f = fixture();
  try {
    f.incoming('1');
    let diaryCalls = 0, modelCalls = 0;
    const profile = { userId: 'friend', displayName: '示例成员47', facts: [{ fact: '喜欢三角洲' }],
      observations: [{ category: 'interest', topic: '三角洲' }] };
    const memory = createConversationMemoryContext({ accountId, groupId,
      getMemberIds: () => ['friend'], lookupProfile: () => profile,
      lookupLatestDiary: () => ({ title: '上次约局' }),
      lookupDiary: async () => { diaryCalls++; return [{ id: 'd1', text: '示例成员47之前约过三角洲' }]; },
      lookupRelatedProfiles: () => [profile] });
    const model = async input => {
      const prepared = await memory.enrich(input);
      modelCalls++;
      assert.equal(prepared.context[0].id, '1');
      assert.equal(prepared.relevantDiary[0].id, 'd1');
      assert.equal(prepared.relatedProfiles[0].facts[0].fact, '喜欢三角洲');
      return { shouldReply: false, reply: '', reason: '没有自然话题' };
    };
    assert.equal((await f.run(model)).status, 'skipped');
    assert.equal((await f.run(model)).status, 'waiting');
    assert.equal(modelCalls, 1);
    assert.equal(diaryCalls, 1);
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('a mention is dropped when the member interests do not match the trend', async t => {
  const f = fixture();
  try {
    f.incoming('1');
    const trendTopics = [{ title: '三角洲新赛季上线', summary: '新干员和新地图',
      topic: '游戏', category: '游戏', source: 'zhihu', lastSeenAt: new Date(now).toISOString() }];
    const candidates = [{ userId: 'friend', displayName: '示例成员47',
      interests: [{ topic: '旅游', terms: ['自驾'], messages: 3 }] }];
    const result = await f.run(async () => ({ shouldReply: true, reply: '三角洲新赛季你们玩了吗',
      mentionUserId: 'friend', reason: '新赛季话题' }),
    { trendTopics, memberCandidates: candidates });
    assert.equal(result.status, 'skipped');
    assert.equal(f.sends, 0);
  } finally { f.close(); }
});

test('a proactive reply cannot invent a match schedule from a hot-search item', async t => {
  const f = fixture();
  try {
    f.incoming('1');
    const trendTopics = [{ title: 'S16 决赛 BLG vs GEN', summary: 'BLG 将对阵 GEN',
      topic: '电竞', category: '电竞', source: 'zhihu', lastSeenAt: new Date(now).toISOString() }];
    const result = await f.run(async () => ({ shouldReply: true,
      reply: 'BLG进决赛了，周末看不看比赛啊', reason: '决赛话题' }), { trendTopics });
    assert.equal(result.status, 'skipped');
    assert.equal(f.sends, 0);
    assert.equal(f.ledger.db.prepare('SELECT reason FROM proactive_slots ORDER BY checked_at DESC LIMIT 1')
      .get().reason, 'unsupported_schedule');
  } finally { f.close(); }
});

test('a schedule the group already mentioned is allowed', async t => {
  const f = fixture();
  try {
    f.incoming('1'); // 群里这条消息本身就说了“今晚”
    const trendTopics = [{ title: 'S16 决赛 BLG vs GEN', summary: 'BLG 将对阵 GEN',
      topic: '电竞', category: '电竞', source: 'zhihu', lastSeenAt: new Date(now).toISOString() }];
    const result = await f.run(async () => ({ shouldReply: true,
      reply: '今晚看比赛吗', reason: '接群里的今晚' }), { trendTopics });
    assert.equal(result.status, 'sent');
  } finally { f.close(); }
});

test('a queued proactive send is reconciled by receipt without another post', async () => {
  const f = fixture();
  try {
    let posts = 0;
    f.adapter.sendApproved = async key => {
      posts++;
      f.store.db.prepare('UPDATE outbox SET attempted_at=? WHERE key=?').run(now, key);
      return f.store.receipt(key, 'queued', { id: 'queued-1', accountId,
        destination: groupId, state: 'queued' });
    };
    f.adapter.reconcile = async key => f.store.receipt(key, 'accepted', { id: 'queued-1',
      accountId, destination: groupId, state: 'accepted' });
    assert.equal((await f.run(async () => ({ shouldReply: true, reply: '聊两句？',
      reason: '开话题' }))).status, 'pending_receipt');
    assert.equal((await f.run(() => { throw new Error('model should not run'); },
      { now: now + 61000 })).status, 'sent');
    assert.equal(posts, 1);
  } finally { f.close(); }
});
