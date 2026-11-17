import test from 'node:test';
import assert from 'node:assert/strict';
import { createStickerVision, imageMediaType, stickerVisionPrompt } from '../packages/model/vision.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');

test('sticker vision sends an Anthropic image block and reports the remote model', async () => {
  let request;
  const vision = createStickerVision({ provider: 'anthropic', anthropicModel: 'deepseek-v4.1-flash',
    anthropic: async value => { request = value; return { summary: '两只兔子', visibleText: '', tone: '在打招呼' }; },
    ollama: async () => { throw new Error('must not fall back'); } });
  const output = await vision({ bytes: png, prompt: '只输出 JSON' });
  assert.deepEqual(output, { summary: '两只兔子', visibleText: '', tone: '在打招呼', model: 'deepseek-v4.1-flash' });
  assert.equal(request.component, 'vision');
  assert.equal(request.maxTokens, 8000);
  assert.equal(request.messages[0].content[0].type, 'image');
  assert.equal(request.messages[0].content[0].source.media_type, 'image/png');
  assert.equal(request.messages[0].content[0].source.data, png.toString('base64'));
  assert.equal(request.messages[0].content[1].text, '只输出 JSON');
});

test('sticker vision falls back to Ollama when the remote model fails', async () => {
  let fallbackRequest, fallbackError;
  const vision = createStickerVision({ provider: 'anthropic', anthropicModel: 'remote', ollamaModel: 'qwen-test',
    anthropic: async () => { throw new Error('gateway down'); },
    ollama: async value => { fallbackRequest = value; return { summary: '备用描述' }; },
    onFallback: error => { fallbackError = error.message; } });
  const output = await vision({ bytes: png, prompt: '描述' });
  assert.deepEqual(output, { summary: '备用描述', model: 'qwen-test' });
  assert.equal(fallbackError, 'gateway down');
  assert.equal(fallbackRequest.messages[0].content, '描述');
  assert.deepEqual(fallbackRequest.messages[0].images, [png.toString('base64')]);
});

test('sticker vision media types and prompt cover supported formats', () => {
  assert.equal(imageMediaType(png), 'image/png');
  assert.equal(imageMediaType(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(imageMediaType(Buffer.from('GIF89a', 'ascii')), 'image/gif');
  assert.equal(imageMediaType(Buffer.from('RIFF0000WEBP', 'ascii')), 'image/webp');
  assert.throws(() => imageMediaType(Buffer.from('hello')), /Unsupported/u);
  assert.match(stickerVisionPrompt(['安慰/抱抱', '无语/尴尬']), /安慰\/抱抱、无语\/尴尬/u);
});
