import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationMemoryContext, memoryQueryTarget } from '../packages/participation/memory-context.mjs';
import { participationMessages } from '../packages/participation/model.mjs';

const profile = userId => ({ userId, displayName: userId,
  facts: [{ fact: '喜欢 BLG', category: 'interest' }],
  observations: [{ subjectId: userId, category: 'interest', topic: 'BLG', state: 'repeated', evidence: [] }] });
const diary = { id: 'd1', title: '一起看决赛', text: 'friend 说喜欢 BLG', sourceMessageIds: ['s1'] };
const context = [{ id: 'm1', senderId: 'friend', text: 'BLG 比赛聊起来', at: '2026-11-16T04:00:00Z' }];
function fixture(overrides = {}) {
  const loaded = [], errors = [], calls = { diary: 0, profile: 0 };
  const memory = createConversationMemoryContext({ accountId: 'a', groupId: 'g@chatroom',
    getMemberIds: () => ['friend', 'other', 'idle'],
    lookupContext: () => context,
    lookupProfile: id => { calls.profile++; return profile(id); },
    lookupDiary: async () => { calls.diary++; return [diary]; },
    lookupRelatedProfiles: (target, recent) => recent.filter(item => item.senderId !== target.senderId).map(item => profile(item.senderId)),
    lookupLatestDiary: () => ({ title: diary.title, summary: diary.text }),
    onLoaded: value => loaded.push(value), onError: value => errors.push(value), ...overrides });
  return { memory, loaded, errors, calls };
}
function input(kind, senderId) {
  return { kind, target: { id: `task-${kind}`, text: '', senderId, at: '2026-11-16T05:00:00Z' },
    context: [], coreFacts: [], relevantDiary: [], relatedProfiles: [], personProfile: null };
}

test('all autonomous kinds receive context, diary and involved people at the same boundary', async () => {
  for (const kind of ['proactive', 'proactive_followup', 'member_welcome', 'life_event', 'interest_update']) {
    const f = fixture();
    const enriched = await f.memory.enrich(input(kind, kind === 'proactive' ? undefined : 'other'));
    assert.equal(enriched.context.length, 1);
    assert.equal(enriched.relevantDiary[0].id, 'd1');
    assert.equal(enriched.latestDiary.title, diary.title);
    assert.equal(enriched.relatedProfiles[0].userId, 'friend');
    assert.equal(enriched.relatedProfiles[0].observations[0].category, 'interest');
    assert.equal(enriched.personProfile?.userId, kind === 'proactive' ? undefined : 'other');
    assert.equal(enriched.relatedProfiles.some(item => item.userId === 'idle'), false);
    const payload = JSON.parse(participationMessages(enriched)[1].content);
    assert.equal(payload.relevantDiary[0].id, 'd1');
    assert.equal(payload.relatedProfiles[0].observations.length, 1);
    assert.equal(payload.conversation.length, 1);
    assert.equal(f.loaded[0].stage, 'selected_before_prompt_budget');
    assert.equal(f.loaded[0].diaryCount, 1);
    assert.equal(f.loaded[0].contextMessageCount, 1);
    assert.equal(Object.hasOwn(f.loaded[0], 'text'), false);
  }
});

test('ordinary replies keep evidence lookup results and never repeat retrieval at the model boundary', async () => {
  const f = fixture();
  const prepared = f.memory.markLoaded({ ...input('ordinary', 'friend'), context,
    relevantDiary: [diary], personProfile: profile('friend'), latestDiary: { title: diary.title } });
  // Behavior/moments wrappers spread inputs; host-only metadata survives them.
  const result = await f.memory.enrich({ ...prepared, behaviorCorrection: null });
  assert.deepEqual(result.relevantDiary, [diary]);
  assert.equal(f.calls.diary, 0);
  assert.equal(f.calls.profile, 0);
  assert.equal(f.loaded.length, 1);
  assert.equal(JSON.stringify(result).includes('conversation-memory-scope'), false);
});

test('another group cannot reuse the prepared marker or inject out-of-roster profiles', async () => {
  const first = fixture();
  const prepared = first.memory.markLoaded({ ...input('proactive', 'foreign'),
    relatedProfiles: [profile('foreign')], relevantDiary: [{ ...diary, groupId: 'other@chatroom' }] });
  const second = fixture({ groupId: 'second@chatroom',
    lookupDiary: async () => [{ ...diary, groupId: 'g@chatroom' }, { ...diary, id: 'd2', groupId: 'second@chatroom' }],
    lookupRelatedProfiles: () => [profile('foreign'), profile('friend')] });
  const result = await second.memory.enrich(prepared);
  assert.equal(result.personProfile, null);
  assert.deepEqual(result.relatedProfiles.map(item => item.userId), ['friend']);
  assert.deepEqual(result.relevantDiary.map(item => item.id), ['d2']);
});

test('retrieval failures are visible but preserve live context without invented memory', async () => {
  const f = fixture({ lookupDiary: async () => { throw new Error('offline'); },
    lookupProfile: () => { throw new Error('locked'); },
    lookupLatestDiary: () => { throw new Error('missing'); } });
  const result = await f.memory.enrich(input('life_event', 'other'));
  assert.deepEqual(result.context, context);
  assert.equal(result.personProfile, null);
  assert.deepEqual(result.relevantDiary, []);
  assert.equal(result.latestDiary, null);
  assert.deepEqual(f.errors.map(item => item.part).sort(), ['diary', 'latest_diary', 'person_profile']);
});

test('focused routine profile is retained but a list of possible mention targets is not a roster dump', async () => {
  const f = fixture();
  const result = await f.memory.enrich({ ...input('proactive'), relatedProfiles: [profile('other')],
    initiative: { mentionCandidates: [profile('idle')] } });
  assert.deepEqual(result.relatedProfiles.map(item => item.userId), ['other', 'friend']);
});

test('a topic-matched quiet member gets a full profile without importing every mention candidate', async () => {
  const f = fixture();
  const result = await f.memory.enrich({ ...input('proactive'), memorySubjectIds: ['other', 'foreign'],
    initiative: { mentionCandidates: [profile('other'), profile('idle')] } });
  assert.deepEqual(result.relatedProfiles.map(item => item.userId), ['other', 'friend']);
  assert.equal(result.relatedProfiles[0].observations.length, 1);
});

test('diary query uses the specific event and ignores behavioral instruction text', () => {
  const original = { ...input('life_event', 'friend'), initiative: {
    event: { topic: '面试', evidenceQuote: '我周一面试' }, instruction: '不作为检索主题' } };
  const query = memoryQueryTarget(original);
  assert.match(query.text, /面试/);
  assert.doesNotMatch(query.text, /检索主题/);
  assert.equal(original.target.text, '');
});

test('both ordinary and autonomous inputs compact only diary-covered history', async () => {
  const messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index}`, rowid: index + 1,
    senderId: 'friend', text: '记录', at: '2026-11-01T00:00:00Z' }));
  const f = fixture({ lookupConsolidatedThroughRowid: () => 100, lookupContext: () => messages });
  const prepared = f.memory.markLoaded({ ...input('ordinary', 'friend'), context: messages });
  const autonomous = await f.memory.enrich(input('proactive'));
  assert.equal(prepared.context.length, 80);
  assert.equal(autonomous.context.length, 80);
  assert.deepEqual(autonomous.context.map(item => item.id), prepared.context.map(item => item.id));
  assert.equal(autonomous.context.at(-1).rowid, 120);
});
