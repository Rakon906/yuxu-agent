import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { draftDigest, MomentsPublishService, MomentsPublishStore } from '../packages/moments/publish-service.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const ACCOUNT = 'account-test';
const SELF = 'wxid-test';
function fixture(t, gateway = {}) {
  const parent = join(root, '.runtime', 'runs'); mkdirSync(parent, { recursive: true });
  const filename = join(mkdtempSync(join(parent, 'moments-publish-')), 'publish.sqlite');
  const store = new MomentsPublishStore(filename);
  t.after(() => store.close());
  const service = new MomentsPublishService({ store, gateway, accountId: ACCOUNT, selfUserId: SELF });
  return { store, service, filename };
}

test('drafts preserve exact Unicode text, immutable client identity and digest across reopening', t => {
  const { store, service, filename } = fixture(t);
  const text = '今天摸鱼 <>&"\'\n天津 🐟';
  const draft = service.draft({ key: 'one', text });
  assert.equal(draft.state, 'draft'); assert.equal(draft.visibility, 'private');
  assert.match(draft.clientId, /^[a-f0-9]{32}$/u);
  assert.equal(draft.digest, draftDigest(draft));
  assert.equal(service.draft({ key: 'one', text }).clientId, draft.clientId);
  const second = new MomentsPublishStore(filename, { readOnly: true });
  try { assert.deepEqual(second.get('one'), store.get('one')); } finally { second.close(); }
  assert.throws(() => service.draft({ key: 'one', text: 'changed' }), /conflict/u);
  assert.throws(() => service.draft({ key: 'one', text, visibility: 'friends' }), /conflict/u);
});

test('invalid text, unsupported media/audience and visibility fail before creating drafts', t => {
  const { service, store } = fixture(t);
  for (const input of [{ text: '' }, { text: ' ' }, { text: '\u0000' }, { text: '\ud800' },
    { text: 'a'.repeat(5001) }, { text: 'ok', visibility: 'public' },
    { text: 'ok', media: [{ path: 'x.png' }] }, { text: 'ok', audience: ['wxid-x'] }]) {
    assert.throws(() => service.draft({ key: 'bad', ...input }));
  }
  assert.equal(store.get('bad'), null);
});

test('missing confirmation and wrong account cannot publish', async t => {
  let calls = 0;
  const { service, store } = fixture(t, { publish: async () => { calls++; }, verify: async () => ({ verified: false }) });
  const draft = service.draft({ key: 'one', text: 'test' });
  await assert.rejects(service.send('one', undefined), /confirm/u);
  await assert.rejects(service.send('one', '0'.repeat(64)), /confirm/u);
  const other = new MomentsPublishService({ store, gateway: service.gateway, accountId: ACCOUNT, selfUserId: 'wxid-other' });
  await assert.rejects(other.send('one', draft.digest), /identity mismatch/u);
  assert.equal(calls, 0); assert.equal(store.get('one').state, 'draft');
});

test('a previously created game-participation draft cannot be dispatched', async t => {
  let calls = 0;
  const { service, store } = fixture(t, { publish: async () => { calls++; }, verify: async () => { calls++; } });
  const draft = service.draft({ key: 'game-boundary', text: '我这就上号打三角洲' });
  await assert.rejects(service.send(draft.key, draft.digest), /Game participation/u);
  assert.equal(store.get(draft.key).state, 'draft');
  assert.equal(store.get(draft.key).attemptedAt, null);
  assert.equal(calls, 0);
});

test('server acceptance requires independent verification; replay never posts again', async t => {
  let posts = 0; let checks = 0;
  const { service, store } = fixture(t, {
    publish: async draft => { posts++; assert.equal(store.get(draft.key).state, 'dispatching'); return { state: 'accepted', momentId: '123', baseCode: 0 }; },
    verify: async draft => { checks++; assert.equal(draft.momentId, '123'); return { verified: true, momentId: '123' }; },
  });
  const draft = service.draft({ key: 'one', text: 'test', visibility: 'friends' });
  assert.equal((await service.send('one', draft.digest)).state, 'verified');
  assert.equal((await service.send('one', draft.digest)).state, 'verified');
  assert.equal(posts, 1); assert.equal(checks, 1);
});

test('unverified receipt stays needs_review with its identity and later status verifies without repost', async t => {
  let posts = 0; let proven = false;
  const { service } = fixture(t, {
    publish: async () => { posts++; return { state: 'accepted', momentId: '123', baseCode: 0 }; },
    verify: async () => ({ verified: proven, momentId: '123' }),
  });
  const draft = service.draft({ key: 'one', text: 'test' });
  const first = await service.send('one', draft.digest);
  assert.equal(first.state, 'needs_review'); assert.equal(first.clientId, draft.clientId);
  assert.equal(first.receipt.baseCode, 0); assert.equal(first.momentId, '123');
  proven = true;
  assert.equal((await service.status('one')).state, 'verified'); assert.equal(posts, 1);
});

test('network loss after an attempted post survives reopening and never replays', async t => {
  let posts = 0;
  const gateway = { publish: async () => { posts++; throw new Error('connection lost'); },
    verify: async () => ({ verified: false, reason: 'not_found' }) };
  const { service, filename } = fixture(t, gateway);
  const draft = service.draft({ key: 'one', text: 'test' });
  assert.equal((await service.send('one', draft.digest)).state, 'needs_review');
  const reopened = new MomentsPublishStore(filename);
  try {
    const next = new MomentsPublishService({ store: reopened, gateway, accountId: ACCOUNT, selfUserId: SELF });
    assert.equal((await next.send('one', draft.digest)).state, 'needs_review');
    assert.equal(next.get('one').clientId, draft.clientId);
    assert.equal(next.get('one').receipt.errorName, 'Error');
    assert.equal(posts, 1);
  } finally { reopened.close(); }
});

test('a crash after claim and two concurrent clients still permit at most one submission', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; }); let posts = 0;
  const gateway = { publish: async () => { posts++; await gate; return { state: 'accepted', momentId: '123' }; },
    verify: async () => ({ verified: false }) };
  const { service, filename, store } = fixture(t, gateway);
  const draft = service.draft({ key: 'one', text: 'test' });
  const secondStore = new MomentsPublishStore(filename);
  try {
    const second = new MomentsPublishService({ store: secondStore, gateway, accountId: ACCOUNT, selfUserId: SELF });
    const firstSend = service.send('one', draft.digest);
    await second.send('one', draft.digest);
    release(); await firstSend; assert.equal(posts, 1);
    const crash = service.draft({ key: 'crash', text: 'crash test' });
    store.claim('crash', crash.digest);
    secondStore.now = () => Date.now() + 5 * 60 * 1000;
    await second.send('crash', crash.digest);
    assert.equal(posts, 1); assert.equal(second.get('crash').state, 'needs_review');
  } finally { release(); secondStore.close(); }
});

test('explicit rejection and malformed verification cannot become verified', async t => {
  let checks = 0;
  const { service } = fixture(t, { publish: async () => ({ state: 'rejected', baseCode: -1 }),
    verify: async () => { checks++; return { verified: true, momentId: '123' }; } });
  const one = service.draft({ key: 'one', text: 'test' });
  assert.equal((await service.send(one.key, one.digest)).state, 'rejected');
  assert.equal((await service.status(one.key)).state, 'rejected'); assert.equal(checks, 0);
  service.gateway = { publish: async () => ({ state: 'accepted', momentId: '123' }),
    verify: async () => ({ verified: true, momentId: '456' }) };
  const two = service.draft({ key: 'two', text: 'test' });
  assert.equal((await service.send(two.key, two.digest)).state, 'needs_review');
  assert.equal(service.get('two').momentId, '123');
  service.gateway.verify = async () => ({ verified: true });
  assert.equal((await service.status(two.key)).state, 'needs_review');
});

test('tampered draft fails integrity checking before network or claim', async t => {
  let posts = 0;
  const { service, store } = fixture(t, { publish: async () => { posts++; }, verify: async () => ({ verified: false }) });
  const draft = service.draft({ key: 'one', text: 'test' });
  store.db.prepare('UPDATE publications SET draft_json=? WHERE key=?').run(JSON.stringify({ ...draft, text: 'tampered' }), 'one');
  await assert.rejects(service.send('one', draft.digest), /integrity/u); assert.equal(posts, 0);
});

test('CLI draft, show and unattempted status remain entirely offline', t => {
  const { filename } = fixture(t);
  const cli = join(root, 'scripts', 'moments-publish.mjs');
  const run = args => JSON.parse(execFileSync(process.execPath, [cli, ...args, '--db', filename], {
    encoding: 'utf8', env: { ...process.env, SOCIOMEM_WECHAT_CLI: 'does-not-exist.exe',
      SOCIOMEM_WECHAT_TOKEN_FILE: 'does-not-exist-secret', SOCIOMEM_WECHAT_BASE_URL: 'http://127.0.0.1:1' },
  }));
  const draft = run(['draft', '--key', 'cli', '--account', ACCOUNT, '--self-id', SELF, '--text', '离线草稿 🐟']);
  assert.equal(draft.state, 'draft');
  assert.equal(run(['show', '--key', 'cli']).digest, draft.digest);
  assert.equal(run(['status', '--key', 'cli']).state, 'draft');
});

test('a crash after raw response persistence recovers only an ID, then verifies without posting', async t => {
  let posts = 0; let checks = 0;
  const { service, store } = fixture(t, {
    publish: async () => { posts++; },
    recoverReceipt: (_draft, responses) => {
      assert.equal(responses.length, 1); return { momentId: '123' };
    },
    verify: async draft => { checks++; assert.equal(draft.momentId, '123'); return { verified: true, momentId: '123' }; },
  });
  const draft = service.draft({ key: 'crash-response', text: 'test' });
  store.claim(draft.key, draft.digest);
  store.recordResponse(draft.key, { accountId: ACCOUNT, phase: 'publish', httpStatus: 200,
    responseBody: '{"receipt":"saved before crash"}', receivedAt: new Date().toISOString() });
  const result = await service.status(draft.key);
  assert.equal(result.state, 'verified');
  assert.equal(posts, 0); assert.equal(checks, 1);
});

test('raw response is committed before parsing fails and survives restart without reposting', async t => {
  const body = '{"baseCode":0,"replyHex":"unexpected-layout"}\n';
  const receivedAt = '2026-11-11T08:50:00.000Z';
  let posts = 0;
  const gateway = {
    publish: async (_draft, { onResponse }) => {
      posts++;
      await onResponse({ phase: 'publish', httpStatus: 200, responseBody: body, receivedAt,
        request: 'not stored', token: 'not stored', accountId: 'untrusted-must-be-overridden' });
      throw new SyntaxError('unexpected response layout');
    },
    verify: async (_draft, { onResponse }) => {
      await onResponse({ phase: 'detail', httpStatus: 502, responseBody: 'bad gateway\n', receivedAt });
      return { verified: false };
    },
  };
  const { service, store, filename } = fixture(t, gateway);
  const draft = service.draft({ key: 'raw', text: 'test' });
  assert.equal((await service.send('raw', draft.digest)).state, 'needs_review');
  const response = store.responses('raw')[0];
  assert.equal(response.body, body);
  assert.equal(response.sha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(response.http_status, 200);
  assert.equal(response.received_at, receivedAt);
  assert.deepEqual(Object.keys(response).sort(), ['body', 'http_status', 'id', 'key', 'phase', 'received_at', 'sha256']);
  const reopened = new MomentsPublishStore(filename);
  try {
    const resumed = new MomentsPublishService({ store: reopened, gateway, accountId: ACCOUNT, selfUserId: SELF });
    assert.deepEqual(reopened.responses('raw'), store.responses('raw'));
    await resumed.send('raw', draft.digest);
    assert.equal(posts, 1);
    assert.deepEqual(reopened.responses('raw').map(row => [row.phase, row.body]),
      [['publish', body], ['detail', 'bad gateway\n']]);
  } finally { reopened.close(); }
});

test('response recording rejects unknown drafts, unattempted drafts and wrong accounts', t => {
  const { service, store } = fixture(t);
  const response = { phase: 'publish', httpStatus: 200, responseBody: '{}',
    receivedAt: '2026-11-11T08:50:00.000Z', accountId: ACCOUNT };
  assert.throws(() => store.recordResponse('missing', response), /not been attempted/u);
  assert.throws(() => store.responses('missing'), /Unknown/u);
  const draft = service.draft({ key: 'one', text: 'test' });
  assert.throws(() => store.recordResponse('one', response), /not been attempted/u);
  store.claim('one', draft.digest);
  assert.throws(() => store.recordResponse('one', { ...response, accountId: 'other' }), /identity mismatch/u);
  assert.throws(() => store.recordResponse('one', { ...response, accountId: undefined }), /account ID/u);
  assert.equal(store.responses('one').length, 0);
  assert.equal(store.recordResponse('one', response).body, '{}');
});

test('response storage uses the byte limit and rejects invalid metadata without modifying state', t => {
  const { service, store } = fixture(t);
  const draft = service.draft({ key: 'one', text: 'test' });
  store.claim('one', draft.digest);
  const response = { phase: 'publish', httpStatus: 200, responseBody: '{}',
    receivedAt: '2026-11-11T08:50:00.000Z', accountId: ACCOUNT };
  const limit = 8 * 1024 * 1024 + 4096;
  for (const delta of [{ responseBody: 'x'.repeat(limit + 1) },
    { responseBody: '中'.repeat(Math.floor(limit / 3) + 1) },
    { responseBody: '\ud800' }, { httpStatus: 99 }, { httpStatus: 600 },
    { httpStatus: 200.5 }, { phase: 'send' }, { receivedAt: 'not-a-date' }]) {
    assert.throws(() => store.recordResponse('one', { ...response, ...delta }), /Invalid or oversized/u);
  }
  assert.equal(store.get('one').state, 'dispatching');
  assert.equal(store.responses('one').length, 0);
  const exact = store.recordResponse('one', { ...response, responseBody: 'x'.repeat(limit) });
  assert.equal(Buffer.byteLength(exact.body), limit);
});

test('opening an older ledger adds response storage while preserving its drafts', t => {
  const { service, store, filename } = fixture(t);
  const draft = service.draft({ key: 'old', text: 'unchanged' });
  // An isolated fixture with the old publications table and no response table.
  store.db.exec('DROP TABLE publication_responses');
  const readOnly = new MomentsPublishStore(filename, { readOnly: true });
  try { assert.deepEqual(readOnly.responses('old'), []); } finally { readOnly.close(); }
  const upgraded = new MomentsPublishStore(filename);
  try {
    assert.deepEqual(upgraded.get('old'), draft);
    const names = upgraded.db.prepare('PRAGMA table_info(publication_responses)').all().map(column => column.name);
    assert.ok(names.includes('body'));
    assert.deepEqual(upgraded.responses('old'), []);
    assert.equal(upgraded.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  } finally { upgraded.close(); }
});

const imageAsset = () => ({ kind: 'image', path: join(root, '.runtime', 'moments', 'assets', `${'a'.repeat(64)}.jpg`),
  sha256: 'a'.repeat(64), md5: 'b'.repeat(32), width: 64, height: 48, bytes: 1234, mimeType: 'image/jpeg' });
const uploadedImage = asset => ({ sha256: asset.sha256, md5: asset.md5, width: asset.width,
  height: asset.height, bytes: asset.bytes, url: 'https://mmsns.qpic.cn/mmsns/test-image/0', urlType: 1,
  thumbUrl: 'https://mmsns.qpic.cn/mmsns/test-image/150', thumbType: 1 });

test('image draft digest binds the staged image; empty media preserves text draft compatibility', t => {
  const { service } = fixture(t);
  const plain = service.draft({ key: 'plain', text: 'unchanged' });
  assert.equal(draftDigest({ ...plain, media: [] }), plain.digest);
  const media = [imageAsset()];
  const draft = service.draft({ key: 'image', text: 'picture', media });
  assert.equal(draft.media[0].sha256, media[0].sha256);
  assert.notEqual(draftDigest({ ...draft, media: [] }), draft.digest);
  assert.throws(() => service.draft({ key: 'image', text: 'picture', media: [] }), /conflict/u);
  assert.throws(() => service.draft({ key: 'too-many', text: 'picture', media: [media[0], media[0]] }), /one image/u);
});

test('image receipt is stored before publishing and survives restart without repeating upload or post', async t => {
  const calls = [];
  const { service, store, filename } = fixture(t, {
    uploadImage: async (asset, { onResponse }) => {
      calls.push('upload');
      await onResponse({ phase: 'upload', httpStatus: 200, responseBody: '{"uploaded":true}', receivedAt: new Date().toISOString() });
      return uploadedImage(asset);
    },
    publish: async draft => {
      calls.push('publish');
      assert.deepEqual(draft.uploadedMedia, [uploadedImage(draft.media[0])]);
      assert.deepEqual(store.get(draft.key).uploadedMedia, draft.uploadedMedia);
      return { state: 'accepted', momentId: '555', baseCode: 0 };
    },
    verify: async draft => { calls.push('verify'); return { verified: true, momentId: draft.momentId }; },
  });
  const draft = service.draft({ key: 'image', text: 'picture', media: [imageAsset()] });
  assert.equal((await service.send(draft.key, draft.digest)).state, 'verified');
  const reopened = new MomentsPublishStore(filename);
  try {
    const resumed = new MomentsPublishService({ store: reopened, gateway: service.gateway, accountId: ACCOUNT, selfUserId: SELF });
    assert.equal((await resumed.send(draft.key, draft.digest)).state, 'verified');
    assert.equal(reopened.db.prepare('SELECT count(*) AS n FROM publication_upload_responses').get().n, 1);
  } finally { reopened.close(); }
  assert.deepEqual(calls, ['upload', 'publish', 'verify']);
});

test('unknown or mismatched upload never publishes and never retries after reopening', async t => {
  let uploads = 0; let posts = 0;
  const { service, store, filename } = fixture(t, {
    uploadImage: async asset => { uploads++; return { ...uploadedImage(asset), sha256: 'c'.repeat(64) }; },
    publish: async () => { posts++; },
    verify: async () => ({ verified: false, reason: 'missing_receipt_id' }),
  });
  const draft = service.draft({ key: 'bad-upload', text: 'picture', media: [imageAsset()] });
  assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  assert.equal(store.get(draft.key).receipt.phase, 'upload');
  const reopened = new MomentsPublishStore(filename);
  try {
    const resumed = new MomentsPublishService({ store: reopened, gateway: service.gateway, accountId: ACCOUNT, selfUserId: SELF });
    await resumed.send(draft.key, draft.digest);
  } finally { reopened.close(); }
  assert.equal(uploads, 1); assert.equal(posts, 0);
});

test('unparseable upload response is preserved separately and is never a publishing receipt', async t => {
  const { service, store } = fixture(t, {
    uploadImage: async (_asset, { onResponse }) => {
      await onResponse({ phase: 'upload', httpStatus: 200, responseBody: 'unexpected', receivedAt: new Date().toISOString() });
      throw new SyntaxError('bad upload response');
    },
    publish: async () => { assert.fail('Must not post after failed upload'); },
    verify: async () => ({ verified: false }),
  });
  const draft = service.draft({ key: 'raw-upload', text: 'picture', media: [imageAsset()] });
  assert.equal((await service.send(draft.key, draft.digest)).state, 'needs_review');
  assert.deepEqual(store.responses(draft.key), []);
  const raw = store.db.prepare('SELECT body,sha256 FROM publication_upload_responses WHERE key=?').get(draft.key);
  assert.equal(raw.body, 'unexpected');
  assert.equal(raw.sha256, createHash('sha256').update(raw.body).digest('hex'));
});

test('concurrent status and send cannot interrupt the claimed image upload', async t => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  let uploads = 0; let posts = 0;
  const { service, store, filename } = fixture(t, {
    uploadImage: async asset => { uploads++; await gate; return uploadedImage(asset); },
    publish: async () => { posts++; return { state: 'accepted', momentId: '555', baseCode: 0 }; },
    verify: async draft => ({ verified: Boolean(draft.momentId), momentId: draft.momentId }),
  });
  const draft = service.draft({ key: 'concurrent-image', text: 'picture', media: [imageAsset()] });
  const secondStore = new MomentsPublishStore(filename);
  try {
    const second = new MomentsPublishService({ store: secondStore, gateway: service.gateway, accountId: ACCOUNT, selfUserId: SELF });
    const pending = service.send(draft.key, draft.digest);
    assert.equal((await second.status(draft.key)).state, 'dispatching');
    assert.equal((await second.send(draft.key, draft.digest)).state, 'dispatching');
    // Even a status check after the grace period cannot prevent the one owner
    // from finishing its upload; it never grants a second publishing claim.
    secondStore.now = () => Date.now() + 6 * 60 * 1000;
    assert.equal((await second.status(draft.key)).state, 'needs_review');
    release();
    assert.equal((await pending).state, 'verified');
    assert.equal(store.get(draft.key).state, 'verified');
    assert.equal(uploads, 1); assert.equal(posts, 1);
  } finally { release(); secondStore.close(); }
});
