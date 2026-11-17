import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { CommentReplyStore, CommentReplyService } from '../packages/moments/comment-reply-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const accountId = 'account-test', selfId = 'wxid_self';
const now = 1794389000000;
const source = { commentId: '33', userId: 'wxid_friend', name: '朋友', text: '看到你啦',
  createTime: Math.floor(now / 1000) - 30, replyTo: null, replyCommentId: null };
const baseMoment = () => ({ id: '15052416207825474047', author: { id: selfId, name: '肥鱼' },
  text: '摸鱼时间', createTime: Math.floor(now / 1000) - 60, comments: [{ ...source }] });
const clone = value => JSON.parse(JSON.stringify(value));

function fixture(t, overrides = {}) {
  const runs = join(root, '.runtime', 'runs');
  mkdirSync(runs, { recursive: true });
  const filename = join(mkdtempSync(join(runs, 'comment-reply-')), 'reply.sqlite');
  const store = new CommentReplyStore(filename, { accountId, selfId, now: () => now });
  t.after(() => { try { store.close(); } catch { /* Explicitly closed restart fixture. */ } });
  const calls = { read: 0, send: 0, verify: 0 };
  const gateway = {
    readMoment: async () => { calls.read++; return baseMoment(); },
    send: async () => { calls.send++; return { baseCode: 0, commentId: '34' }; },
    verify: async input => { calls.verify++; return { verified: true, commentId: '34',
      momentId: input.momentId, sourceCommentId: input.sourceComment.commentId,
      replyTo: input.sourceComment.userId, authorId: input.selfId }; },
    ...overrides,
  };
  const service = new CommentReplyService({ store, gateway, accountId, selfId });
  const prepare = (extra = {}) => service.prepare({ moment: baseMoment(), comment: { ...source }, text: '嘿嘿，摸会儿鱼', ...extra });
  return { filename, store, service, gateway, calls, prepare };
}

test('reply preparation is immutable, account-bound and unique per source comment', t => {
  const { filename, service, store, prepare } = fixture(t);
  const draft = prepare();
  assert.equal(draft.state, 'draft');
  assert.equal(draft.attemptedAt, null);
  assert.match(draft.digest, /^[a-f0-9]{64}$/u);
  assert.match(draft.clientId, /^[a-f0-9]{32}$/u);
  assert.deepEqual(prepare(), draft);
  assert.throws(() => prepare({ text: '换一句' }), /immutable/u);
  assert.equal(store.rows().length, 1);
  assert.equal(store.rows('draft').length, 1);
  assert.throws(() => new CommentReplyStore(filename, { accountId: 'another', selfId }), /identity/u);
  assert.throws(() => new CommentReplyStore(filename, { accountId, selfId: 'wxid_another' }), /identity/u);
  assert.throws(() => new CommentReplyService({ store, accountId: 'another', selfId }), /identity/u);
  assert.throws(() => service.prepare({ moment: baseMoment(), comment: { ...source, text: '假消息' }, text: 'hi' }), /match/u);
  const own = { ...source, userId: selfId };
  assert.throws(() => service.prepare({ moment: { ...baseMoment(), comments: [own] }, comment: own, text: 'hi' }), /own comment/u);
});

test('persisted game promises are skipped before reading or sending, including subsequent attempts', async t => {
  const { service, store, calls, prepare } = fixture(t);
  const draft = prepare({ text: '我这就上号打三角洲' });
  const restoredService = new CommentReplyService({ store, gateway: service.gateway, accountId, selfId });
  const result = await restoredService.send(draft.key, draft.digest);
  assert.equal(result.state, 'skipped');
  assert.equal(result.attemptedAt, null);
  assert.equal(result.verification.reason, 'cannot_play_games');
  assert.equal((await restoredService.send(draft.key, draft.digest)).state, 'skipped');
  assert.deepEqual(calls, { read: 0, send: 0, verify: 0 });
});

test('send claims once, verifies the source and passes persisted identities to the gateway', async t => {
  const { service, store, gateway, calls, prepare } = fixture(t);
  const draft = prepare();
  gateway.send = async (input, { onResponse }) => {
    calls.send++;
    const claimed = store.get(draft.key);
    assert.equal(claimed.state, 'dispatching');
    assert.equal(input.attemptedAt, now);
    assert.equal(input.clientId, draft.clientId);
    assert.deepEqual(input.comment, { ...source, type: 2, source: 0 });
    await onResponse({ phase: 'send', httpStatus: 200, responseBody: '{"baseCode":0}',
      receivedAt: new Date(now).toISOString(), token: 'not-persisted', request: 'not-persisted' });
    return { baseCode: 0, commentId: '34' };
  };
  gateway.verify = async (input, { onResponse }) => {
    calls.verify++;
    assert.equal(store.get(draft.key).state, 'accepted');
    assert.deepEqual(input.priorCommentIds, ['33']);
    assert.equal(input.sentAt, Math.floor(now / 1000));
    assert.equal(input.sourceComment.commentId, '33');
    await onResponse({ phase: 'detail', httpStatus: 200, responseBody: '{"commentId":"34"}',
      receivedAt: new Date(now + 1000).toISOString() });
    return { verified: true, commentId: '34' };
  };
  assert.equal((await service.send(draft.key, draft.digest)).state, 'verified');
  assert.equal((await service.send(draft.key, draft.digest)).state, 'verified');
  assert.deepEqual(calls, { read: 1, send: 1, verify: 1 });
  const responses = store.responses(draft.key);
  assert.deepEqual(responses.map(row => row.phase), ['send', 'detail']);
  assert.equal(responses[0].sha256, createHash('sha256').update(responses[0].body).digest('hex'));
  assert.equal(JSON.stringify(responses).includes('not-persisted'), false);
});

test('incorrect confirmation and changed source never produce a write request', async t => {
  const { service, gateway, calls, prepare } = fixture(t);
  const draft = prepare();
  await assert.rejects(() => service.send(draft.key, '0'.repeat(64)), /confirmation/u);
  assert.equal(calls.read, 0);
  gateway.readMoment = async () => ({ ...baseMoment(), comments: [{ ...source, replyTo: 'wxid_other' }] });
  assert.equal((await service.send(draft.key, draft.digest)).state, 'stale');
  assert.equal((await service.send(draft.key, draft.digest)).attemptedAt, null);
  assert.equal(calls.send, 0);
});

test('removed, ambiguous and altered comments are each blocked before dispatch', async t => {
  const replacements = [[], [{ ...source }, { ...source }], [{ ...source, text: '改过' }],
    [{ ...source, userId: 'wxid_other' }], [{ ...source, createTime: source.createTime + 1 }],
    [{ ...source, replyCommentId: '11' }]];
  for (const comments of replacements) {
    const { service, calls, prepare } = fixture(t, { readMoment: async () => ({ ...baseMoment(), comments }) });
    const draft = prepare();
    assert.equal((await service.send(draft.key, draft.digest)).state, 'stale');
    assert.equal(calls.send, 0);
  }
});

test('unavailable moment remains unattempted and a preflight transport error does not claim it', async t => {
  const { service, gateway, store, prepare, calls } = fixture(t);
  const draft = prepare();
  gateway.readMoment = async () => { throw new Error('temporary unavailable'); };
  await assert.rejects(() => service.send(draft.key, draft.digest), /no reply was submitted/u);
  assert.equal(store.get(draft.key).state, 'draft');
  gateway.readMoment = async () => null;
  assert.equal((await service.send(draft.key, draft.digest)).state, 'stale');
  assert.equal(calls.send, 0);
});

test('an equivalent existing self reply is skipped while unrelated self comments do not suppress a reply', async t => {
  for (const matches of [true, false]) {
    const { service, gateway, calls, prepare } = fixture(t);
    const draft = prepare();
    gateway.readMoment = async () => ({ ...baseMoment(), comments: [{ ...source }, {
      userId: selfId, commentId: '22', text: draft.text, createTime: source.createTime + 1,
      replyTo: matches ? source.userId : 'wxid_other', replyCommentId: '33',
    }] });
    const result = await service.send(draft.key, draft.digest);
    assert.equal(result.state, matches ? 'skipped' : 'verified');
    assert.equal(calls.send, matches ? 0 : 1);
  }
});

test('two concurrent callers atomically claim one send even with separate SQLite connections', async t => {
  const { filename, service, store, gateway, calls, prepare } = fixture(t);
  const draft = prepare();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  gateway.send = async () => { calls.send++; await gate; return { baseCode: 0 }; };
  const secondStore = new CommentReplyStore(filename, { accountId, selfId, now: () => now });
  t.after(() => secondStore.close());
  const second = new CommentReplyService({ store: secondStore, gateway, accountId, selfId });
  const firstRun = service.send(draft.key, draft.digest);
  const secondRun = second.send(draft.key, draft.digest);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.send, 1);
  release();
  const outcomes = await Promise.all([firstRun, secondRun]);
  assert.ok(outcomes.every(row => row.state === 'verified'));
  assert.equal(store.get(draft.key).state, 'verified');
});

test('timeout after response persistence survives restart and only verifies, never reposts', async t => {
  const { filename, service, store, gateway, calls, prepare } = fixture(t);
  const draft = prepare();
  gateway.send = async (_input, { onResponse }) => {
    calls.send++;
    await onResponse({ phase: 'send', httpStatus: 200, responseBody: '{"unknown":"shape"}',
      receivedAt: new Date(now).toISOString() });
    throw new SyntaxError('unexpected response');
  };
  assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  store.close();
  const restarted = new CommentReplyStore(filename, { accountId, selfId });
  t.after(() => restarted.close());
  const resumed = new CommentReplyService({ store: restarted, gateway, accountId, selfId });
  assert.equal((await resumed.send(draft.key, draft.digest)).state, 'verified');
  assert.equal(calls.send, 1);
  assert.equal(calls.read, 1);
  assert.equal(restarted.responses(draft.key)[0].body, '{"unknown":"shape"}');
});

test('crash after atomic claim has only read verification on resume', async t => {
  const { service, store, calls, prepare } = fixture(t);
  const draft = prepare();
  store.claim(draft.key, draft.digest, ['33']);
  assert.equal((await service.send(draft.key, draft.digest)).state, 'verified');
  assert.equal(calls.send, 0);
  assert.equal(calls.read, 0);
});

test('nested reply deduplication uses the direct source ID, not the conversation root', async t => {
  const nested = { ...source, commentId: '44', replyCommentId: '11', replyTo: selfId };
  const moment = { ...baseMoment(), comments: [nested] };
  for (const direct of [true, false]) {
    const { service, gateway, calls } = fixture(t);
    const draft = service.prepare({ moment, comment: nested, text: '接到了' });
    gateway.readMoment = async () => ({ ...moment, comments: [nested, {
      userId: selfId, commentId: '22', text: draft.text, createTime: nested.createTime,
      replyTo: nested.userId, replyCommentId: direct ? '44' : '11',
    }] });
    assert.equal((await service.send(draft.key, draft.digest)).state, direct ? 'skipped' : 'verified');
    assert.equal(calls.send, direct ? 0 : 1);
  }
});

test('unknown receipt and missing detail remain needs_review and repeated status never sends', async t => {
  const { service, calls, prepare } = fixture(t, {
    send: async () => { calls.send++; return {}; },
    verify: async () => { calls.verify++; return { verified: false, reason: 'not_visible' }; },
  });
  const draft = prepare();
  assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  await service.status(draft.key);
  await service.send(draft.key, draft.digest);
  assert.equal(calls.send, 1);
  assert.equal(calls.read, 1);
  assert.equal(calls.verify, 3);
});

test('explicit rejection is terminal and does not call verification', async t => {
  const { service, calls, prepare } = fixture(t, { send: async () => { calls.send++; return { baseCode: 205 }; } });
  const draft = prepare();
  assert.equal((await service.send(draft.key, draft.digest)).state, 'rejected');
  await service.send(draft.key, draft.digest);
  assert.equal(calls.send, 1);
  assert.equal(calls.verify, 0);
});

test('wrong target, preexisting ID and invalid ID cannot be marked verified', async t => {
  for (const fields of [{ replyTo: 'wxid_other' }, { momentId: '999' }, { sourceCommentId: '88' },
    { authorId: 'wxid_other' }, { replyCommentId: '77' }, { text: 'another' }, { commentId: '33' }, { commentId: null },
    { commentId: '18446744073709551616' }, { verified: false }]) {
    const { service, prepare } = fixture(t, { verify: async () => ({ verified: true, commentId: '34', ...fields }) });
    const draft = prepare();
    assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  }
});

test('response recording rejects unattempted jobs, wrong identity and oversized bodies', t => {
  const { store, prepare } = fixture(t);
  const draft = prepare();
  const response = { accountId, selfId, phase: 'send', httpStatus: 200,
    responseBody: '{}', receivedAt: new Date(now).toISOString() };
  assert.throws(() => store.recordResponse(draft.key, response), /not attempted/u);
  store.claim(draft.key, draft.digest, ['33']);
  assert.throws(() => store.recordResponse(draft.key, { ...response, accountId: 'other' }), /identity/u);
  assert.throws(() => store.recordResponse(draft.key, { ...response, responseBody: 'x'.repeat(8 * 1024 * 1024 + 4097) }), /oversized/u);
  assert.throws(() => store.recordResponse(draft.key, { ...response, responseBody: '\ud800' }), /Invalid/u);
  store.recordResponse(draft.key, response);
  assert.equal(store.responses(draft.key).length, 1);
});

test('a persistence failure after a network response does not issue another send', async t => {
  const { service, store, gateway, calls, prepare } = fixture(t);
  const draft = prepare();
  store.recordResponse = () => { throw new Error('disk full'); };
  gateway.send = async (_input, { onResponse }) => {
    calls.send++;
    await onResponse({ phase: 'send', httpStatus: 200, responseBody: '{}', receivedAt: new Date(now).toISOString() });
    return { baseCode: 0 };
  };
  assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  await service.send(draft.key, draft.digest);
  assert.equal(calls.send, 1);
});

test('draft corruption is detected before any source read or write', async t => {
  const { service, store, calls, prepare } = fixture(t);
  const draft = prepare();
  const payload = clone(draft);
  payload.text = 'changed behind the digest';
  store.db.prepare('UPDATE comment_reply_jobs SET draft_json=? WHERE key=?').run(JSON.stringify(payload), draft.key);
  await assert.rejects(() => service.send(draft.key, draft.digest), /integrity/u);
  assert.deepEqual(calls, { read: 0, send: 0, verify: 0 });
});

test('preflight cancellation cannot downgrade a concurrent in-flight claim', t => {
  const { store, prepare } = fixture(t);
  const draft = prepare();
  store.claim(draft.key, draft.digest, ['33']);
  assert.equal(store.finishBeforeSend(draft.key, 'stale', { reason: 'changed' }).state, 'dispatching');
  assert.throws(() => store.update(prepare({ moment: { ...baseMoment(), id: '9002' } }).key,
    { state: 'accepted' }), /not attempted/u);
});
