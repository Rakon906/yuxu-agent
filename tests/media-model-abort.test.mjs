import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnthropicJsonModel } from '../packages/model/anthropic.mjs';
import { createOllamaJsonModel } from '../packages/model/ollama.mjs';
import { createStickerVision } from '../packages/model/vision.mjs';

test('video abort reaches either model transport and records no invented token usage', async () => {
  for (const provider of ['anthropic', 'ollama']) {
    const controller = new AbortController(); let observed, usage;
    const config = { apiKey: 'test-key', model: 'test-model', baseURL: 'https://example.com', endpoint: '',
      onUsage: value => { usage = value; },
      fetchImpl: async (_url, options) => { observed = options.signal; controller.abort(); options.signal.throwIfAborted(); } };
    const model = provider === 'anthropic' ? createAnthropicJsonModel(config) : createOllamaJsonModel(config);
    await assert.rejects(model({ component: 'vision', messages: [{ role: 'user', content: 'test' }], maxTokens: 20, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(observed.aborted, true); assert.equal(usage.inputTokens, null); assert.equal(usage.outputTokens, null);
  }
});

test('cancelled image/video interpretation cannot start the fallback model', async () => {
  const controller = new AbortController(); let fallback = 0;
  const vision = createStickerVision({ provider: 'anthropic', anthropic: async ({ signal }) => {
    assert.equal(signal, controller.signal); controller.abort(); throw new Error('cancelled'); },
    ollama: async () => { fallback++; } });
  await assert.rejects(vision({ bytes: Buffer.from([0xff, 0xd8, 0xff]), prompt: 'test', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(fallback, 0);
});
