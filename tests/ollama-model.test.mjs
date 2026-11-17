import test from 'node:test';
import assert from 'node:assert/strict';
import { createOllamaJsonModel, defaultOllamaModel } from '../packages/model/ollama.mjs';
import { createAgentParticipationModel } from '../packages/participation/model.mjs';
import { createAgentDiaryModel } from '../packages/diary/model.mjs';

test('local Qwen uses Ollama JSON mode without thinking and records usage', async () => {
  let request;
  const usage = [];
  const ollama = createOllamaJsonModel({ baseURL: 'http://127.0.0.1:11436',
    onUsage: record => usage.push(record), fetchImpl: async (url, options) => {
      request = { url: String(url), body: JSON.parse(options.body) };
      return new Response(JSON.stringify({ model: defaultOllamaModel, done_reason: 'stop',
        message: { content: '{"ok":true}' }, prompt_eval_count: 42, eval_count: 8 }), { status: 200 });
    } });
  assert.deepEqual(await ollama({ component: 'participation', maxTokens: 100,
    messages: [{ role: 'user', content: 'JSON only' }] }), { ok: true });
  assert.equal(request.url, 'http://127.0.0.1:11436/api/chat');
  assert.equal(request.body.model, defaultOllamaModel);
  assert.equal(request.body.format, 'json');
  assert.equal(request.body.think, false);
  assert.equal(request.body.options.num_predict, 100);
  assert.equal(usage[0].inputTokens, 42);
  assert.equal(usage[0].outputTokens, 8);
});

test('local participation and diary preserve their existing prompts and payloads', async () => {
  const calls = [];
  const ollama = async request => { calls.push(request); return { local: true }; };
  const participation = createAgentParticipationModel({ ollama, fallback: 'none' });
  assert.deepEqual(await participation({ target: { id: 'm1', senderId: 'member', text: '在吗？',
    at: '2026-11-03T12:00:00+08:00' }, context: [], kind: 'question', mustReply: true,
  coreFacts: [], latestDiary: null }), { local: true });
  assert.equal(JSON.parse(calls[0].messages[1].content).target.id, 'm1');
  assert.match(calls[0].messages[0].content, /肥鱼不肥/);
  assert.match(calls[0].messages[0].content, /生活在天津/);
  assert.match(calls[0].messages[0].content, /被叫帮忙：群友：“肥鱼帮我看看这个”/);
  assert.match(calls[0].messages[0].content, /朋友难过：群友：“今天心情好差”/);
  assert.match(calls[0].messages[0].content, /群友：“肥鱼干嘛呢” 肥鱼：“刚在听歌，咋啦”/);
  assert.match(calls[0].messages[0].content, /先接住他说的具体事/);
  assert.doesNotMatch(calls[0].messages[0].content, /怎么又是我/);
  assert.doesNotMatch(calls[0].messages[0].content, /电脑里那个很贵的东西/);
  const diary = createAgentDiaryModel({ ollama, fallback: 'none' });
  assert.deepEqual(await diary({ messages: [{ id: 'm1', text: '在吗？' }], coreFacts: [] }), { local: true });
  assert.equal(JSON.parse(calls[1].messages[1].content).messages[0].id, 'm1');
  assert.match(calls[1].messages[0].content, /SocioMem/);
});

test('local diary restores short source labels before evidence validation', async () => {
  const diary = createAgentDiaryModel({ fallback: 'none', ollama: async request => {
    const input = JSON.parse(request.messages[1].content);
    assert.equal(input.messages[0].id, 'm1');
    assert.equal(input.personHistory[0].id, 'h1');
    return { diary: { title: '约定', summary: '约好见面', events: [
      { text: '约好见面', sourceMessageIds: ['m1'], evidenceQuote: '周五见' } ] },
    coreUpdates: [{ action: 'add', category: 'interest', fact: '喜欢游戏',
      subjectId: 'member', sourceMessageIds: ['m1', 'h1'], evidenceQuote: '周五见' }] };
  } });
  const result = await diary({ messages: [{ id: 'long-original-id', text: '周五见' }],
    personHistory: [{ id: 'older-original-id', text: '旧消息' }], coreFacts: [] });
  assert.deepEqual(result.diary.events[0].sourceMessageIds, ['long-original-id']);
  assert.deepEqual(result.coreUpdates[0].sourceMessageIds,
    ['long-original-id', 'older-original-id']);
});

test('local diary retries an output limit with the larger bounded output budget', async () => {
  const budgets = [];
  const diary = createAgentDiaryModel({ fallback: 'none', ollama: async request => {
    budgets.push(request.maxTokens);
    if (budgets.length === 1) {
      const error = new Error('output limit');
      error.code = 'DIARY_OUTPUT_LIMIT';
      throw error;
    }
    return { diary: { title: '片段', summary: '简短记录', events: [] }, coreUpdates: [] };
  } });
  await diary({ messages: [{ id: 'm1', text: '简短记录' }], coreFacts: [] });
  assert.deepEqual(budgets, [16000, 24000]);
});

test('local model errors do not silently become an empty decision', async () => {
  const ollama = createOllamaJsonModel({ onUsage: () => {}, fetchImpl: async () =>
    new Response(JSON.stringify({ done_reason: 'length', message: { content: '{}' } }), { status: 200 }) });
  await assert.rejects(ollama({ component: 'diary', maxTokens: 100,
    messages: [{ role: 'user', content: 'test' }] }),
  error => error.code === 'DIARY_OUTPUT_LIMIT');
  const participation = createAgentParticipationModel({ fallback: 'none',
    ollama: async () => { throw new Error('offline'); } });
  await assert.rejects(participation({ target: { id: 'm1', senderId: 'member', text: '你好',
    at: '2026-11-03T12:00:00+08:00' }, context: [], kind: 'ordinary', mustReply: false,
  coreFacts: [], latestDiary: null }), /offline/);
});
