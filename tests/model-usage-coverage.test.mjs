import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readModelUsage, summarizeModelUsage } from '../packages/telemetry/model-usage.mjs';
import { createAnthropicJsonModel } from '../packages/model/anthropic.mjs';

const at = '2026-11-12T09:00:00Z';
const record = (provider, extra = {}) => ({ at, provider, component: 'test',
  modelRequested: 'synthetic', inputTokens: 10, outputTokens: 3, ...extra });

function files(t) {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = Object.fromEntries(['deepseek', 'ollama', 'anthropic', 'image']
    .map(name => [`${name}File`, join(root, `${name}.jsonl`)]));
  return { root, options };
}

test('reads all four channels without rewriting historical files or counting a shared path twice', t => {
  const { options } = files(t);
  for (const [name, filename] of Object.entries(options)) {
    const provider = name.replace('File', '');
    const row = provider === 'deepseek' ? { at, component: 'diary', inputTokens: 4, outputTokens: 2 }
      : record(provider, provider === 'image' ? { inputTokens: null, outputTokens: null } : {});
    writeFileSync(filename, `${JSON.stringify(row)}\n`);
  }
  const result = summarizeModelUsage(readModelUsage(options));
  assert.equal(result.totalRequests, 4);
  assert.equal(result.providers.anthropic.requests, 1);
  assert.equal(result.providers.image.unknownUsageRequests, 1);
  assert.equal(result.executions.local.requests, 1);
  assert.equal(result.executions.remote.requests, 3);
  assert.equal(readModelUsage({ ...options, imageFile: options.anthropicFile }).length, 3);
});

test('only explicit request IDs are deduplicated; identical historical calls and fallback attempts remain distinct', () => {
  const rows = [record('anthropic'), record('anthropic'), record('anthropic', { requestId: 'a' }),
    record('anthropic', { requestId: 'a' }), record('image', { requestId: 'a', attempt: 1 }),
    record('image', { requestId: 'b', attempt: 2 })];
  const result = summarizeModelUsage(rows, { last: 'all' });
  assert.equal(result.totalRequests, 5);
  assert.equal(result.duplicateRecordsIgnored, 1);
  assert.equal(result.providers.anthropic.requests, 3);
  assert.equal(result.providers.image.requests, 2);
});

test('partial tokens, cache and latency have independent coverage instead of becoming invented zero usage', () => {
  const rows = [record('anthropic', { inputTokens: 12, outputTokens: null, elapsedMs: 120 }),
    record('anthropic', { inputTokens: 20, outputTokens: 5, cacheHitTokens: 7, elapsedMs: 80 }),
    record('anthropic', { inputTokens: null, outputTokens: null, errorName: 'TimeoutError' })];
  const result = summarizeModelUsage(rows, { last: 'all' });
  const group = result.providers.anthropic;
  assert.equal(group.unknownUsageRequests, 2);
  assert.equal(group.measuredRequests, 1);
  assert.equal(group.inputTokens, 32);
  assert.equal(group.measuredInputRequests, 2);
  assert.equal(group.outputTokens, 5);
  assert.equal(group.totalTokens, 25);
  assert.equal(group.measuredTotalRequests, 1);
  assert.equal(group.measuredCacheRequests, 1);
  assert.equal(group.cacheHitTokens, 7);
  assert.equal(group.meanElapsedMs, 100);
  assert.equal(group.errorRequests, 1);
  assert.equal(result.calls[0].outputTokens, null);
  assert.equal(result.calls[2].cacheHitTokens, null);
  assert.equal(result.calls[2].elapsedMs, null);
});

test('OpenCode is a service on the Anthropic channel, not a second DeepSeek API call', async () => {
  const rows = [];
  const model = createAnthropicJsonModel({ apiKey: 'synthetic-private-key', model: 'deepseek-test',
    baseURL: 'https://opencode.ai/inference/go/anthropic', endpoint: '', onUsage: row => rows.push(row),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ model: 'deepseek-test',
      content: [{ type: 'text', text: '{"ok":true}' }], stop_reason: 'end_turn',
      usage: { input_tokens: 15, output_tokens: 4, cache_read_input_tokens: 2 } }) }) });
  await model({ component: 'vision', messages: [{ role: 'user', content: 'synthetic-private-prompt' }], maxTokens: 100 });
  await model({ component: 'vision', messages: [{ role: 'user', content: 'second' }], maxTokens: 100 });
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  assert.equal(rows[0].service, 'opencode');
  const report = summarizeModelUsage(rows);
  assert.equal(report.providers.anthropic.requests, 2);
  assert.equal(report.providers.deepseek, undefined);
  assert.equal(report.modules[0].service, 'opencode');
  assert.ok(!JSON.stringify(rows).includes('synthetic-private'));
});
