import test from 'node:test';
import assert from 'node:assert/strict';
import { anthropicMessagesUrl, createAnthropicJsonModel } from '../packages/model/anthropic.mjs';
import { createAgentParticipationModel } from '../packages/participation/model.mjs';
import { createAgentDiaryModel } from '../packages/diary/model.mjs';

const message = content => ({ ok: true, status: 200, json: async () => ({
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'deepseek-v4.1-flash',
  content, stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 5 } }) });

test('Anthropic-compatible model sends a Messages API request and parses JSON text', async () => {
  let request;
  const usage = [];
  const model = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    baseURL: 'https://opencode.ai/inference/go/anthropic', endpoint: '', auth: 'x-api-key',
    onUsage: record => usage.push(record), fetchImpl: async (url, options) => {
      request = { url: url.toString(), headers: options.headers, body: JSON.parse(options.body) };
      return message([{ type: 'text', text: '{"shouldReply":true,"reply":"在。"}' }]);
    } });
  const output = await model({ component: 'participation', maxTokens: 1600, temperature: 0.4,
    messages: [{ role: 'system', content: '只输出 JSON。' }, { role: 'user', content: '{"target":"hi"}' }] });
  assert.deepEqual(output, { shouldReply: true, reply: '在。' });
  assert.equal(request.url, 'https://opencode.ai/inference/go/anthropic/v1/messages');
  assert.equal(request.headers['x-api-key'], 'fixture-key');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  assert.equal(request.headers['x-opencode-session'], 'sociomem-participation');
  assert.equal(request.headers['user-agent'], 'sociomem-agent/0.1');
  assert.equal(request.body.model, 'deepseek-v4.1-flash');
  assert.equal(request.body.max_tokens, 1600);
  assert.equal(request.body.temperature, 0.4);
  assert.equal(request.body.system, '只输出 JSON。');
  assert.deepEqual(request.body.messages, [{ role: 'user', content: '{"target":"hi"}' }]);
  assert.equal(request.body.thinking, undefined);
  assert.equal(usage[0].provider, 'anthropic');
  assert.equal(usage[0].inputTokens, 12);
  assert.equal(usage[0].outputTokens, 5);
  assert.equal(usage[0].totalTokens, 17);
  assert.equal(usage[0].finishReason, 'end_turn');
});

test('Anthropic-compatible model accepts JSON wrapped in a fenced code block', async () => {
  const model = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    baseURL: 'https://gateway.test/anthropic', endpoint: '', onUsage: () => {},
    fetchImpl: async () => message([
      { type: 'thinking', thinking: '先想想' },
      { type: 'text', text: '```json\n{"summary":"截图","safety":"safe"}\n```' },
    ]) });
  assert.deepEqual(await model({ component: 'vision', maxTokens: 8000,
    messages: [{ role: 'user', content: '看图' }] }), { summary: '截图', safety: 'safe' });
});

test('Anthropic-compatible model supports a full endpoint and bearer auth', async () => {
  let request;
  const model = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    endpoint: 'https://gateway.test/inference/go/anthropic/v1/messages', auth: 'bearer',
    onUsage: () => {}, fetchImpl: async (url, options) => {
      request = { url: url.toString(), headers: options.headers };
      return message([{ type: 'text', text: '{"ok":true}' }]);
    } });
  assert.deepEqual(await model({ component: 'diary', maxTokens: 100,
    messages: [{ role: 'user', content: 'hi' }] }), { ok: true });
  assert.equal(request.url, 'https://gateway.test/inference/go/anthropic/v1/messages');
  assert.equal(request.headers.authorization, 'Bearer fixture-key');
  assert.equal(request.headers['x-api-key'], undefined);
  assert.equal(request.headers['x-opencode-session'], 'sociomem-diary');
});

test('Anthropic-compatible model treats max_tokens as an output limit and surfaces HTTP errors', async () => {
  const limited = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    baseURL: 'https://gateway.test/anthropic', endpoint: '', onUsage: () => {},
    fetchImpl: async () => message([{ type: 'text', text: '{"partial":' }]) });
  const maxed = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    baseURL: 'https://gateway.test/anthropic', endpoint: '', onUsage: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({
      content: [], stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 1600 } }) }) });
  await assert.rejects(limited({ component: 'diary', maxTokens: 1600,
    messages: [{ role: 'user', content: 'hi' }] }), /not valid JSON/u);
  await assert.rejects(maxed({ component: 'diary', maxTokens: 1600,
    messages: [{ role: 'user', content: 'hi' }] }),
  error => error.code === 'DIARY_OUTPUT_LIMIT');
  const denied = createAnthropicJsonModel({ apiKey: 'fixture-key', model: 'deepseek-v4.1-flash',
    baseURL: 'https://gateway.test/anthropic', endpoint: '', onUsage: () => {},
    fetchImpl: async () => ({ ok: false, status: 401, json: async () =>
      ({ error: { type: 'authentication_error', message: 'invalid key' } }) }) });
  await assert.rejects(denied({ component: 'participation', maxTokens: 100,
    messages: [{ role: 'user', content: 'hi' }] }), /HTTP 401 authentication_error/u);
});

test('Anthropic-compatible endpoint validation and key requirements fail closed', () => {
  assert.throws(() => createAnthropicJsonModel({ apiKey: 'k', model: 'm', endpoint: 'http://remote.test/v1/messages' }),
    /HTTPS/u);
  assert.throws(() => createAnthropicJsonModel({ apiKey: 'k', model: 'm', endpoint: '', baseURL: '' }),
    /BASE_URL/u);
  assert.throws(() => createAnthropicJsonModel({ apiKey: '', model: 'm', baseURL: 'https://gateway.test' }),
    /API_KEY/u);
  assert.throws(() => createAnthropicJsonModel({ apiKey: 'k', model: '', baseURL: 'https://gateway.test' }),
    /ANTHROPIC_MODEL/u);
  assert.equal(anthropicMessagesUrl({ baseURL: 'https://gateway.test/v1' }).toString(),
    'https://gateway.test/v1/messages');
});

test('participation and diary provider selection routes to the Anthropic model', async () => {
  const calls = [];
  const participation = createAgentParticipationModel({ provider: 'anthropic', fallback: 'none',
    anthropic: async request => { calls.push(request); return { shouldReply: false }; } });
  assert.deepEqual(await participation({ target: { id: 'm1', senderId: 'member', text: '在吗？',
    at: '2026-11-05T12:00:00+08:00' }, context: [], kind: 'ordinary', mustReply: false,
  coreFacts: [], latestDiary: null }), { shouldReply: false });
  assert.equal(calls[0].component, 'participation');
  assert.equal(calls[0].maxTokens, 1600);
  assert.equal(calls[0].temperature, 0.4);
  assert.equal(calls[0].messages[0].role, 'system');
  assert.equal(JSON.parse(calls[0].messages[1].content).target.id, 'm1');
  const diary = createAgentDiaryModel({ provider: 'anthropic', fallback: 'none',
    anthropic: async request => { calls.push(request); return { diary: { title: '约定' } }; } });
  assert.deepEqual(await diary({ messages: [{ id: 'm1', text: '在吗？' }], coreFacts: [] }),
    { diary: { title: '约定' } });
  assert.equal(calls[1].component, 'diary');
  assert.ok(Number.isSafeInteger(calls[1].maxTokens) && calls[1].maxTokens >= 1000);
  assert.equal(JSON.parse(calls[1].messages[1].content).messages[0].id, 'm1');
});
