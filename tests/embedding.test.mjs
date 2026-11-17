import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmbeddingServer, LOCAL_EMBEDDING_DIMENSION, LOCAL_EMBEDDING_MODEL } from '../packages/embedding/index.mjs';
import { configureLocalMemory } from '../scripts/local-memory-env.mjs';

test('local embedding endpoint uses OpenAI response shape and rejects invalid input', async t => {
  const server = createEmbeddingServer(async text => {
    const vector = Array(LOCAL_EMBEDDING_DIMENSION).fill(0);
    vector[0] = text.length;
    return vector;
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const health = await (await fetch(`${url}/health`)).json();
  assert.deepEqual(health, { status: 'ok', model: LOCAL_EMBEDDING_MODEL, dimensions: 384 });
  const post = body => fetch(`${url}/embeddings`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const response = await post({ model: LOCAL_EMBEDDING_MODEL, input: ['中文', 'test'] });
  assert.equal(response.status, 200);
  const output = await response.json();
  assert.equal(output.object, 'list');
  assert.equal(output.data.length, 2);
  assert.equal(output.data[0].embedding.length, 384);
  assert.equal(output.data[0].embedding[0], 2);
  assert.equal(output.data[1].embedding[0], 4);
  assert.equal((await post({ model: 'different', input: '中文' })).status, 422);
  assert.equal((await post({ model: LOCAL_EMBEDDING_MODEL, input: '' })).status, 422);
  assert.equal((await post({ model: LOCAL_EMBEDDING_MODEL, input: 'a'.repeat(8193) })).status, 422);
});

test('local memory command binds project SQLite and loopback embedding', () => {
  const keys = ['SOCIOMEM_EMBEDDING_BASE_URL', 'SOCIOMEM_EMBEDDING_MODEL',
    'SOCIOMEM_EMBEDDING_DIMENSION', 'SOCIOMEM_EMBEDDING_API_KEY',
    'SOCIOMEM_MEMORY_ROOT', 'SOCIOMEM_MEMORY_ENABLED', 'SOCIOMEM_EMBEDDING_PORT'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    process.env.SOCIOMEM_EMBEDDING_API_KEY = 'must-be-cleared';
    process.env.SOCIOMEM_EMBEDDING_PORT = '11436';
    configureLocalMemory({ enableHarness: true });
    assert.equal(process.env.SOCIOMEM_EMBEDDING_BASE_URL, 'http://127.0.0.1:11436');
    assert.equal(process.env.SOCIOMEM_EMBEDDING_MODEL, LOCAL_EMBEDDING_MODEL);
    assert.equal(process.env.SOCIOMEM_EMBEDDING_DIMENSION, '384');
    assert.equal(process.env.SOCIOMEM_EMBEDDING_API_KEY, undefined);
    assert.match(process.env.SOCIOMEM_MEMORY_ROOT, /[\\/]\.runtime[\\/]memory$/);
    assert.equal(process.env.SOCIOMEM_MEMORY_ENABLED, '1');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
});
