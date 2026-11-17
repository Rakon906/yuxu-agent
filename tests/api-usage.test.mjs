import test from 'node:test';
import assert from 'node:assert/strict';
import { operationDigest, recordDeepSeekRequest, summarizeDeepSeekUsage } from '../packages/telemetry/deepseek-usage.mjs';
import { summarizeModelUsage } from '../packages/telemetry/model-usage.mjs';

test('DeepSeek usage summary keeps missing usage separate from measured tokens', () => {
  const records = [];
  const operationId = operationDigest(['participation', 'message-1']);
  const input = { component: 'participation', operationId, modelRequested: 'deepseek-flash',
    elapsedMs: 10, onUsage: row => records.push(row) };
  recordDeepSeekRequest({ ...input, attempt: 1, response: { status: 200 }, payload: {
    model: 'deepseek-flash', choices: [{ finish_reason: 'length' }],
    usage: { prompt_tokens: 100, completion_tokens: 1600, total_tokens: 1700,
      prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40,
      completion_tokens_details: { reasoning_tokens: 0 } },
  } });
  recordDeepSeekRequest({ ...input, attempt: 2, errorName: 'TimeoutError' });
  assert.equal(records[0].operationId, records[1].operationId);
  assert.equal(JSON.stringify(records).includes('message-1'), false);
  const [summary] = summarizeDeepSeekUsage(records);
  assert.equal(summary.requests, 2);
  assert.equal(summary.distinctOperations, 1);
  assert.equal(summary.meanRequestsPerOperation, 2);
  assert.equal(summary.measuredRequests, 1);
  assert.equal(summary.unknownUsageRequests, 1);
  assert.equal(summary.outputTokens, 1600);
  assert.equal(summary.cacheHitTokens, 60);
  assert.equal(summary.lengthResponses, 1);
  assert.equal(summary.errorResponses, 1);
});

test('combined usage counts DeepSeek and local calls while preserving unknown tokens', () => {
  const records = [
    { at: '2026-11-03T10:00:00Z', provider: 'deepseek', component: 'participation',
      modelRequested: 'deepseek-flash', inputTokens: 120, outputTokens: 10,
      cacheHitTokens: 50, elapsedMs: 1000, httpStatus: 200 },
    { at: '2026-11-03T10:01:00Z', provider: 'ollama', component: 'diary',
      modelRequested: 'qwen', inputTokens: 80, outputTokens: 20,
      elapsedMs: 2000, httpStatus: 200 },
    { at: '2026-11-03T10:02:00Z', provider: 'ollama', component: 'participation',
      modelRequested: 'qwen', inputTokens: null, outputTokens: null,
      errorName: 'TimeoutError', elapsedMs: 5000 },
  ];
  const result = summarizeModelUsage(records, { since: Date.parse('2026-11-03T10:00:30Z'), last: 1 });
  assert.equal(result.totalRequests, 2);
  assert.equal(result.providers.deepseek, undefined);
  assert.equal(result.providers.ollama.requests, 2);
  assert.equal(result.providers.ollama.measuredRequests, 1);
  assert.equal(result.providers.ollama.unknownUsageRequests, 1);
  assert.equal(result.providers.ollama.inputTokens, 80);
  assert.equal(result.providers.ollama.outputTokens, 20);
  assert.equal(result.providers.ollama.totalTokens, 100);
  assert.equal(result.providers.ollama.errorRequests, 1);
  assert.equal(result.calls.length, 1);
  assert.equal(result.calls[0].inputTokens, null);
  assert.equal(result.calls[0].totalTokens, null);
  assert.equal(summarizeModelUsage(records, { last: 0 }).calls.length, 0);
});
