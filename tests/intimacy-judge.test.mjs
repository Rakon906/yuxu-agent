import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openIntimacyStore } from '../packages/intimacy/index.mjs';
import { createIntimacyJudgeModel, judgeIntimacy, retryPendingIntimacy,
  recoverDiaryIntimacyJobs } from '../packages/intimacy/judge.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const accountId = 'account-test', groupId = 'test@chatroom';
const now = Date.parse('2026-11-16T06:00:00Z');
const change = (userId = 'p1', source = 'm1') => ({ userId, delta: 0.2,
  reason: '主动安慰肥鱼', sourceMessageIds: [source], evidenceQuote: '有事随时跟我说' });
async function setup(t, count = 1) {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'intimacy-judge-test-'));
  const store = openIntimacyStore(join(root, 'intimacy.sqlite'));
  const inboxPath = join(root, 'inbox.sqlite'), inbox = new DatabaseSync(inboxPath);
  inbox.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL)');
  const batch = Array.from({ length: count }, (_, index) => ({ id: `source-${index}`,
    senderId: `friend-${index}`, text: '肥鱼，有事随时跟我说', at: new Date(now).toISOString() }));
  for (const item of batch) inbox.prepare('INSERT INTO inbox VALUES (?,?)').run(item.id,
    JSON.stringify({ accountId, groupId, sourceMessageId: item.id,
      userId: item.senderId, text: item.text, eventTime: item.at }));
  t.after(() => { inbox.close(); store.close(); });
  return { root, store, inbox, inboxPath, accountId, groupId, batch,
    diary: { title: '朋友之间的关心', summary: '群友关心肥鱼' }, segmentId: 'segment-a', now };
}

test('intimacy output budget grows with participants and retries only truncation once', async () => {
  const calls = [];
  const model = createIntimacyJudgeModel({ provider: 'anthropic', anthropic: async args => {
    calls.push(args);
    if (calls.length === 1) throw Object.assign(new Error('truncated'), { code: 'DIARY_OUTPUT_LIMIT' });
    return { changes: [] };
  } });
  assert.deepEqual(await model({ members: Array.from({ length: 20 }, () => ({})) }), { changes: [] });
  assert.deepEqual(calls.map(item => item.maxTokens), [6400, 8192]);
  assert.equal(calls[0].component, 'intimacy');
  assert.deepEqual(calls[0].messages, calls[1].messages);
  const initialBudgets = [];
  for (const provider of ['anthropic', 'ollama']) {
    const capture = async args => { initialBudgets.push(args.maxTokens); return { changes: [] }; };
    await createIntimacyJudgeModel({ provider, anthropic: capture, ollama: capture })({ members: [{}, {}] });
  }
  assert.deepEqual(initialBudgets, [4800, 2400]);
  let networkCalls = 0;
  const offline = createIntimacyJudgeModel({ provider: 'ollama', ollama: async () => {
    networkCalls++; throw new TypeError('offline');
  } });
  await assert.rejects(offline({ members: [] }), /offline/u);
  assert.equal(networkCalls, 1);
  let truncationCalls = 0;
  const alwaysTruncated = createIntimacyJudgeModel({ provider: 'anthropic', anthropic: async () => {
    truncationCalls++; throw Object.assign(new Error('length'), { code: 'DIARY_OUTPUT_LIMIT' });
  } });
  await assert.rejects(alwaysTruncated({ members: [] }), /length/u);
  assert.equal(truncationCalls, 2);
});

test('judgment compacts IDs, validates quoted evidence and does not rescore a completed segment', async t => {
  const fixture = await setup(t);
  let calls = 0;
  const model = async input => {
    calls++;
    assert.equal(input.members[0].userId, 'p1');
    assert.equal(input.members[0].messages[0].id, 'm1');
    assert.ok(!JSON.stringify(input).includes('friend-0'));
    return { changes: [change()] };
  };
  const first = await judgeIntimacy({ ...fixture, model });
  assert.equal(first.queueState, 'done');
  assert.equal(fixture.store.get(accountId, groupId, 'friend-0', now).score, 6.2);
  const again = await judgeIntimacy({ ...fixture, model, now: now + 86400000 });
  assert.equal(again.duplicate, true);
  assert.equal(calls, 1);
  const evidence = JSON.parse(fixture.store.db.prepare('SELECT result_json FROM intimacy_jobs').get().result_json);
  assert.deepEqual(evidence.changes[0].sourceMessageIds, ['source-0']);
});

test('a later invalid member evidence rejects the whole batch, without partial scoring', async t => {
  const fixture = await setup(t, 2);
  const result = await judgeIntimacy({ ...fixture, model: async () => ({
    changes: [change(), change('p2', 'm1')] }) });
  assert.equal(result.queueState, 'failed');
  assert.equal(result.applied.length, 0);
  assert.equal(fixture.store.get(accountId, groupId, 'friend-0', now).score, 6);
  assert.equal(fixture.store.db.prepare('SELECT COUNT(*) n FROM intimacy_events').get().n, 0);
});

test('source recall during inference invalidates changes before applying scores', async t => {
  const fixture = await setup(t);
  const result = await judgeIntimacy({ ...fixture, model: async () => {
    fixture.inbox.prepare("UPDATE inbox SET message=json_set(message,'$.recalled',1)").run();
    return { changes: [change()] };
  } });
  assert.equal(result.queueState, 'failed');
  assert.equal(fixture.store.get(accountId, groupId, 'friend-0', now).score, 6);
});

test('foreign-group sources are rejected before any model request', async t => {
  const fixture = await setup(t);
  fixture.inbox.prepare("UPDATE inbox SET message=json_set(message,'$.groupId','another@chatroom')").run();
  let calls = 0;
  const result = await judgeIntimacy({ ...fixture, model: async () => { calls++; return { changes: [] }; } });
  assert.equal(calls, 0);
  assert.equal(result.queueState, 'failed');
});

test('failed jobs persist across store instances and retry only when due', async t => {
  const fixture = await setup(t);
  const failed = await judgeIntimacy({ ...fixture, model: async () => { throw new Error('offline'); } });
  assert.equal(failed.queueState, 'pending');
  const reopened = openIntimacyStore(join(fixture.root, 'intimacy.sqlite'));
  t.after(() => reopened.close());
  let calls = 0;
  const options = { store: reopened, inboxPath: fixture.inboxPath, accountId, groupIds: [groupId],
    model: async () => { calls++; return { changes: [change()] }; } };
  assert.deepEqual(await retryPendingIntimacy({ ...options, now: now + 1000 }), []);
  assert.deepEqual(await retryPendingIntimacy({ ...options, groupIds: ['else@chatroom'], now: now + 1800000 }), []);
  const retry = await retryPendingIntimacy({ ...options, now: now + 1800000 });
  assert.equal(retry[0].queueState, 'done');
  assert.equal(calls, 1);
  assert.equal(reopened.get(accountId, groupId, 'friend-0', now).score, 6.2);
});

test('persistent failures stop after three attempts and do not busy-poll the model', async t => {
  const fixture = await setup(t);
  let calls = 0;
  const model = async () => { calls++; throw new Error('offline'); };
  await judgeIntimacy({ ...fixture, model });
  const options = { ...fixture, groupIds: [groupId], model };
  await retryPendingIntimacy({ ...options, now: now + 1800000 });
  const final = await retryPendingIntimacy({ ...options, now: now + 5400000 });
  assert.equal(final[0].queueState, 'failed');
  await retryPendingIntimacy({ ...options, now: now + 86400000 });
  assert.equal(calls, 3);
});

test('score updates and successful job completion roll back together on database error', async t => {
  const fixture = await setup(t, 2);
  fixture.store.ensureMembers(accountId, groupId, ['friend-0', 'friend-1'], now);
  fixture.store.db.exec(`CREATE TRIGGER fail_second BEFORE UPDATE ON intimacy
    WHEN NEW.user_id='friend-1' BEGIN SELECT RAISE(ABORT, 'injected'); END`);
  const result = await judgeIntimacy({ ...fixture, model: async () => ({ changes: [change(), change('p2', 'm2')] }) });
  assert.equal(result.queueState, 'pending');
  assert.equal(fixture.store.get(accountId, groupId, 'friend-0', now).score, 6);
  assert.equal(fixture.store.db.prepare('SELECT COUNT(*) n FROM intimacy_events').get().n, 0);
});

test('recovery closes diary-save/enqueue crash gap without replaying unrelated historical diaries', async t => {
  const fixture = await setup(t);
  const diaryPath = join(fixture.root, 'diary.sqlite'), db = new DatabaseSync(diaryPath);
  t.after(() => db.close());
  db.exec(`CREATE TABLE segments(id TEXT PRIMARY KEY,account_id TEXT,group_id TEXT,
    title TEXT,summary TEXT,source_ids_json TEXT,created_at TEXT)`);
  const add = db.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?)');
  add.run('historical', accountId, groupId, '过去', '过去的日记', '["source-0"]', new Date(now - 86400000).toISOString());
  const options = { ...fixture, diaryPath, groupIds: [groupId] };
  assert.equal(recoverDiaryIntimacyJobs(options), 0);
  add.run('crash-gap', accountId, groupId, '新日记', '已存日记但进程退出', '["source-0"]', new Date(now + 1000).toISOString());
  assert.equal(recoverDiaryIntimacyJobs({ ...options, now: now + 2000 }), 1);
  assert.equal(recoverDiaryIntimacyJobs({ ...options, now: now + 3000 }), 0);
  assert.equal(fixture.store.db.prepare('SELECT COUNT(*) n FROM intimacy_jobs').get().n, 1);
  const results = await retryPendingIntimacy({ ...options, now: now + 3000, model: async () => ({ changes: [change()] }) });
  assert.equal(results[0].queueState, 'done');
  assert.equal(recoverDiaryIntimacyJobs({ ...options, segmentIds: ['crash-gap'], now: now + 4000 }), 0);
});
