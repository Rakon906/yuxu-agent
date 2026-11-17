import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { createRuntime, prepareRun, projectRoot } from '../scripts/runtime.mjs';
import { MemoryLedger, approveProposal, memoryScope, openMem0, searchMemories } from '../packages/memory/index.mjs';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';

const ACCOUNT = 'account-test';
const GROUP_A = 'group-a@chatroom';
const GROUP_B = 'group-b@chatroom';

async function embeddingServer() {
  const server = createServer(async (request, response) => {
    if (request.url !== '/embeddings') { response.writeHead(404).end(); return; }
    let body = '';
    for await (const chunk of request) body += chunk;
    const inputs = JSON.parse(body).input;
    const texts = Array.isArray(inputs) ? inputs : [inputs];
    const data = texts.map((text, index) => ({ index, object: 'embedding', embedding: [
      text.includes('成员甲') ? 1 : 0.1, text.includes('游泳') ? 1 : 0.1,
      text.includes('周末') ? 1 : 0.1, 0.5,
    ] }));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data, model: 'synthetic-chinese', usage: { prompt_tokens: 1, total_tokens: 1 } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

test('Mem0 OSS stores approved Chinese facts durably with account and group isolation', { timeout: 30000 }, async t => {
  const parent = join(projectRoot, '.runtime');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'memory-test-'));
  const server = await embeddingServer();
  t.after(() => server.close());
  const env = { SOCIOMEM_MEMORY_ROOT: root, SOCIOMEM_EMBEDDING_BASE_URL: server.url,
    SOCIOMEM_EMBEDDING_MODEL: 'synthetic-chinese', SOCIOMEM_EMBEDDING_DIMENSION: '4' };
  const ledger = new MemoryLedger(join(root, 'proposals.db'));
  t.after(() => ledger.close());
  const memory = await openMem0(env);

  const a = ledger.propose({ accountId: ACCOUNT, groupId: GROUP_A, subjectId: 'wxid-a',
    sourceMessageId: 'message-a', fact: '成员甲周末喜欢游泳' });
  assert.equal(ledger.propose({ accountId: ACCOUNT, groupId: GROUP_A, subjectId: 'wxid-a',
    sourceMessageId: 'message-a', fact: '成员甲周末喜欢游泳' }).key, a.key);
  assert.equal(a.state, 'pending');
  assert.deepEqual(await searchMemories(memory, { accountId: ACCOUNT, groupId: GROUP_A, query: '成员甲游泳' }), []);
  const approved = await approveProposal(ledger, memory, a.key);
  assert.equal(approved.state, 'approved');
  assert.ok(approved.memory_id);

  const interrupted = ledger.propose({ accountId: ACCOUNT, groupId: GROUP_A, subjectId: 'wxid-a',
    sourceMessageId: 'message-interrupted', fact: '成员甲周末也喜欢散步' });
  const scope = memoryScope(ACCOUNT, GROUP_A);
  const partial = await memory.add(interrupted.fact, { agentId: scope, infer: false,
    metadata: { accountId: ACCOUNT, groupId: GROUP_A, subjectId: 'wxid-a',
      sourceMessageId: 'message-interrupted', proposalKey: interrupted.key } });
  const reconciled = await approveProposal(ledger, memory, interrupted.key);
  assert.equal(reconciled.memory_id, partial.results[0].id);
  assert.equal((await memory.getAll({ filters: { agent_id: scope, proposalKey: interrupted.key }, topK: 10 })).results.length, 1);

  const b = ledger.propose({ accountId: ACCOUNT, groupId: GROUP_B, subjectId: 'wxid-b',
    sourceMessageId: 'message-b', fact: '另一个群的秘密周末活动' });
  await approveProposal(ledger, memory, b.key);
  const rejected = ledger.propose({ accountId: ACCOUNT, groupId: GROUP_A, subjectId: 'wxid-a',
    sourceMessageId: 'message-c', fact: '不应进入长期记忆' });
  ledger.reject(rejected.key);
  await assert.rejects(approveProposal(ledger, memory, rejected.key), /Pending proposal/);

  const reopened = await openMem0(env);
  const results = await searchMemories(reopened, { accountId: ACCOUNT, groupId: GROUP_A, query: '成员甲周末游泳' });
  assert.ok(results.some(item => item.id === approved.memory_id && item.fact === '成员甲周末喜欢游泳'));
  assert.ok(results.every(item => item.sourceMessageId !== 'message-b' && item.fact !== rejected.fact));
  assert.deepEqual(await searchMemories(reopened, { accountId: 'other-account', groupId: GROUP_A, query: '成员甲周末游泳' }), []);
  assert.throws(() => memoryScope(ACCOUNT, 'not-a-group'), /chatroom/);

  const saved = new Map();
  for (const [key, value] of Object.entries(env)) { saved.set(key, process.env[key]); process.env[key] = value; }
  const run = await prepareRun('memory-harness');
  let runtime;
  try {
    runtime = createRuntime(run, { groupId: GROUP_A, accountId: ACCOUNT, memoryEnabled: true });
    const found = await runtime.run('[test] memory-search');
    assert.match(found.finalResponse, /成员甲周末喜欢游泳/);
    const denied = await runtime.run('[test] memory-search memory-cross-group');
    assert.match(denied.finalResponse, /GROUP_SCOPE_DENIED/);
    await runtime.close();
    runtime = createRuntime(run, { groupId: GROUP_A, memoryEnabled: false });
    const disabled = await runtime.run('[test] memory-search');
    assert.match(disabled.finalResponse, /TOOL_ERROR/);
  } finally {
    await runtime?.close();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test('memory CLI accepts only an Inbox source and preserves its identity', async () => {
  const parent = join(projectRoot, '.runtime');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'memory-cli-test-'));
  const adapterDb = join(root, 'adapter.db');
  const adapter = new AdapterStore(adapterDb, ACCOUNT);
  adapter.commitEvent('1', { accountId: ACCOUNT, groupId: GROUP_A, userId: 'wxid-a',
    sourceMessageId: 'source-1', text: '我周末喜欢游泳' }, 'text');
  adapter.close();
  const env = { ...process.env, SOCIOMEM_MEMORY_ROOT: join(root, 'memory'), SOCIOMEM_WECHAT_DB: adapterDb };
  const invalid = spawnSync(process.execPath, ['scripts/memory.mjs', 'propose', 'missing', '虚构事实'],
    { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /not in the authorized Inbox/);
  const valid = spawnSync(process.execPath, ['scripts/memory.mjs', 'propose', 'source-1', '成员甲周末喜欢游泳'],
    { cwd: projectRoot, env, encoding: 'utf8' });
  assert.equal(valid.status, 0, valid.stderr);
  const row = JSON.parse(valid.stdout);
  assert.equal(row.account_id, ACCOUNT);
  assert.equal(row.group_id, GROUP_A);
  assert.equal(row.subject_id, 'wxid-a');
  assert.equal(row.source_message_id, 'source-1');
  assert.equal(row.state, 'pending');
});
