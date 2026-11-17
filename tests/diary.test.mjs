import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DiaryStore, estimateTokens, planDiary, previewDiary,
  readCoreFacts, readCoreRevisions, readInbox, runDiary, searchDiary,
  selectBatch, validateDiaryOutput } from '../packages/diary/index.mjs';
import { runDiaryCycle } from '../packages/diary/worker.mjs';
import { createDeepSeekDiaryModel } from '../packages/diary/model.mjs';
import { memoryScope, openMem0, searchMemories } from '../packages/memory/index.mjs';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { createRuntime, prepareRun, projectRoot } from '../scripts/runtime.mjs';

const accountId = 'account-diary-test';
const groupA = 'diary-a@chatroom';
const groupB = 'diary-b@chatroom';

async function embeddingServer() {
  const server = createServer(async (request, response) => {
    if (request.url !== '/embeddings') { response.writeHead(404).end(); return; }
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw).input;
    const texts = Array.isArray(input) ? input : [input];
    const data = texts.map((text, index) => ({ index, object: 'embedding', embedding: [
      text.includes('聚会') ? 1 : 0.1, text.includes('周四') ? 1 : 0.1,
      text.includes('周三') ? 1 : 0.1, 0.5,
    ] }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data, model: 'diary-test', usage: { prompt_tokens: 0, total_tokens: 0 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

function message(id, groupId, senderId, text, day = 1) {
  return { accountId, groupId, userId: senderId, sourceMessageId: id, text,
    eventTime: `2026-10-0${day}T12:00:00.000Z`, recordedAt: `2026-10-0${day}T12:01:00.000Z` };
}

test('composite local-model quotes use a literal cited message without accepting invented evidence', () => {
  const messages = [
    { id: 'a1', senderId: 'member-a', text: '今晚八点打游戏', at: '2026-11-04T10:00:00Z' },
    { id: 'a2', senderId: 'member-b', text: '我一会儿上线', at: '2026-11-04T10:01:00Z' },
  ];
  const output = quote => ({ diary: { title: '组队', summary: '群友约着打游戏', events: [
    { text: '约打游戏', sourceMessageIds: ['a1', 'a2'], evidenceQuote: quote },
  ] }, coreUpdates: [] });
  const checked = validateDiaryOutput(output('今晚八点打游戏 我一会儿上线'), messages);
  assert.equal(checked.diary.events[0].evidenceQuote, '今晚八点打游戏');
  assert.deepEqual(checked.diary.events[0].sourceMessageIds, ['a1', 'a2']);
  assert.deepEqual(checked.diary.events[0].sourceSpeakerIds, ['member-a', 'member-b']);
  assert.deepEqual(checked.diary.events[0].quoteSpeakerIds, ['member-a']);
  assert.throws(() => validateDiaryOutput(output('今晚九点打游戏 我一会儿上线'), messages),
    /evidence is absent/);
});

test('rolling diary persists segments, replaces scoped core facts, and searches each layer', { timeout: 30000 }, async t => {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-test-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('a1', groupA, 'member-a', '以后每周三晚上八点聚会'), 'text');
  adapter.commitEvent('2', message('b1', groupB, 'member-b', '另一个群的消息'), 'text');
  adapter.commitEvent('3', message('a2', groupA, 'member-b', '收到'), 'text');
  const server = await embeddingServer();
  t.after(() => server.close());
  const memEnv = { SOCIOMEM_MEMORY_ROOT: join(root, 'memory'), SOCIOMEM_EMBEDDING_BASE_URL: server.url,
    SOCIOMEM_EMBEDDING_MODEL: 'diary-test', SOCIOMEM_EMBEDDING_DIMENSION: '4' };
  const memory = await openMem0(memEnv);
  const diaryPath = join(root, 'diary.db');
  let store = new DiaryStore(diaryPath);
  t.after(() => store?.close());
  const model = async ({ messages, coreFacts }) => {
    if (messages.some(item => item.id === 'a3')) {
      return { diary: { title: '聚会改期', summary: '成员改为每周四晚上八点聚会。', events: [
        { text: '聚会改期', sourceMessageIds: ['a3'], evidenceQuote: '改成每周四晚上八点聚会' },
      ] }, coreUpdates: [{ action: 'replace', category: 'general', targetMemoryId: coreFacts[0].id,
        fact: '群里每周四晚上八点聚会', subjectId: 'group', sourceMessageIds: ['a3'],
        evidenceQuote: '改成每周四晚上八点聚会' }] };
    }
    return { diary: { title: '聚会约定', summary: '成员约定以后每周三晚上八点聚会。', events: [
      { text: '约定固定聚会时间', sourceMessageIds: ['a1'], evidenceQuote: '每周三晚上八点聚会' },
    ] }, coreUpdates: [{ action: 'add', category: 'general', fact: '群里每周三晚上八点聚会', subjectId: 'group',
      sourceMessageIds: ['a1'], evidenceQuote: '每周三晚上八点聚会' }] };
  };
  const waiting = await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupA,
    now: Date.parse('2026-10-01T12:02:00Z') });
  assert.equal(waiting.status, 'waiting');
  const first = await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupA, force: true });
  assert.equal(first.status, 'written');
  assert.equal(first.sources, 2);
  assert.equal(first.coreUpdates, 1);
  const diaryA = await searchDiary(memory, { accountId, groupId: groupA, query: '周三聚会',
    diaryPath, inboxPath });
  assert.ok(diaryA.some(item => item.title === '聚会约定' && item.sourceMessageIds.includes('a1')));
  assert.deepEqual(diaryA.find(item => item.title === '聚会约定').events[0].sourceSpeakerIds,
    ['member-a']);
  // Historical diary rows without attribution fields are enriched from cited Inbox messages.
  const legacy = store.db.prepare('SELECT events_json FROM segments WHERE id=?').get(first.id);
  const oldEvents = JSON.parse(legacy.events_json).map(({ sourceSpeakerIds, quoteSpeakerIds, ...event }) => event);
  store.db.prepare('UPDATE segments SET events_json=? WHERE id=?').run(JSON.stringify(oldEvents), first.id);
  const restored = await searchDiary(memory, { accountId, groupId: groupA, query: '周三聚会',
    diaryPath, inboxPath });
  assert.deepEqual(restored.find(item => item.title === '聚会约定').events[0].quoteSpeakerIds,
    ['member-a']);
  assert.deepEqual(await searchDiary(memory, { accountId, groupId: groupB, query: '周三聚会' }), []);
  assert.equal(readInbox(inboxPath, { accountId, groupId: groupA, recent: true }).length, 2);

  adapter.commitEvent('4', message('a3', groupA, 'member-a', '改成每周四晚上八点聚会', 2), 'text');
  const second = await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupA, force: true });
  assert.equal(second.status, 'written');
  assert.equal(second.sources, 1); // The row ID gap from group B must not block progress.
  const core = await memory.getAll({ filters: { agent_id: memoryScope(accountId, groupA), kind: 'core' }, topK: 10 });
  assert.equal(core.results.length, 1);
  assert.equal(core.results[0].memory, '群里每周四晚上八点聚会');
  assert.equal(readCoreFacts(join(root, 'memory'), accountId, groupA)[0].fact, '群里每周四晚上八点聚会');
  assert.equal(readCoreFacts(join(root, 'memory'), accountId, groupA)[0].category, 'general');
  assert.equal((await searchMemories(memory, { accountId, groupId: groupA, query: '每周四聚会' }))[0].fact, '群里每周四晚上八点聚会');
  assert.deepEqual(await searchMemories(memory, { accountId, groupId: groupB, query: '每周四聚会' }), []);

  store.close(); store = new DiaryStore(diaryPath);
  assert.equal(store.segments(accountId, groupA).length, 2);
  assert.equal((await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupA, force: true })).status, 'idle');
  assert.equal((await memory.getAll({ filters: { agent_id: memoryScope(accountId, groupA), kind: 'core' }, topK: 10 })).results.length, 1);

  const saved = new Map();
  for (const [key, value] of Object.entries(memEnv)) { saved.set(key, process.env[key]); process.env[key] = value; }
  const run = await prepareRun('diary-harness');
  let runtime;
  try {
    runtime = createRuntime(run, { groupId: groupA, accountId, memoryEnabled: true, wechatDbPath: inboxPath });
    assert.match((await runtime.run('[test] diary-search')).finalResponse, /聚会约定|聚会改期/);
    assert.match((await runtime.run('[test] diary-search diary-cross-group')).finalResponse, /GROUP_SCOPE_DENIED/);
    assert.match((await runtime.run('[test] recent-messages')).finalResponse, /改成每周四晚上八点聚会/);
    assert.match((await runtime.run('[test] recent-messages recent-cross-group')).finalResponse, /GROUP_SCOPE_DENIED/);
  } finally {
    await runtime?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
  assert.equal(readInbox(inboxPath, { accountId, groupId: groupA, recent: true }).length, 3);
  assert.equal(readInbox(inboxPath, { accountId, groupId: groupB, recent: true }).length, 1);

  adapter.commitEvent('5', message('a4', groupA, 'member-a', '不固定聚会了', 3), 'text');
  const retireModel = async ({ coreFacts }) => ({ diary: { title: '取消固定聚会', summary: '固定聚会取消。', events: [] },
    coreUpdates: [{ action: 'retire', category: 'general', targetMemoryId: coreFacts[0].id,
      subjectId: 'group', sourceMessageIds: ['a4'], evidenceQuote: '不固定聚会了' }] });
  const finishRevision = store.finishRevision.bind(store);
  let interruptAfterMem0 = true;
  store.finishRevision = (...args) => {
    if (interruptAfterMem0) { interruptAfterMem0 = false; throw new Error('simulated interruption'); }
    return finishRevision(...args);
  };
  await assert.rejects(runDiary({ store, memory, inboxPath, accountId, groupId: groupA,
    force: true, model: retireModel }), /simulated interruption/);
  store.finishRevision = finishRevision;
  const retired = await runDiary({ store, memory, inboxPath, accountId, groupId: groupA,
    model: () => assert.fail('recovery must not call model again'), force: true });
  assert.equal(retired.status, 'idle');
  assert.deepEqual(readCoreFacts(join(root, 'memory'), accountId, groupA), []);
  assert.deepEqual(await searchMemories(memory, { accountId, groupId: groupA, query: '每周四聚会' }), []);
  const revisions = readCoreRevisions(diaryPath, accountId, groupA, 'group');
  assert.deepEqual(revisions.map(item => [item.action, item.previous_status, item.next_status]),
    [['add', null, 'active'], ['replace', 'active', 'active'], ['retire', 'active', 'retired']]);
  assert.equal(revisions[1].previous_fact, '群里每周三晚上八点聚会');
  assert.equal(revisions[2].previous_fact, '群里每周四晚上八点聚会');

  adapter.commitEvent('6', message('a5', groupA, 'member-a', '还是每周四晚上八点聚会', 4), 'text');
  const resumed = await runDiary({ store, memory, inboxPath, accountId, groupId: groupA, force: true,
    model: async ({ coreFacts }) => {
      assert.deepEqual(coreFacts, []);
      return { diary: { title: '恢复固定聚会', summary: '固定聚会恢复。', events: [] },
        coreUpdates: [{ action: 'add', category: 'general', fact: '群里每周四晚上八点聚会',
          subjectId: 'group', sourceMessageIds: ['a5'], evidenceQuote: '每周四晚上八点聚会' }] };
    } });
  assert.equal(resumed.status, 'written');
  assert.equal(readCoreFacts(join(root, 'memory'), accountId, groupA).length, 1);
  assert.deepEqual(readCoreRevisions(diaryPath, accountId, groupA, 'group').at(-1).previous_status,
    'retired');
});

test('person profile categories need literal and repeated evidence from the same sender', () => {
  const messages = [
    { id: 'a1', senderId: 'alice', at: '2026-11-01T20:00:00+08:00', text: '我喜欢打三角洲' },
    { id: 'a2', senderId: 'alice', at: '2026-11-01T21:00:00+08:00', text: '今天也来聊两句' },
    { id: 'a3', senderId: 'alice', at: '2026-11-02T20:00:00+08:00', text: '晚上再聊' },
    { id: 'b1', senderId: 'bob', at: '2026-11-02T20:00:00+08:00', text: '我也在' },
  ];
  const make = update => ({ diary: { title: '聊天', summary: '聊天', events: [] }, coreUpdates: [update] });
  const interest = { action: 'add', category: 'interest', fact: 'alice 自称喜欢打三角洲',
    subjectId: 'alice', sourceMessageIds: ['a1'], evidenceQuote: '我喜欢打三角洲' };
  assert.equal(validateDiaryOutput(make(interest), messages).coreUpdates[0].category, 'interest');
  assert.throws(() => validateDiaryOutput(make({ ...interest, subjectId: 'bob' }), messages), /subject/);
  assert.throws(() => validateDiaryOutput(make({ ...interest, category: 'activity_pattern' }), messages), /repeated/);
  const activity = { ...interest, category: 'activity_pattern', fact: 'alice 在这两天晚上发过言',
    sourceMessageIds: ['a1', 'a2', 'a3'], evidenceQuote: '我喜欢打三角洲' };
  assert.equal(validateDiaryOutput(make(activity), messages).coreUpdates[0].category, 'activity_pattern');
  assert.throws(() => validateDiaryOutput(make({ ...activity,
    sourceMessageIds: ['a1', 'a2', 'b1'] }), messages), /repeated/);
  const next = [{ id: 'a4', senderId: 'alice', at: '2026-11-03T20:00:00+08:00',
    text: '晚上又来聊啦' }];
  const observed = { ...activity, sourceMessageIds: ['a1', 'a2', 'a4'],
    evidenceQuote: '晚上又来聊啦' };
  assert.equal(validateDiaryOutput(make(observed), next, [], messages).coreUpdates[0].category,
    'activity_pattern');
  assert.throws(() => validateDiaryOutput(make({ ...observed, evidenceQuote: '今天也来聊两句' }),
    next, [], messages), /evidence is absent/);
  assert.throws(() => validateDiaryOutput(make({ ...observed, sourceMessageIds: ['a1', 'a2', 'a3'] }),
    next, [], messages), /needs new source/);
  assert.throws(() => validateDiaryOutput(make({ action: 'retire', subjectId: 'alice',
    targetMemoryId: 'not-this-person', sourceMessageIds: ['a4'], evidenceQuote: '晚上又来聊啦' }),
  next, [{ id: 'other', fact: '其他人喜欢游戏', subjectId: 'bob' }], messages), /outside the supplied scope/);
});

test('new diary batch receives bounded history only for its own speakers and group', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-person-history-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  const diaryPath = join(root, 'diary.sqlite');
  const store = new DiaryStore(diaryPath);
  t.after(() => store.close());
  const memory = { async getAll() { return { results: [] }; },
    async add() { return { results: [{ id: 'diary-index' }] }; } };
  const empty = { diary: { title: '闲聊', summary: '简短闲聊', events: [] }, coreUpdates: [] };
  adapter.commitEvent('1', message('old-a', groupA, 'alice', '我今天在群里', 1), 'text');
  assert.equal((await runDiary({ store, memory, model: async () => empty,
    inboxPath, accountId, groupId: groupA, force: true, maxBatchTokens: 1000 })).status, 'written');
  adapter.commitEvent('2', message('other-group', groupB, 'alice', '不应进来', 1), 'text');
  adapter.commitEvent('3', message('old-b', groupA, 'bob', '另一位成员', 1), 'text');
  adapter.commitEvent('4', message('new-a', groupA, 'alice', '我又来群里了', 2), 'text');
  const preview = await previewDiary({ diaryPath, inboxPath, accountId, groupId: groupA,
    force: true, maxBatchTokens: 1000, model: async ({ personHistory }) => {
      assert.deepEqual(personHistory.map(item => item.id), ['old-a']);
      return empty;
    } });
  assert.equal(preview.status, 'preview');
});

test('output-limit preview and write retry smaller batches without repeating the same messages', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-split-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  for (let index = 1; index <= 4; index++) {
    adapter.commitEvent(String(index), message(`split-${index}`, groupA, 'member-a', `消息 ${index}`), 'text');
  }
  const diaryPath = join(root, 'diary.db');
  const calls = [];
  const model = async ({ messages }) => {
    calls.push(messages.map(item => item.id));
    if (messages.length === 4) {
      const error = new Error('output limit'); error.code = 'DIARY_OUTPUT_LIMIT'; throw error;
    }
    return { diary: { title: '片段', summary: '已整理本段消息。', events: [] }, coreUpdates: [] };
  };
  const preview = await previewDiary({ diaryPath, inboxPath, accountId, groupId: groupA,
    model, force: true, triggerTokens: 100, maxBatchTokens: 1000, saveCache: true });
  assert.deepEqual(calls.map(ids => ids.length), [4, 2]);
  assert.equal(preview.sources, 2);
  assert.equal(preview.attempts, 2);
  assert.equal(preview.cacheSaved, true);
  assert.equal(existsSync(diaryPath), false);
  const store = new DiaryStore(diaryPath);
  t.after(() => store.close());
  const memory = { async getAll() { return { results: [] }; },
    async add() { return { results: [{ id: 'diary-index' }] }; } };
  calls.length = 0;
  const first = await runDiary({ store, memory, model: () => assert.fail('validated preview must be reused'), inboxPath, accountId,
    groupId: groupA, force: true, triggerTokens: 100, maxBatchTokens: 1000 });
  assert.deepEqual(calls, []);
  assert.equal(first.sources, 2);
  assert.equal(first.attempts, 0);
  assert.equal(first.reusedPreview, true);
  assert.equal(store.progress(accountId, groupA), 2);
  calls.length = 0;
  const second = await runDiary({ store, memory, model, inboxPath, accountId,
    groupId: groupA, force: true, triggerTokens: 100, maxBatchTokens: 1000 });
  assert.deepEqual(calls.map(ids => ids.length), [2]);
  assert.equal(second.sources, 2);
  assert.equal(store.progress(accountId, groupA), 4);
});

test('persistent output-limit errors stop after distinct smaller batches without moving the cursor', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-split-fail-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  for (let index = 1; index <= 8; index++) {
    adapter.commitEvent(String(index), message(`fail-${index}`, groupA, 'member-a', `消息 ${index}`), 'text');
  }
  const diaryPath = join(root, 'diary.db');
  const calls = [];
  const model = async ({ messages }) => {
    calls.push(messages.length);
    const error = new Error('output limit'); error.code = 'DIARY_OUTPUT_LIMIT'; throw error;
  };
  await assert.rejects(previewDiary({ diaryPath, inboxPath, accountId, groupId: groupA,
    model, force: true, triggerTokens: 100, maxBatchTokens: 1000 }),
  error => error.code === 'DIARY_OUTPUT_LIMIT');
  assert.deepEqual(calls, [8, 4, 2]);
  assert.equal(existsSync(diaryPath), false);
});

test('invalid model evidence gets bounded feedback and never advances an invalid diary', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-evidence-fail-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('evidence-1', groupA, 'member-a', '原文是周三聚会'), 'text');
  const diaryPath = join(root, 'diary.db');
  const feedback = [];
  await assert.rejects(previewDiary({ diaryPath, inboxPath, accountId, groupId: groupA,
    force: true, triggerTokens: 100, maxBatchTokens: 1000,
    model: async input => { feedback.push(input.retryFeedback); return { diary: { title: '错引', summary: '无事', events: [
      { text: '错误事件', sourceMessageIds: ['evidence-1'], evidenceQuote: '周四聚会' },
    ] }, coreUpdates: [] }; } }), error => error.code === 'DIARY_VALIDATION_FAILED');
  assert.equal(feedback.length, 3);
  assert.equal(feedback[0], null);
  assert.match(feedback[1], /逐字复制/u);
  let calls = 0;
  const recovered = await previewDiary({ diaryPath, inboxPath, accountId, groupId: groupA,
    force: true, triggerTokens: 100, maxBatchTokens: 1000,
    model: async input => {
      calls++;
      if (calls > 1) assert.match(input.retryFeedback, /event evidence is absent/u);
      return { diary: { title: '聚会', summary: '成员提及周三聚会', events: [
        { text: '提及周三聚会', sourceMessageIds: ['evidence-1'],
          evidenceQuote: calls === 1 ? '周四聚会' : '周三聚会' },
      ] }, coreUpdates: [] };
    } });
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.diary.events[0].evidenceQuote, '周三聚会');
  assert.equal(existsSync(diaryPath), false);
});

test('unsupported evidence cannot advance a diary cursor', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-invalid-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('invalid-1', groupB, 'member-b', '你好'), 'text');
  const store = new DiaryStore(join(root, 'diary.db'));
  t.after(() => store.close());
  const input = [{ id: 'invalid-1', senderId: 'member-b', text: '你好' }];
  assert.throws(() => validateDiaryOutput({ diary: { title: '编造', summary: '无事', events: [
    { text: '明天聚会', sourceMessageIds: ['invalid-1'], evidenceQuote: '明天聚会' },
  ] }, coreUpdates: [] }, input), /evidence is absent/);
  assert.throws(() => validateDiaryOutput({ diary: { title: '无事', summary: '无事', events: [] }, coreUpdates: [
    { action: 'add', fact: '成员甲喜欢游泳', subjectId: 'member-a',
      sourceMessageIds: ['invalid-1'], evidenceQuote: '你好' },
  ] }, input), /subject is not a cited sender/);
  assert.equal(store.progress(accountId, groupB), 0);
});

test('capacity or the 24-hour window boundary triggers rolling segments', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-trigger-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('capacity-1', groupA, 'member-a', '今天聊了很多事情。'.repeat(100)), 'text');
  adapter.commitEvent('2', message('age-1', groupB, 'member-b', '几天前的简短消息'), 'text');
  const store = new DiaryStore(join(root, 'diary.db'));
  t.after(() => store.close());
  let sequence = 0;
  const memory = {
    async getAll({ filters }) { return { results: this.items.filter(item =>
      Object.entries(filters).every(([key, value]) => key === 'agent_id' ? item.agent_id === value : item.metadata[key] === value)) }; },
    async add(text, { agentId, metadata }) {
      const item = { id: `item-${++sequence}`, memory: text, agent_id: agentId, metadata };
      this.items.push(item); return { results: [item] };
    },
    items: [],
  };
  const model = async ({ messages }) => ({ diary: { title: '片段', summary: '本段无长期事实。', events: [
    { text: '一条消息', sourceMessageIds: [messages[0].id], evidenceQuote: messages[0].text.slice(0, 5) },
  ] }, coreUpdates: [] });
  const capacity = await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupA,
    triggerTokens: 100, maxBatchTokens: 1000 });
  assert.equal(capacity.status, 'written');
  const oldMessage = await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupB,
    triggerTokens: 3500, maxBatchTokens: 5000, now: Date.parse('2026-10-01T12:02:00Z') });
  assert.equal(oldMessage.status, 'waiting');
  assert.equal(oldMessage.reason, 'below_capacity');
  assert.equal(planDiary({ diaryPath: join(root, 'diary.db'), inboxPath, accountId,
    groupId: groupB, triggerTokens: 3500, maxBatchTokens: 100,
    now: Date.parse('2026-10-01T12:02:00Z') }).status, 'waiting');
  assert.equal(planDiary({ diaryPath: join(root, 'diary.db'), inboxPath, accountId,
    groupId: groupB, triggerTokens: 3500, maxBatchTokens: 100, maxAgeMs: 24 * 3600000,
    now: Date.parse('2026-10-02T13:00:00Z') }).reason, 'window_boundary');
  assert.equal((await runDiary({ store, memory, model, inboxPath, accountId, groupId: groupB,
    triggerTokens: 3500, maxBatchTokens: 5000, maxAgeMs: 24 * 3600000,
    now: Date.parse('2026-10-02T13:00:00Z') })).status, 'written');
  assert.equal(store.segments(accountId, groupA).length, 1);
  assert.equal(store.segments(accountId, groupB).length, 1);
});

test('low-volume messages across Inbox pages do not get stuck on the first page', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-pages-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  for (let i = 0; i < 300; i++) {
    const id = `short-${i}`;
    adapter.commitEvent(id, message(id, groupA, 'member-a', '好'), 'text');
  }
  const plan = planDiary({ diaryPath: join(root, 'absent.db'), inboxPath,
    accountId, groupId: groupA, triggerTokens: 20000, maxBatchTokens: 25000,
    now: Date.parse('2026-10-01T12:02:00Z') });
  assert.equal(plan.status, 'waiting');
  assert.equal(plan.pendingAtLeast, 300);
  assert.equal(plan.selected, 300);
});

test('plan and model preview use actual message fields without changing durable state', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-preview-'));
  const inboxPath = join(root, 'adapter.db');
  const diaryPath = join(root, 'diary.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('preview-1', groupA, 'member-a', '下周三一起打球'), 'text');
  const options = { diaryPath, inboxPath, accountId, groupId: groupA,
    now: Date.parse('2026-10-01T12:02:00Z') };
  const pending = readInbox(inboxPath, { accountId, groupId: groupA });
  const plan = planDiary(options);
  assert.equal(plan.status, 'waiting');
  assert.equal(plan.reason, 'below_capacity');
  assert.equal(plan.estimatedTokens, estimateTokens(JSON.stringify(pending.map(item => ({
    id: item.id, senderId: item.senderId,
    at: new Date(Date.parse(item.at) + 8 * 3600000).toISOString().replace('Z', '+08:00'),
    text: item.text,
  })))));
  assert.equal(selectBatch(pending, 5000).tokens, plan.estimatedTokens);
  assert.equal(existsSync(diaryPath), false);
  let calls = 0;
  const model = async ({ messages }) => { calls++;
    assert.match(messages[0].at, /T20:00:00\.000\+08:00$/);
    return { diary: { title: '打球', summary: '群里提到下周三一起打球。',
    events: [{ text: '约打球', sourceMessageIds: ['preview-1'], evidenceQuote: '下周三一起打球' }] },
    coreUpdates: [] }; };
  assert.equal((await previewDiary({ ...options, model })).status, 'waiting');
  assert.equal(calls, 0);
  const preview = await previewDiary({ ...options, model, force: true });
  assert.equal(preview.status, 'preview');
  assert.equal(preview.diary.events[0].evidenceQuote, '下周三一起打球');
  assert.equal(calls, 1);
  assert.equal(existsSync(diaryPath), false);
  assert.equal(adapter.db.prepare('SELECT COUNT(*) n FROM inbox').get().n, 1);
  assert.equal(adapter.drafts().length, 0);
  const env = { ...process.env, SOCIOMEM_WECHAT_GROUPS: groupA,
    SOCIOMEM_WECHAT_DB: inboxPath, SOCIOMEM_DIARY_ROOT: join(root, 'absent-diary') };
  const result = spawnSync(process.execPath, ['scripts/diary-local.mjs', 'plan', groupA],
    { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, 'below_capacity');
  assert.equal(existsSync(join(root, 'absent-diary')), false);
});

test('independent diary cycle writes only on capacity without creating reply drafts', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-worker-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  adapter.commitEvent('1', message('worker-1', groupA, 'member-a', '以后每周四见面。'.repeat(12)), 'text');
  const store = new DiaryStore(join(root, 'diary.db'));
  t.after(() => store.close());
  let next = 0;
  const memory = { items: [], async getAll() { return { results: this.items }; },
    async add(text, { agentId, metadata }) {
      const item = { id: `worker-memory-${++next}`, memory: text, agent_id: agentId, metadata };
      this.items.push(item); return { results: [item] };
    } };
  const model = async ({ messages }) => ({ diary: { title: '见面约定', summary: '成员提出每周四见面。',
    events: [{ text: '每周四见面', sourceMessageIds: [messages[0].id], evidenceQuote: '每周四见面' }] },
    coreUpdates: [] });
  const config = { store, memory, model, inboxPath, accountId, groups: [groupA],
    triggerTokens: 100, maxBatchTokens: 5000 };
  assert.equal((await runDiaryCycle(config))[0].status, 'written');
  assert.equal((await runDiaryCycle(config))[0].status, 'idle');
  assert.equal(adapter.drafts().length, 0);
  assert.equal(adapter.db.prepare('SELECT COUNT(*) n FROM inbox').get().n, 1);
});

test('one triggered diary cycle drains bounded sequential segments up to its total budget', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-cycle-budget-'));
  const inboxPath = join(root, 'adapter.db');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  for (let index = 0; index < 30; index++) {
    adapter.commitEvent(String(index + 1), message(`cycle-${index}`, groupA, 'member-a',
      `第${index}条约定` + '打球'.repeat(35)), 'text');
  }
  const store = new DiaryStore(join(root, 'diary.db'));
  t.after(() => store.close());
  let sequence = 0;
  const memory = { items: [], async getAll() { return { results: this.items }; },
    async add(text, { agentId, metadata }) {
      const item = { id: `cycle-memory-${++sequence}`, memory: text, agent_id: agentId, metadata };
      this.items.push(item); return { results: [item] };
    } };
  const model = async ({ messages }) => ({ diary: { title: '约定', summary: '群友聊到打球',
    events: [{ text: '聊到打球', sourceMessageIds: [messages[0].id],
      evidenceQuote: messages[0].text.slice(0, 8) }] }, coreUpdates: [] });
  const result = await runDiaryCycle({ store, memory, model, inboxPath, accountId,
    groups: [groupA], triggerTokens: 1200, maxBatchTokens: 600,
    maxCycleTokens: 1800, now: Date.parse('2026-10-01T12:02:00Z') });
  const written = result.filter(item => item.status === 'written');
  assert.ok(written.length >= 2);
  assert.ok(written.reduce((sum, item) => sum + item.estimatedTokens, 0) <= 1800);
  assert.equal(store.segments(accountId, groupA).length, written.length);
  assert.ok(store.progress(accountId, groupA) < 30);
});

test('DeepSeek diary client sends skill over HTTP and rejects truncated JSON', async t => {
  let request;
  const usage = [];
  const server = createServer(async (incoming, response) => {
    let body = '';
    for await (const chunk of incoming) body += chunk;
    request = { url: incoming.url, authorization: incoming.headers.authorization, body: JSON.parse(body) };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: 'deepseek-flash', usage: { prompt_tokens: 101,
      completion_tokens: 22, total_tokens: 123, prompt_cache_hit_tokens: 80,
      prompt_cache_miss_tokens: 21 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      diary: { title: '无事', summary: '无重要事件', events: [] }, coreUpdates: [],
    }) } }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const model = createDeepSeekDiaryModel({ apiKey: 'test-key',
    baseURL: `http://127.0.0.1:${server.address().port}`, onUsage: record => usage.push(record) });
  const output = await model({ messages: [], coreFacts: [], personHistory: [
    { id: 'older', senderId: 'member-a', at: '2026-11-01T20:00:00+08:00', text: '旧消息' },
  ] });
  assert.equal(output.diary.title, '无事');
  assert.match(request.url, /\/chat\/completions$/);
  assert.equal(request.authorization, 'Bearer test-key');
  assert.equal(request.body.response_format.type, 'json_object');
  assert.equal(request.body.max_tokens, 6000);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.match(request.body.messages[0].content, /SocioMem 滚动记忆 Skill/);
  assert.equal(JSON.parse(request.body.messages[1].content).personHistory[0].id, 'older');
  assert.equal(usage.length, 1);
  assert.equal(usage[0].inputTokens, 101);
  assert.equal(usage[0].outputTokens, 22);
  assert.equal(usage[0].cacheHitTokens, 80);
  assert.equal(usage[0].cacheMissTokens, 21);
  assert.equal(usage[0].modelReturned, 'deepseek-flash');
  assert.ok(usage[0].elapsedMs >= 0);
  assert.throws(() => createDeepSeekDiaryModel({ apiKey: '' }), /DEEPSEEK_API_KEY/);
  const bad = createDeepSeekDiaryModel({ apiKey: 'test-key', onUsage: record => usage.push(record), fetchImpl: async () =>
    new Response(JSON.stringify({ usage: { prompt_tokens: 90, completion_tokens: 6000,
      total_tokens: 6090 }, choices: [{ finish_reason: 'length', message: { content: '{}' } }] }), { status: 200 }) });
  await assert.rejects(bad({ messages: [], coreFacts: [] }),
    error => error.code === 'DIARY_OUTPUT_LIMIT' && /incomplete/.test(error.message));
  assert.equal(usage[1].outputTokens, 6000);
  assert.equal(usage[1].finishReason, 'length');
  assert.equal(usage[1].errorName, 'Error');
  assert.throws(() => createDeepSeekDiaryModel({ apiKey: 'test-key', thinkingMode: 'maybe' }), /SOCIOMEM_DIARY_THINKING/);
});

test('diary watcher fails before touching an Inbox when its model key is unavailable', async () => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'diary-no-key-'));
  const inboxPath = join(root, 'adapter.db');
  const env = { ...process.env, DEEPSEEK_API_KEY: '', SOCIOMEM_DIARY_PROVIDER: 'deepseek',
    SOCIOMEM_WECHAT_GROUPS: groupA,
    SOCIOMEM_WECHAT_DB: inboxPath, SOCIOMEM_DEEPSEEK_KEY_FILE: join(root, 'missing-key') };
  const result = spawnSync(process.execPath, ['scripts/watch-wechat-diary.mjs'],
    { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEEPSEEK_API_KEY is required/);
  assert.equal(existsSync(inboxPath), false);
  const worker = spawnSync(process.execPath, ['scripts/diary-worker.mjs'],
    { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /DEEPSEEK_API_KEY is required/);
  assert.equal(existsSync(inboxPath), false);
});
