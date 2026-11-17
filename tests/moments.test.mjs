import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { MomentsHttpClient } from '../packages/moments/client.mjs';
import { MomentsStore } from '../packages/moments/store.mjs';
import { MomentsService } from '../packages/moments/index.mjs';
import { prepareRun } from '../scripts/runtime.mjs';

const ACCOUNT = 'account-moments-test';
const TOKEN = 'moments-token';

async function fixture(t) {
  const run = await prepareRun('moments-test');
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, auth: req.headers.authorization, body: await readBody(req) });
    res.setHeader('content-type', 'application/json');
    if (url.pathname.endsWith('/capabilities')) return send(res, { read: true, publish: true });
    if (req.method === 'GET' && url.pathname.endsWith(`/accounts/${ACCOUNT}/moments`)) {
      return send(res, { items: [{ id: 'moment-1', authorId: 'wxid-alice', authorName: 'Alice', createdAt: '2026-11-04T10:00:00Z', text: '今天下雨', media: [] }], nextCursor: 'next-1' });
    }
    if (req.method === 'GET' && url.pathname.endsWith(`/accounts/${ACCOUNT}/moments/moment-1`)) {
      return send(res, { id: 'moment-1', author: { id: 'wxid-alice', name: 'Alice' }, createdAt: '2026-11-04T10:00:00Z', content: '今天下雨', media: [] });
    }
    if (req.method === 'POST' && url.pathname.endsWith(`/accounts/${ACCOUNT}/moments`)) {
      return send(res, { id: 'operation-1', accountId: ACCOUNT, state: 'queued', momentId: 'moment-new' });
    }
    if (req.method === 'GET' && url.pathname.endsWith(`/accounts/${ACCOUNT}/moments/operation-1/publish`)) {
      return send(res, { id: 'operation-1', accountId: ACCOUNT, state: 'accepted', momentId: 'moment-new' });
    }
    res.statusCode = 404;
    send(res, { error: { code: 'not_found' } });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const client = new MomentsHttpClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: TOKEN, accountId: ACCOUNT, timeoutMs: 1000 });
  const store = new MomentsStore(join(run.runRoot, 'moments.sqlite'), ACCOUNT);
  const service = new MomentsService({ gateway: client, store, accountId: ACCOUNT, publishingEnabled: true, cooldownMs: 0 });
  t.after(() => { store.close(); server.close(); });
  return { client, store, service, requests };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : null;
}

function send(res, body) {
  res.end(JSON.stringify(body));
}

test('timeline is normalized and cached with stable author identity', async t => {
  const f = await fixture(t);
  const result = await f.service.timeline({ limit: 5, usernames: ['wxid-alice'] });
  assert.equal(result.items[0].id, 'moment-1');
  assert.equal(result.items[0].author.id, 'wxid-alice');
  assert.equal(result.nextCursor, 'next-1');
  assert.equal(f.store.moment('moment-1').text, '今天下雨');
  assert.ok(f.store.cachedTimeline(result.cacheKey));
  assert.equal(f.requests[0].auth, `Bearer ${TOKEN}`);
});

test('publish uses an approved idempotent outbox and accepts a remote receipt', async t => {
  const f = await fixture(t);
  const draft = f.service.draftPublish({ key: 'moment-test-1', text: '本公主今天也在摸鱼', visibility: 'private' });
  assert.equal(draft.state, 'draft');
  assert.throws(() => f.service.draftPublish({ key: 'moment-test-1', text: '内容冲突' }), /content conflict/u);
  f.service.approvePublish('moment-test-1');
  const receipt = await f.service.publishApproved('moment-test-1');
  assert.equal(receipt.state, 'queued');
  assert.equal(JSON.parse(receipt.receipt_json).momentId, 'moment-new');
  const reconciled = await f.service.reconcile('moment-test-1');
  assert.equal(reconciled.state, 'accepted');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
  await f.service.publishApproved('moment-test-1');
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 1);
});

test('publishing is blocked until explicitly enabled', async t => {
  const f = await fixture(t);
  const readOnly = new MomentsService({ gateway: f.client, store: f.store, accountId: ACCOUNT, cooldownMs: 0 });
  readOnly.draftPublish({ key: 'read-only-draft', text: '不会自动发送' });
  readOnly.approvePublish('read-only-draft');
  await assert.rejects(readOnly.publishApproved('read-only-draft'), /publishing is disabled/u);
});

test('account mismatch in a remote receipt is rejected', async t => {
  const f = await fixture(t);
  f.service.draftPublish({ key: 'moment-test-2', text: '测试' });
  f.service.approvePublish('moment-test-2');
  await assert.rejects(async () => f.service.acceptReceipt('moment-test-2', { id: 'op-bad', accountId: 'other', state: 'accepted' }), /account mismatch/u);
});
