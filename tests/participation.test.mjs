import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { classifyParticipation, ParticipationLedger, runParticipationCycle,
  selectConversationContext } from '../packages/participation/index.mjs';
import { createAgentParticipationModel, createParticipationModel } from '../packages/participation/model.mjs';
import { createParticipationTools } from '../packages/participation/tools.mjs';
import { exportLabeledParticipation, labelParticipationMessage,
  listParticipationReview } from '../packages/participation/feedback.mjs';
import { projectRoot } from '../scripts/runtime.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN } from './fixtures/wechat-server.mjs';

const start = Date.parse('2026-11-02T14:00:00+08:00');
const answer = (reply, extra = {}) => ({ isQuestion: false, isAddressed: false,
  isFollowup: false, answeredByHuman: false, shouldReply: Boolean(reply), reply,
  reason: 'synthetic decision', ...extra });

async function setup(t, { sendEnabled = true, startAtLatest = false } = {}) {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'participation-test-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const source = new AdapterStore(inboxPath, ACCOUNT);
  const outbox = new AdapterStore(join(root, 'participation.sqlite'), ACCOUNT);
  const ledger = new ParticipationLedger(outbox);
  const server = await startWeChatFixture();
  const client = new WeChatClient({ baseUrl: server.origin, token: TOKEN, accountId: ACCOUNT });
  const adapter = new WeChatAdapter({ client, store: outbox, allowedGroups: [GROUP],
    selfUserId: SELF, sendingEnabled: sendEnabled, cooldownMs: 0 });
  let sequence = 0;
  const insert = (id, senderId, text, options = {}) => source.commitEvent(String(++sequence), {
    platform: 'wechat', accountId: ACCOUNT, groupId: GROUP, userId: senderId,
    sourceMessageId: id, text, eventTime: new Date(start).toISOString(),
    recordedAt: new Date(start).toISOString(), mentions: options.mentions ??
      { state: 'known', self: false, userIds: [] },
  }, 'text');
  t.after(async () => { source.close(); outbox.close(); await server.close(); });
  const cycle = (now, model, extra = {}) => runParticipationCycle({ ledger, adapter, model,
    inboxPath, accountId: ACCOUNT, groupId: GROUP, now, startAtLatest, sendEnabled, ...extra });
  return { root, source, outbox, ledger, server, insert, cycle };
}

test('verified default Moments evidence is admitted by the actual reply cycle without extra tool calls', async t => {
  const f = await setup(t, { sendEnabled: false });
  f.insert('moment-question', 'friend', '肥鱼，这条朋友圈是你发的吗');
  const proof = 'SNS_verified_own';
  let called = 0;
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 16000, async input => {
    called++;
    assert.equal(input.self.name, '肥鱼不肥');
    assert.equal(input.momentsContext.matches[0].id, proof);
    return answer('这条是我昨天发的呀', { evidenceIds: [proof] });
  }, { enrichModelInput: input => ({ ...input, self: { name: '肥鱼不肥' },
    momentsContext: { matches: [{ id: proof, sourceType: 'self_moment' }] } }) });
  assert.equal(called, 1);
  assert.equal(result.status, 'shadowed');
  assert.notEqual(f.ledger.db.prepare('SELECT reason FROM participation_tasks WHERE source_id=?').get('moment-question')?.reason,
    'unverifiable_tool_answer');
});

test('structured @ and names outrank questions; plain invitations count as questions', () => {
  assert.equal(classifyParticipation({ text: '你好', mentions: { self: true } }), 'mention');
  assert.equal(classifyParticipation({ text: '@SocioMem 过来', mentions: { self: false } }), 'mention');
  assert.equal(classifyParticipation({ text: '肥鱼不肥，过来', mentions: { self: false } }), 'mention');
  assert.equal(classifyParticipation({ text: '肥鱼 在吗', mentions: { self: false } }), 'mention');
  assert.equal(classifyParticipation({ text: '有人打游戏吗', mentions: { self: false } }), 'question');
  assert.equal(classifyParticipation({ text: '今天真热', mentions: { self: false } }), 'ordinary');
  assert.equal(classifyParticipation({ text: '我呢就先吃饭了', mentions: { self: false } }), 'ordinary');
  assert.equal(classifyParticipation({ text: '我也不知道为什么突然下雨', mentions: { self: false } }), 'ordinary');
  assert.equal(classifyParticipation({ text: '明天几点集合', mentions: { self: false } }), 'question');
  assert.equal(classifyParticipation({ text: '这个要怎么做', mentions: { self: false } }), 'question');
  assert.equal(classifyParticipation({ text: '周六九点集合', mentions: { self: false } }), 'plan');
  assert.equal(classifyParticipation({ text: '集合改到十点', mentions: { self: false } }), 'plan');
});

test('conversation window retains up to 999 messages without expiring quiet-day context', () => {
  const now = Date.parse('2026-11-03T16:00:00Z');
  const items = Array.from({ length: 1200 }, (_, index) => ({ id: `m${index}`,
    at: new Date(now - (1199 - index) * 1000).toISOString(), text: '今晚这局谁来？' }));
  const recent = selectConversationContext(items, now);
  assert.equal(recent.length, 999);
  assert.equal(recent[0].id, 'm201');
  assert.equal(recent.at(-1).id, 'm1199');
  assert.deepEqual(selectConversationContext([
    { id: 'old', at: new Date(now - 25 * 3600000).toISOString(), text: '旧话题' },
    { id: 'new', at: new Date(now).toISOString(), text: '新话题' },
  ], now).map(item => item.id), ['old', 'new']);
});

test('local participation prompt trims oldest chat while budgeting the entire input', async () => {
  let sent;
  const model = createAgentParticipationModel({ fallback: 'none', ollama: async input => {
    sent = input.messages;
    return answer('');
  } });
  const now = new Date().toISOString();
  const context = Array.from({ length: 999 }, (_, index) => ({
    id: `m${index}`, at: now, text: '聊'.repeat(1000),
  }));
  await model({ target: { id: 'm998', text: '最后一句', at: now, sourceIds: ['m998'] },
    context, kind: 'ordinary', mustReply: false, coreFacts: [], latestDiary: null,
    relevantDiary: Array.from({ length: 8 }, (_, index) => ({ id: `d${index}`,
      text: '旧'.repeat(12000) })),
    relatedProfiles: [{ userId: 'alice-internal', displayName: '小艾', facts: [] }] });
  const prompt = JSON.parse(sent[1].content);
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(sent), 'utf8') / 2) <= 200000);
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(prompt.conversation), 'utf8') / 2) <= 120000);
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify({ personProfile: prompt.personProfile,
    relatedProfiles: prompt.relatedProfiles, coreFacts: prompt.coreFacts,
    latestDiary: prompt.latestDiary, relevantDiary: prompt.relevantDiary,
    toolResults: prompt.toolResults }), 'utf8') / 2) <= 80000);
  assert.ok(prompt.conversation.length < 999);
  assert.equal(prompt.conversation.at(-1).id, 'm998');
  assert.equal(prompt.target.text, '最后一句');
  assert.equal(prompt.relatedProfiles[0].displayName, '小艾');
  assert.equal(prompt.relatedProfiles[0].userId, undefined);
});

test('every source message keeps its task outcome, model judgment and independent human label', async t => {
  const f = await setup(t);
  f.insert('first', 'alice', '今天真热');
  f.insert('second', 'alice', '要化了');
  await f.cycle(start, () => assert.fail('not due'));
  assert.deepEqual(listParticipationReview(f.outbox.db, join(f.root, 'inbox.sqlite'))
    .map(row => [row.sourceMessageId, row.taskId, row.finalState]),
  [['second', 'first', 'pending'], ['first', 'first', 'pending']]);
  const result = await f.cycle(start + 90001, async () => answer('出门直接变蒸笼了。'));
  assert.equal(result.status, 'sent');
  const reviews = listParticipationReview(f.outbox.db, join(f.root, 'inbox.sqlite'));
  assert.equal(reviews.length, 2);
  assert.ok(reviews.every(row => row.finalState === 'sent' &&
    row.sentReply === '出门直接变蒸笼了。' && row.modelDecision?.shouldReply));
  labelParticipationMessage(f.outbox.db, join(f.root, 'inbox.sqlite'),
    { sourceMessageId: reviews.find(row => row.sourceMessageId === 'first').reviewKey,
      label: 'reply', preferredReply: '热得要化了。' });
  labelParticipationMessage(f.outbox.db, join(f.root, 'inbox.sqlite'),
    { sourceMessageId: 'second', label: 'skip', note: '第二句被合并即可' });
  const labeled = exportLabeledParticipation(f.outbox.db, join(f.root, 'inbox.sqlite'));
  assert.deepEqual(labeled.map(row => row.feedback.label), ['reply', 'skip']);
  assert.equal(labeled[0].text, '今天真热');
  assert.ok(labeled[0].context.some(item => item.sourceMessageId === 'first'));
  assert.throws(() => labelParticipationMessage(f.outbox.db, join(f.root, 'inbox.sqlite'),
    { sourceMessageId: 'not-in-inbox', label: 'reply' }), /absent/);
});

test('a model reply containing an internal sender ID is never sent to the group', async t => {
  const f = await setup(t);
  f.insert('chat', 'alice-internal-id', '今天打排位又被坑了');
  f.insert('follow', 'bob-internal-id', '这把我也犯病了');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 90001, async () =>
    answer('bob-internal-id 你也跟着犯病啊？'));
  assert.equal(result.status, 'deferred');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.outbox.drafts().length, 0);
  const judgment = f.outbox.db.prepare(`SELECT decision_json FROM participation_judgments
    WHERE task_id='chat' ORDER BY id DESC LIMIT 1`).get();
  assert.match(JSON.parse(judgment.decision_json).reply, /bob-internal-id/u);
});

test('participation tools bind account and group, and reject unknown operations', async t => {
  const f = await setup(t);
  f.insert('same-group', 'alice', '周六九点集合');
  let memoryOpens = 0;
  const memory = { search: async (_query, options) => ({ results: (
    options.filters.agent_id.endsWith('-diary') ? [
    { id: 'same-diary', memory: '周六聚会改在九点', metadata: { accountId: ACCOUNT,
      groupId: GROUP, kind: 'diary', title: '聚会', startAt: '2026-11-01', endAt: '2026-11-02',
      sourceMessageIds: ['same-group'] } },
    { id: 'other-diary', memory: '其他群日记', metadata: { accountId: ACCOUNT,
      groupId: 'other@chatroom', kind: 'diary', title: '其他群', sourceMessageIds: [] } },
  ] : [
    { id: 'same-memory', memory: '周六九点集合', metadata: { accountId: ACCOUNT,
      groupId: GROUP, kind: 'core', subjectId: 'alice' } },
    { id: 'other-memory', memory: '其他群秘密', metadata: { accountId: ACCOUNT,
      groupId: 'other@chatroom', kind: 'core', subjectId: 'bob' } },
  ]) }) };
  const useTool = createParticipationTools({ accountId: ACCOUNT, groupId: GROUP,
    inboxPath: join(f.root, 'inbox.sqlite'), openMemory: async () => { memoryOpens++; return memory; } });
  const recent = await useTool({ name: 'recent_messages' });
  assert.deepEqual(recent.messages.map(item => item.id), ['same-group']);
  assert.equal(memoryOpens, 0);
  const found = await useTool({ name: 'memory_search', query: '集合' });
  assert.deepEqual(found.matches.map(item => item.id), ['same-memory']);
  assert.equal(memoryOpens, 1);
  const diary = await useTool({ name: 'diary_search', query: '聚会' });
  assert.deepEqual(diary.matches.map(item => item.id), ['same-diary']);
  await assert.rejects(useTool({ name: 'shell', query: 'whoami' }), /Invalid participation tool request/);
});

test('first production scan starts after existing Inbox without retroactive replies', async t => {
  const f = await setup(t, { startAtLatest: true });
  f.insert('old', 'alice', '有人打游戏吗');
  const model = () => assert.fail('old messages should not reach the model');
  assert.equal((await f.cycle(start, model)).status, 'waiting');
  assert.equal(f.ledger.task('old'), null);
  f.insert('new', 'bob', '还有人吗？');
  assert.equal((await f.cycle(start + 1000, model)).observed, 1);
  assert.equal(f.ledger.task('new').kind, 'question');
});

test('an @ is answered even after another human replies, once only across cycles', async t => {
  const f = await setup(t);
  f.insert('ping', 'alice', '叫一下你', { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  f.insert('human', 'bob', '我也看到了');
  const model = async () => answer('我在，想让我帮你看看什么？',
    { answeredByHuman: true, isAddressed: true });
  const sent = await f.cycle(start + 16000, model);
  assert.equal(sent.status, 'sent');
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.ledger.task('ping').state, 'sent');
  assert.equal((await f.cycle(start + 20000, model)).status, 'waiting');
  assert.equal(f.server.state.posts, 1);
});

test('participation gives the model only the target sender profile', async t => {
  const f = await setup(t);
  f.insert('named', 'alice', '@SocioMem 你记得我爱玩吗？');
  await f.cycle(start, () => assert.fail('not due'));
  const lookedUp = [];
  const profile = { userId: 'alice', displayName: '小艾', preferredNames: ['艾艾'],
    facts: [{ id: 'fact-a', category: 'interest', fact: '自称喜欢三角洲' }], activity: null };
  const result = await f.cycle(start + 16000, async input => {
    assert.deepEqual(input.personProfile, profile);
    return answer('记得呀，你说过喜欢三角洲。', { isQuestion: true, isAddressed: true });
  }, { lookupMemberProfile: async userId => { lookedUp.push(userId); return profile; } });
  assert.equal(result.status, 'sent');
  assert.deepEqual(lookedUp, ['alice']);
});

test('participation automatically supplies relevant diary and involved people before model judgment', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '示例成员12上次说什么时候一起打球？');
  await f.cycle(start, () => assert.fail('not due'));
  let diaryLookups = 0;
  const result = await f.cycle(start + 46000, async input => {
    assert.equal(input.relevantDiary[0].title, '打球约定');
    assert.equal(input.relatedProfiles[0].displayName, '示例成员12');
    return answer('上次说下周三。', { isQuestion: true });
  }, { lookupDiary: async () => { diaryLookups++;
    return [{ id: 'diary-1', title: '打球约定', text: '下周三一起打球' }]; },
  lookupRelatedProfiles: async () => [{ userId: 'bob', displayName: '示例成员12', facts: [] }] });
  assert.equal(result.status, 'sent');
  assert.equal(diaryLookups, 1);
});

test('the model receives stable-ID aliases for every speaker and recent agent turns', async t => {
  const f = await setup(t);
  f.insert('named', 'alice', '示例成员12刚才说啥了？');
  f.insert('other', 'bob', '我说火影忍者');
  await f.cycle(start, () => assert.fail('not due'));
  const names = { alice: { displayName: '示例成员11', preferredNames: ['示例成员19'] },
    bob: { displayName: '示例成员35', preferredNames: ['示例成员12'] } };
  const result = await f.cycle(start + 46000, async input => {
    assert.deepEqual(input.context.map(item => item.speaker), [names.alice, names.bob]);
    assert.deepEqual(input.recentAgentMessages, []);
    return answer('示例成员12刚才说火影忍者。', { isQuestion: true });
  }, { lookupMemberIdentity: senderId => names[senderId],
    lookupMemberProfile: senderId => ({ userId: senderId, ...names[senderId] }) });
  assert.equal(result.status, 'sent');
  f.outbox.db.prepare("UPDATE outbox SET attempted_at=? WHERE text='示例成员12刚才说火影忍者。'")
    .run(start + 46000);
  f.insert('next', 'bob', '你刚说什么？');
  await f.cycle(start + 47000, () => assert.fail('not due'));
  await f.cycle(start + 93000, async input => {
    assert.ok(input.recentAgentMessages.some(item => item.text === '示例成员12刚才说火影忍者。'));
    return answer('说你呢，示例成员12。', { isQuestion: true });
  }, { lookupMemberIdentity: senderId => names[senderId],
    lookupMemberProfile: senderId => ({ userId: senderId, ...names[senderId] }) });
});

test('consecutive messages from one person are covered by one reply', async t => {
  const f = await setup(t);
  f.insert('part-1', 'alice', '今天无聊');
  f.insert('part-2', 'alice', '有没有人想聊聊天？');
  await f.cycle(start, () => assert.fail('not due'));
  assert.deepEqual(JSON.parse(f.ledger.task('part-1').source_ids_json), ['part-1', 'part-2']);
  assert.equal(f.ledger.task('part-1').kind, 'question');
  assert.equal(f.ledger.task('part-2'), null);
  const result = await f.cycle(start + 46000, async ({ target }) => {
    assert.deepEqual(target.sourceIds, ['part-1', 'part-2']);
    assert.match(target.text, /无聊/);
    assert.match(target.text, /聊聊天/);
    return answer('我在，想聊点什么？', { isQuestion: true });
  });
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('a question stays on the prompt question schedule when the same sender adds an ordinary line', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '明天几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  f.insert('extra', 'alice', '我得提前出门');
  await f.cycle(start + 1000, () => assert.fail('not due'));
  assert.equal(f.ledger.task('question').kind, 'question');
  assert.equal(f.ledger.task('question').due_at, start + 46000);
});

test('a question receives an agent follow-up even if a group member answered', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '周末有人打游戏吗？');
  await f.cycle(start, () => assert.fail('not due'));
  f.insert('human', 'bob', '我可以');
  const result = await f.cycle(start + 46000,
    async () => answer('已经有朋友说可以啦，其他想玩的也可以接着报名。',
      { isQuestion: true, answeredByHuman: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('a factual question can request one scoped memory search and cite its result before sending', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '周六几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0, searches = 0;
  const result = await f.cycle(start + 46000, async ({ toolResults, remainingToolCalls }) => {
    calls++;
    if (!toolResults.length) {
      assert.equal(remainingToolCalls, 2);
      return answer('', { isQuestion: true, toolRequest: { name: 'memory_search', query: '周六集合时间' } });
    }
    assert.equal(toolResults[0].matches[0].fact, '周六九点集合');
    return answer('周六九点集合。', { isQuestion: true, evidenceIds: ['fact-1'] });
  }, { useTool: async request => {
    searches++;
    assert.deepEqual(request, { name: 'memory_search', query: '周六集合时间' });
    return { name: request.name, matches: [{ id: 'fact-1', fact: '周六九点集合' }] };
  } });
  assert.equal(result.status, 'sent');
  assert.equal(calls, 2);
  assert.equal(searches, 1);
  assert.equal(f.server.state.posts, 1);
});

test('a history question with a query-only tool request uses bounded diary search', async t => {
  const f = await setup(t);
  f.insert('history', 'alice', '@SocioMem 上次几点打的三角洲？',
    { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  let requested;
  const result = await f.cycle(start + 16000, async ({ toolResults }) => toolResults.length
    ? answer('上次是九点。', { isAddressed: true, evidenceIds: ['diary-1'] })
    : answer('', { isAddressed: true, toolRequest: { query: '上次打三角洲的时间' } }),
  { useTool: async request => { requested = request;
    return { name: request.name, matches: [{ id: 'diary-1', text: '上次九点打三角洲' }] }; } });
  assert.deepEqual(requested, { name: 'diary_search', query: '上次打三角洲的时间' });
  assert.equal(result.status, 'sent');
});

test('repeated malformed tool requests do not crash the worker or send a guessed answer', async t => {
  const f = await setup(t);
  f.insert('mention', 'alice', '@SocioMem 在吗？',
    { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0;
  const result = await f.cycle(start + 16000, async () => {
    calls++;
    return answer('', { isAddressed: true, toolRequest: { name: 'shell', query: 'whoami' } });
  });
  assert.equal(result.status, 'needs_review');
  assert.equal(calls, 2);
  assert.equal(f.server.state.posts, 0);
});

test('an untraceable tool-based answer is skipped and its question stays open', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '周六几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0;
  const result = await f.cycle(start + 46000, async () => ++calls === 1
    ? answer('', { isQuestion: true, toolRequest: { name: 'memory_search', query: '周六集合' } })
    : answer('周六九点集合。', { isQuestion: true, evidenceIds: ['fabricated-id'] }),
  { useTool: async () => ({ name: 'memory_search', matches: [{ id: 'fact-1', fact: '周六九点集合' }] }) });
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.ledger.db.prepare('SELECT status FROM agent_tasks WHERE id=?').get('question').status, 'open');
});

test('duplicate tool requests stop within the step budget without sending', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '周六几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  let searches = 0;
  const result = await f.cycle(start + 46000,
    async () => answer('', { isQuestion: true, toolRequest: { name: 'memory_search', query: '周六集合' } }),
    { useTool: async () => { searches++; return { name: 'memory_search', matches: [] }; } });
  assert.equal(result.status, 'skipped');
  assert.equal(searches, 1);
  assert.equal(f.server.state.posts, 0);
});

test('an unanswered question is rechecked only after new messages and then resolved', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '周六几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 46000,
    async () => answer('', { isQuestion: true, shouldReply: false }))).status, 'skipped');
  assert.equal(f.ledger.db.prepare('SELECT status FROM agent_tasks WHERE id=?').get('question').status, 'open');
  assert.equal((await f.cycle(start + 46500,
    () => assert.fail('no new message, no recheck'))).status, 'waiting');
  f.insert('new-evidence', 'bob', '九点，刚定的');
  const result = await f.cycle(start + 47000, async ({ context }) => {
    assert.ok(context.some(item => item.id === 'new-evidence'));
    return answer('刚定的是九点。', { isQuestion: true, evidenceIds: ['new-evidence'] });
  });
  assert.equal(result.status, 'sent');
  assert.equal(f.ledger.db.prepare('SELECT status,rechecks FROM agent_tasks WHERE id=?').get('question').status, 'resolved');
  assert.equal(f.server.state.posts, 1);
});

test('a plan note needs a literal source quote and can be updated by a later correction', async t => {
  const f = await setup(t);
  f.insert('plan', 'alice', '周六九点集合');
  await f.cycle(start, () => assert.fail('not due'));
  f.insert('human-reply', 'bob', '收到');
  const note = { kind: 'plan', summary: '周六九点集合', evidenceId: 'plan',
    evidenceQuote: '周六九点集合', status: 'open' };
  assert.equal((await f.cycle(start + 46000, async () => answer('', { task: note }))).status, 'skipped');
  assert.equal(f.ledger.db.prepare('SELECT summary FROM agent_tasks WHERE id=?').get('plan').summary, '周六九点集合');
  f.insert('correction', 'bob', '集合改到十点');
  await f.cycle(start + 47000, () => assert.fail('not due'));
  const changed = { kind: 'plan', summary: '周六十点集合', evidenceId: 'correction',
    evidenceQuote: '集合改到十点', resolvesTaskId: 'plan', status: 'open' };
  await f.cycle(start + 93000, async ({ openTasks }) => {
    assert.equal(openTasks[0].id, 'plan');
    return answer('', { task: changed });
  });
  const row = f.ledger.db.prepare('SELECT summary,evidence_quote,status FROM agent_tasks WHERE id=?').get('plan');
  assert.equal(row.summary, '周六十点集合');
  assert.equal(row.evidence_quote, '集合改到十点');
  assert.equal(row.status, 'open');
  assert.equal(f.server.state.posts, 0);
});

test('a plan with a fabricated quote is not recorded', async t => {
  const f = await setup(t);
  f.insert('plan', 'alice', '周六九点集合');
  await f.cycle(start, () => assert.fail('not due'));
  await f.cycle(start + 46000, async () => answer('', { task: { kind: 'plan',
    summary: '周六十点集合', evidenceId: 'plan', evidenceQuote: '十点集合', status: 'open' } }));
  assert.equal(f.ledger.db.prepare('SELECT count(*) n FROM agent_tasks').get().n, 0);
});

test('invalid answer evidence cannot write an otherwise valid plan', async t => {
  const f = await setup(t);
  f.insert('plan', 'alice', '周六九点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000, async () => answer('九点。', {
    isQuestion: true, evidenceIds: ['invented'], task: { kind: 'plan',
      summary: '周六九点集合', evidenceId: 'plan', evidenceQuote: '周六九点集合', status: 'open' },
  }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.ledger.db.prepare("SELECT count(*) n FROM agent_tasks WHERE kind='plan'").get().n, 0);
});

test('an unmentioned question gets no filler when the model has no useful answer', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '谁知道明天几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('', { isQuestion: true, shouldReply: false }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.outbox.drafts().length, 0);
});

test('a model-generated generic filler is also rejected before any send', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '谁知道明天几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('这个问题还没想明白，谁来补一嘴？', { isQuestion: true }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.outbox.drafts().length, 0);
});

test('a generated laughing emoji is removed before a group reply is sent', async t => {
  const f = await setup(t);
  f.insert('laughing', 'alice', '@SocioMem 这把又输了');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 16000, async () =>
    answer('这把输得也太有水平了 😂，先别急着封神。', { isAddressed: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.outbox.drafts().at(-1).text, '这把输得也太有水平了，先别急着封神。');
});

test('a current-time question receives the Shanghai clock before the model decides', async t => {
  const f = await setup(t);
  f.insert('time-question', 'alice', '现在几点');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000, async ({ kind, currentTime }) => {
    assert.equal(kind, 'question');
    assert.equal(currentTime.timezone, 'Asia/Shanghai');
    assert.equal(currentTime.utc, new Date(start + 46000).toISOString());
    assert.match(currentTime.local, /14:00/u);
    return answer('现在十点啦。', { isQuestion: true });
  });
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('a factual reply stops after stating uncertainty instead of redirecting the group member', async t => {
  const f = await setup(t);
  f.insert('history', 'alice', '@SocioMem 上次几点约的三角洲？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 16000,
    async () => answer('本公主只记得11月1号晚上有人约过三角洲，具体几点没记下来呀，你翻翻聊天记录？',
      { isQuestion: true, isAddressed: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.outbox.drafts()[0].text,
    '本公主只记得11月1号晚上有人约过三角洲，具体几点没记下来呀。');
});

test('an explicitly requested suggestion is kept', async t => {
  const f = await setup(t);
  f.insert('advice', 'alice', '@SocioMem 怎么做才能找到上次约的时间，给个建议？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 16000,
    async () => answer('你可以翻翻聊天记录。', { isQuestion: true, isAddressed: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.outbox.drafts()[0].text, '你可以翻翻聊天记录。');
});

test('an unsolicited suggestion alone is not sent as a reply', async t => {
  const f = await setup(t);
  f.insert('unknown', 'alice', '上次几点约的三角洲？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('你翻翻聊天记录？', { isQuestion: true }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('an irrelevant short agreement is not sent when the model declines the invitation', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '有没有人想打游戏？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('哈哈，确实。', { isQuestion: true, shouldReply: false }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

for (const [text, reply, kind] of [
  ['好模型太贵了', '确实', 'ordinary'],
  ['又把杯子拿反了哈哈', '哈哈', 'ordinary'],
  ['我正讲到他开门那儿呢', '后来呢？', 'ordinary'],
  ['这模型是不是太贵了？', '是啊', 'question'],
  ['肥鱼，谁最早拉你进群的？', '不知道', 'mention'],
  ['肥鱼，之前约的具体时间呢？', '不太清楚', 'mention'],
  ['肥鱼，在吗', '在，咋啦？', 'mention'],
  ['肥鱼，我把它寄到月球去了', '？', 'mention'],
]) test(`contextual short response is sent without padding or retries: ${reply}`, async t => {
  const f = await setup(t);
  f.insert('short', 'alice', text);
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0;
  const result = await f.cycle(start + (kind === 'mention' ? 16000 : kind === 'question' ? 46000 : 90001),
    async () => { calls++; return answer(reply, { isAddressed: kind === 'mention', isQuestion: kind === 'question' }); });
  assert.equal(result.status, 'sent');
  assert.equal(calls, 1);
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.outbox.drafts().at(-1).text, reply);
  await f.cycle(start + 360001, () => assert.fail('the same message must not generate again'));
  assert.equal(f.server.state.posts, 1);
});

test('optional short acknowledgements still respect silence, repetition and cooldown', async t => {
  for (const scenario of ['silence', 'repetition', 'cooldown']) await t.test(scenario, async t => {
    const f = await setup(t);
    if (scenario !== 'silence') {
      f.outbox.draft('previous', GROUP, scenario === 'repetition' ? '确实。' : '这价格有点高');
      f.outbox.approve('previous');
      f.outbox.claim('previous', 0, start - (scenario === 'cooldown' ? 60000 : 1200000));
      f.outbox.receipt('previous', 'accepted');
    }
    f.insert('short', 'alice', '好模型太贵了');
    await f.cycle(start, () => assert.fail('not due'));
    const result = await f.cycle(start + (scenario === 'cooldown' ? 90001 : 300001), async () =>
      answer('确实', { shouldReply: scenario !== 'silence' }));
    assert.equal(result.status, scenario === 'cooldown' ? 'deferred' : 'skipped');
    assert.equal(f.server.state.posts, 0);
    if (scenario === 'cooldown') assert.equal(f.ledger.task('short').reason, 'optional_reply_cooldown');
  });
});

test('unaddressed confirmation questions cannot bypass short-reply repetition checks', async t => {
  const f = await setup(t);
  f.outbox.draft('previous', GROUP, '是啊。');
  f.outbox.approve('previous');
  f.outbox.claim('previous', 0, start - 1200000);
  f.outbox.receipt('previous', 'accepted');
  f.insert('question', 'alice', '这模型是不是太贵了？');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 46000, async () => answer('是啊！', { isQuestion: true }))).status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('a new direct greeting can reuse a short response while the same source remains idempotent', async t => {
  const f = await setup(t);
  f.outbox.draft('previous', GROUP, '在');
  f.outbox.approve('previous');
  f.outbox.claim('previous', 0, start - 1200000);
  f.outbox.receipt('previous', 'accepted');
  f.insert('greeting', 'alice', '肥鱼，在吗');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 16000, async () => answer('在', { isAddressed: true }))).status, 'sent');
  await f.cycle(start + 46000, () => assert.fail('no repeated generation'));
  assert.equal(f.server.state.posts, 1);
});

test('optional reply cannot repeat a recent agent sentence with only punctuation changed', async t => {
  const f = await setup(t);
  f.outbox.draft('older-reply', GROUP, '热得都想抱着冰箱了。');
  f.outbox.approve('older-reply');
  f.outbox.claim('older-reply', 0, start - 20 * 60000);
  f.outbox.receipt('older-reply', 'accepted');
  f.insert('remark', 'alice', '今天太热了');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 300001, async ({ recentAgentReplies }) => {
    assert.deepEqual(recentAgentReplies, ['热得都想抱着冰箱了。']);
    return answer('热得都想抱着冰箱了！');
  });
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('model-addressed flag alone does not turn ordinary group chat into a direct mention', async t => {
  const f = await setup(t);
  f.insert('remark', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 300001,
    async () => answer('热得想抱着冰箱了。', { isAddressed: true, shouldReply: false }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('a vague ignorance reply does not count as answering an unmentioned question', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '明天几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('本公主也不确定，谁知道呀？', { isQuestion: true }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('an unmentioned question respects the model decision to stay silent', async t => {
  const f = await setup(t);
  f.insert('question', 'alice', '有人知道几点集合吗？');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000,
    async () => answer('可以去看看群公告。', { isQuestion: true, shouldReply: false }));
  assert.equal(result.status, 'skipped');
  assert.equal(f.server.state.posts, 0);
});

test('a direct mention with no useful model reply retries, then waits for review without sending filler', async t => {
  const f = await setup(t);
  f.insert('ping', 'alice', '@SocioMem 你看这个？');
  await f.cycle(start, () => assert.fail('not due'));
  const empty = async () => answer('懂，接着说，后来呢？', { isAddressed: true });
  assert.equal((await f.cycle(start + 16000, empty)).status, 'deferred');
  assert.equal(f.ledger.task('ping').reason, 'empty_mention_retry');
  assert.equal((await f.cycle(start + 46000, empty)).status, 'needs_review');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.outbox.drafts().length, 0);
});

test('a direct mention can send a specific answer after its empty-reply retry', async t => {
  const f = await setup(t);
  f.insert('ping', 'alice', '@SocioMem 明天几点集合？');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 16000,
    async () => answer('', { isAddressed: true }))).status, 'deferred');
  const result = await f.cycle(start + 46000,
    async () => answer('群公告写的是九点，记得别迟到呀。', { isAddressed: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('ordinary speech is considered after ninety seconds without forcing a reply', async t => {
  const f = await setup(t);
  f.insert('ordinary', 'alice', '今天有点无聊');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 46000, () => assert.fail('ordinary speech is not due yet'))).status, 'waiting');
  assert.equal(f.ledger.task('ordinary').due_at, start + 90000);
  assert.equal((await f.cycle(start + 90001,
    async () => answer('我来接个话，今天有什么有趣的事吗？'))).status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('an ordinary remark can remain silent after ninety seconds without an automatic filler reply', async t => {
  const f = await setup(t);
  f.insert('remark', 'alice', '我吃完饭了');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 46000, () => assert.fail('ordinary speech is not due yet'))).status, 'waiting');
  assert.equal((await f.cycle(start + 90001, async ({ mustReply }) => {
    assert.equal(mustReply, false);
    return answer('');
  })).status, 'deferred');
  assert.equal((await f.cycle(start + 300001, async () => answer(''))).status, 'skipped');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.ledger.task('remark').state, 'skipped');
});

test('human conversation is passed to the model before joining an active topic', async t => {
  const f = await setup(t);
  f.insert('first', 'alice', '今天好热');
  f.insert('second', 'bob', '是啊，热坏了');
  await f.cycle(start, () => assert.fail('not due'));
  const model = async () => answer('热得都想抱着冰箱不撒手了。');
  assert.equal((await f.cycle(start + 90001,
    async ({ context }) => { assert.ok(context.some(item => item.senderId === 'bob'));
      return answer('', { answeredByHuman: true, shouldReply: false }); })).status, 'answered');
  assert.equal((await f.cycle(start + 90002, model)).status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('a useful ordinary reply can join an active group conversation', async t => {
  const f = await setup(t);
  f.insert('first', 'alice', '今天也太热了');
  f.insert('second', 'bob', '是啊，我都快化了');
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 90001, async ({ context }) => {
    assert.ok(context.some(item => item.senderId === 'bob'));
    return answer('这天气出门像进蒸笼了。', { answeredByHuman: true });
  });
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('optional participation waits after the agent has just spoken', async t => {
  const f = await setup(t);
  f.outbox.draft('previous-agent-message', GROUP, '大家先聊着');
  f.outbox.approve('previous-agent-message');
  f.outbox.claim('previous-agent-message', 0, start);
  f.outbox.receipt('previous-agent-message', 'accepted');
  f.insert('remark', 'alice', '今天好热');
  await f.cycle(start + 1000, () => assert.fail('not due'));
  const model = async () => answer('热得都想抱着冰箱了。');
  assert.equal((await f.cycle(start + 91001, model)).status, 'deferred');
  assert.equal(f.ledger.task('remark').reason, 'optional_reply_cooldown');
  assert.equal((await f.cycle(start + 180001, model)).status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('an ordinary invitation can still get a useful reply after ninety seconds', async t => {
  const f = await setup(t);
  f.insert('invite', 'alice', '来人打游戏');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal(f.ledger.task('invite').kind, 'ordinary');
  assert.equal((await f.cycle(start + 46000, () => assert.fail('wait for ninety seconds'))).status, 'waiting');
  const result = await f.cycle(start + 90001, async () =>
    answer('想组队的报下区服和时间呀。', { isQuestion: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('a reply to the agent question is prioritized and answered without waiting five minutes', async t => {
  const f = await setup(t);
  f.outbox.draft('prior-agent-question', GROUP, '按胜率还是抽象程度算？');
  f.outbox.approve('prior-agent-question');
  f.outbox.claim('prior-agent-question', 0, start);
  f.outbox.receipt('prior-agent-question', 'accepted');
  f.insert('followup', 'alice', '按抽象程度');
  assert.equal((await f.cycle(start + 1000, () => assert.fail('not due'))).status, 'waiting');
  assert.equal(f.ledger.task('followup').kind, 'followup');
  const followupModel = async ({ kind, previousAgentMessage }) => {
    assert.equal(kind, 'followup');
    assert.equal(previousAgentMessage.text, '按胜率还是抽象程度算？');
    return answer('那得先听听他的名场面了😂，最抽象的是哪把？',
      { isFollowup: true, shouldReply: false });
  };
  assert.equal((await f.cycle(start + 16000, followupModel)).status, 'deferred');
  const result = await f.cycle(start + 30000, followupModel);
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.outbox.drafts().at(-1).text, '那得先听听他的名场面了，最抽象的是哪把？');
});

test('an already deferred ordinary task is upgraded after restart when it answers the prior agent question', async t => {
  const f = await setup(t);
  f.insert('followup', 'alice', '按抽象程度');
  await f.cycle(start + 1000, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 47000, () => assert.fail('not due'))).status, 'waiting');
  f.outbox.draft('prior-agent-question', GROUP, '按胜率还是抽象程度算？');
  f.outbox.approve('prior-agent-question');
  f.outbox.claim('prior-agent-question', 0, start);
  f.outbox.receipt('prior-agent-question', 'accepted');
  const result = await f.cycle(start + 60000,
    async () => answer('按抽象程度啊，那先说说他最离谱的一把😂',
      { isFollowup: true, shouldReply: false }));
  assert.equal(result.status, 'sent');
  assert.equal(f.ledger.task('followup').kind, 'followup');
  assert.equal(f.server.state.posts, 1);
});

test('ordinary speech followed by human chat can be left alone; implicit invitation may still get a reply', async t => {
  const f = await setup(t);
  f.insert('ordinary', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  f.insert('human', 'bob', '是啊，特别热');
  assert.equal((await f.cycle(start + 90001,
    async () => answer('', { answeredByHuman: true, shouldReply: false }))).status, 'answered');
  assert.equal(f.server.state.posts, 0);
  f.insert('implicit-question', 'charlie', '谁一起去');
  await f.cycle(start + 90002,
    async () => answer('', { answeredByHuman: true, shouldReply: false }));
  assert.equal((await f.cycle(start + 180003,
    async () => answer('想去的可以说下时间和地点，方便大家约呀。',
      { isQuestion: true }))).status, 'sent');
});

test('fresh messages trigger a second model check and the sent text uses newest context', async t => {
  const f = await setup(t);
  f.insert('q', 'alice', '有人打游戏吗？');
  await f.cycle(start, () => assert.fail('not due'));
  let calls = 0;
  const result = await f.cycle(start + 46000, async () => {
    calls++;
    if (calls === 1) {
      f.insert('new-answer', 'bob', '我来');
      return answer('有人吗？', { isQuestion: true });
    }
    return answer('已经有人应声啦，想玩的继续报名。', { isQuestion: true, answeredByHuman: true });
  });
  assert.equal(result.status, 'sent');
  assert.equal(calls, 2);
  assert.equal(f.outbox.drafts()[0].text, '已经有人应声啦，想玩的继续报名。');
});

test('a recovered unsent draft is revised after fresh context before posting', async t => {
  const f = await setup(t);
  f.insert('q', 'alice', '有人打游戏吗？');
  await f.cycle(start, () => assert.fail('not due'));
  const key = `sociomem-auto-${createHash('sha256').update(JSON.stringify([ACCOUNT, GROUP, 'q'])).digest('hex')}`;
  f.outbox.draft(key, GROUP, '过时的草稿');
  const result = await f.cycle(start + 46000,
    async () => answer('现在有人响应了，可以继续报名。', { isQuestion: true }));
  assert.equal(result.status, 'sent');
  assert.equal(f.outbox.sendRecord(key).text, '现在有人响应了，可以继续报名。');
  assert.equal(f.server.state.posts, 1);
});

test('shadow mode records a decision without a network send or Outbox draft', async t => {
  const f = await setup(t, { sendEnabled: false });
  f.insert('q', 'alice', '有人在吗？');
  await f.cycle(start, () => assert.fail('not due'));
  assert.equal((await f.cycle(start + 46000,
    async () => answer('我在。', { isQuestion: true }))).status, 'shadowed');
  assert.equal(f.server.state.posts, 0);
  assert.equal(f.outbox.drafts().length, 0);
});

test('queued send is reconciled by receipt without posting again', async t => {
  const f = await setup(t);
  f.server.state.sendMode = 'queued';
  f.insert('queued-question', 'alice', '你在吗？');
  await f.cycle(start, () => assert.fail('not due'));
  const model = async () => answer('我在。', { isQuestion: true });
  assert.equal((await f.cycle(start + 46000, model)).status, 'pending_receipt');
  assert.equal(f.server.state.posts, 1);
  for (const receipt of f.server.state.receipts.values()) receipt.state = 'accepted';
  assert.equal((await f.cycle(start + 56000, () => assert.fail('no new model call'))).status, 'sent');
  assert.equal(f.server.state.posts, 1);
});

test('DeepSeek participation client requests JSON and rejects truncated responses', async () => {
  let body;
  const usage = [];
  const model = createParticipationModel({ apiKey: 'fixture-key', onUsage: record => usage.push(record), fetchImpl: async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, status: 200, json: async () => ({ model: 'deepseek-flash',
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
        prompt_cache_hit_tokens: 70, prompt_cache_miss_tokens: 30 }, choices: [{ finish_reason: 'stop',
      message: { content: JSON.stringify(answer('我在。')) } }] }) };
  } });
  const result = await model({ target: { id: 'm', senderId: 'alice-internal', text: '在吗', at: new Date(start).toISOString() },
    context: [], kind: 'question', mustReply: true, coreFacts: [], latestDiary: null,
    recentAgentReplies: ['刚才已经说过了。'] });
  assert.equal(result.reply, '我在。');
  const aliceKey = JSON.parse(body.messages[1].content).target.speakerKey;
  assert.deepEqual(JSON.parse(body.messages[1].content).recentAgentReplies, ['刚才已经说过了。']);
  const secondAt = new Date(start + 1000).toISOString();
  await model({ target: { id: 'm2', senderId: 'alice-internal', text: '你俩说啥？', at: secondAt,
      mentions: { self: false, userIds: ['bob-internal'] } },
    context: [
      { id: 'm1', senderId: 'bob-internal', speaker: { displayName: '示例成员35', preferredNames: ['示例成员12'] },
        text: '火影忍者', at: new Date(start).toISOString(),
        mentions: { self: false, userIds: ['alice-internal'] } },
      { id: 'm2', senderId: 'alice-internal', speaker: { displayName: '示例成员11', preferredNames: ['示例成员19'] },
        text: '你俩说啥？', at: secondAt },
    ], recentAgentMessages: [{ text: '本公主刚说木叶。', at: new Date(start + 500).toISOString(),
      mentionUserIds: ['bob-internal'] }],
    personProfile: { userId: 'alice-internal', displayName: '示例成员11', preferredNames: ['示例成员19'] },
    kind: 'question', mustReply: true, coreFacts: [], latestDiary: null });
  const prompt = JSON.parse(body.messages[1].content);
  assert.deepEqual(prompt.conversation.map(item => [item.role, item.preferredNames?.[0] ?? null]),
    [['group_member', '示例成员12'], ['agent', null], ['group_member', '示例成员19']]);
  assert.equal(prompt.conversation[1].name, '肥鱼');
  assert.match(prompt.target.speakerKey, /^M_[A-Za-z0-9_-]{12}$/u);
  assert.equal(prompt.conversation[0].speakerKey !== prompt.target.speakerKey, true);
  assert.equal(prompt.conversation[1].speakerKey, 'AGENT');
  assert.equal(prompt.conversation[2].speakerKey, prompt.target.speakerKey);
  assert.equal(prompt.personProfile.speakerKey, prompt.target.speakerKey);
  assert.equal(prompt.target.speakerKey, aliceKey);
  assert.deepEqual(prompt.target.mentions.speakerKeys, [prompt.conversation[0].speakerKey]);
  assert.deepEqual(prompt.conversation[0].mentions.speakerKeys, [aliceKey]);
  assert.deepEqual(prompt.conversation[1].mentions.speakerKeys, [prompt.conversation[0].speakerKey]);
  assert.ok(!body.messages[1].content.includes('alice-internal'));
  assert.ok(!body.messages[1].content.includes('bob-internal'));
  assert.equal(body.response_format.type, 'json_object');
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.max_tokens, 1600);
  assert.equal(usage[0].inputTokens, 100);
  assert.equal(usage[0].outputTokens, 20);
  assert.equal(usage[0].cacheHitTokens, 70);
  assert.equal(usage[0].component, 'participation');
  const budgets = [];
  const retry = createParticipationModel({ apiKey: 'fixture-key', onUsage: record => usage.push(record), fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    assert.deepEqual(request.thinking, { type: 'disabled' });
    budgets.push(request.max_tokens);
    return { ok: true, json: async () => ({ choices: [{ finish_reason: budgets.length === 1 ? 'length' : 'stop',
      message: { content: JSON.stringify(answer('重试成功。')) } }] }) };
  } });
  assert.equal((await retry({ target: { id: 'm', senderId: 'alice', text: '在吗', at: new Date(start).toISOString() },
    context: [], kind: 'question', mustReply: true, coreFacts: [], latestDiary: null })).reply, '重试成功。');
  assert.deepEqual(budgets, [1600, 3200]);
  assert.deepEqual(usage.slice(2, 4).map(item => item.attempt), [1, 2]);
  assert.equal(usage[2].operationId, usage[3].operationId);
  const bad = createParticipationModel({ apiKey: 'fixture-key', onUsage: record => usage.push(record), fetchImpl: async () => ({ ok: true,
    json: async () => ({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }) }) });
  await assert.rejects(bad({ target: { id: 'm', senderId: 'alice', text: '在吗', at: new Date(start).toISOString() },
    context: [], kind: 'question', mustReply: true, coreFacts: [], latestDiary: null }), /incomplete/);
  assert.deepEqual(usage.slice(4).map(item => item.finishReason), ['length', 'length']);
  await model({ target: { id: 'm4', senderId: 'bob-internal', text: '示例成员12在', at: secondAt },
    context: [{ id: 'm3', senderId: 'alice-internal', text: '我也在', at: secondAt }],
    kind: 'ordinary', mustReply: false,
    coreFacts: [{ id: 'fact-1', subjectId: 'alice-internal', fact: '喜欢火影忍者' }],
    toolResults: [{ name: 'recent_messages', messages: [
      { id: 'm3', senderId: 'alice-internal', text: '我也在', at: secondAt }] },
    { name: 'memory_search', matches: [
      { id: 'fact-1', subjectId: 'alice-internal', fact: '喜欢火影忍者' }] }],
    relevantDiary: [{ id: 'diary-1', title: '聊天', text: '有人聊了火影', events: [{
      text: '聊到火影', sourceMessageIds: ['m3'], evidenceQuote: '我也在',
      sourceSpeakerIds: ['alice-internal'], quoteSpeakerIds: ['alice-internal'] }] }],
    latestDiary: null });
  const reversedPrompt = JSON.parse(body.messages[1].content);
  assert.equal(reversedPrompt.conversation[0].speakerKey, aliceKey);
  assert.notEqual(reversedPrompt.target.speakerKey, aliceKey);
  assert.equal(reversedPrompt.coreFacts[0].speakerKey, aliceKey);
  assert.equal(reversedPrompt.toolResults[0].messages[0].speakerKey, aliceKey);
  assert.equal(reversedPrompt.toolResults[1].matches[0].speakerKey, aliceKey);
  assert.deepEqual(reversedPrompt.relevantDiary[0].events[0].quoteSpeakerKeys, [aliceKey]);
  assert.deepEqual(reversedPrompt.relevantDiary[0].events[0].sourceSpeakerKeys, [aliceKey]);
  assert.ok(!body.messages[1].content.includes('alice-internal'));
});

test('a reply cannot cite a nonexistent focus or invent who invited the agent', async t => {
  const f = await setup(t);
  f.insert('inviter-question', 'alice', '@肥鱼 谁邀请你进群的？',
    { mentions: { state: 'known', self: true, userIds: [] } });
  await f.cycle(start, () => assert.fail('not due'));
  const badFocus = await f.cycle(start + 46000, async () =>
    answer('不知道。', { isAddressed: true, focusMessageId: 'nonexistent' }));
  assert.equal(badFocus.status, 'needs_review');
  assert.equal(f.server.state.posts, 0);

  f.insert('inviter-question-2', 'bob', '@肥鱼 谁拉你进群的？',
    { mentions: { state: 'known', self: true, userIds: [] } });
  await f.cycle(start + 47000, () => assert.fail('not due'));
  const invented = await f.cycle(start + 93000, async () =>
    answer('Rakon 拉我进来的。', { isAddressed: true, focusMessageId: 'inviter-question-2' }));
  assert.equal(invented.status, 'needs_review');
  assert.equal(f.server.state.posts, 0);
  const recorded = JSON.parse(f.outbox.db.prepare(`SELECT decision_json FROM participation_judgments
    WHERE task_id='inviter-question-2' ORDER BY id DESC LIMIT 1`).get().decision_json);
  assert.equal(recorded.targetSenderId, 'bob');
  assert.equal(recorded.focusSenderId, 'bob');
  assert.equal(recorded.focusMessageId, 'inviter-question-2');
});

test('a uniquely mistyped WeChat focus ID does not suppress a direct reply', async t => {
  const f = await setup(t);
  f.insert('msg_abcdefg', 'alice', '@肥鱼 你在吗？',
    { mentions: { state: 'known', self: true, userIds: [] } });
  await f.cycle(start, () => assert.fail('not due'));
  const result = await f.cycle(start + 46000, async () =>
    answer('在呢。', { isAddressed: true, focusMessageId: 'msg_abcdffg' }));
  assert.equal(result.status, 'sent');
  assert.equal(f.server.state.posts, 1);
  const recorded = JSON.parse(f.outbox.db.prepare(`SELECT decision_json FROM participation_judgments
    WHERE task_id='msg_abcdefg' ORDER BY id DESC LIMIT 1`).get().decision_json);
  assert.equal(recorded.focusMessageId, 'msg_abcdefg');
  assert.equal(recorded.originalFocusMessageId, 'msg_abcdffg');
  assert.equal(recorded.focusSenderId, 'alice');
});

test('a second consecutive body-state reply is suppressed unless directly mentioned', async t => {
  const f = await setup(t);
  f.insert('sleep-1', 'alice', '下午好');
  await f.cycle(start, () => assert.fail('not due'));
  const first = await f.cycle(start + 95000, async () => answer('刚睡醒，正懵着呢'));
  assert.equal(first.status, 'sent');
  f.outbox.db.prepare("UPDATE outbox SET attempted_at=? WHERE text='刚睡醒，正懵着呢'")
    .run(start + 95000);
  f.insert('sleep-2', 'bob', '该睡觉了吧');
  const second = await f.cycle(start + 190000, async () => answer('这才几点，正犯困呢'));
  assert.notEqual(second.status, 'sent');
  assert.equal(f.outbox.drafts().some(row => row.text.includes('正犯困')), false);
});
