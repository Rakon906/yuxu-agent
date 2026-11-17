import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRuntime, prepareRun } from '../scripts/runtime.mjs';

test('real Harness mode mounts DeepSeek API-key plugin and fails closed without key', async () => {
  const run = await prepareRun('runtime-config', { modelMode: 'deepseek', reasoningEffort: 'low' });
  const overlay = await readFile(run.overlay, 'utf8');
  assert.match(overlay, /@deepseek-ai\/dsh-llm-deepseek-api-key/);
  assert.match(overlay, /apiKeyEnv: DEEPSEEK_API_KEY/);
  assert.match(overlay, /reasoningEffort: low/);
  assert.doesNotMatch(overlay, /sociomem-test-model/);

  const prior = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try { assert.throws(() => createRuntime(run, { modelMode: 'deepseek' }), /DEEPSEEK_API_KEY/); }
  finally {
    if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prior;
  }
});
