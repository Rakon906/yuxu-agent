import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { createImageRecallService, searchImages, explicitImageRecallRequest, inspectOriginalImage,
  createImageRecallTransport, validateImageSearchRequest } from '../packages/image-recall/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), accountId = 'images-account', groupId = 'images@chatroom';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
function fixture() {
  const base = join(root, '.runtime', 'test-tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'image-recall-')), imageDir = join(dir, 'images'); mkdirSync(imageDir);
  const filename = join(dir, 'capture.sqlite'), capture = new AdapterStore(filename, accountId);
  const store = new AdapterStore(join(dir, 'ledger.sqlite'), accountId), ledger = new ParticipationLedger(store);
  const info = inspectOriginalImage(png), imagePath = join(imageDir, `${info.sha256}.png`); writeFileSync(imagePath, png);
  const now = Date.now(), text = '肥鱼，上次那张火锅图呢，发一下', at = new Date(now).toISOString();
  const request = { accountId, groupId, userId: 'requester', sourceMessageId: 'request1', interaction: 'text', text, eventTime: at, recordedAt: at };
  const original = { accountId, groupId, userId: 'photographer', sourceMessageId: 'image1', serverId: '12345', interaction: 'image',
    text: '[图片]', imageSafety: 'safe', imageSummary: '红油火锅，桌上有蔬菜', imageVisibleText: '', imageTone: '吃饭',
    imageSha256: info.sha256, imagePath, eventTime: '2026-11-12T12:00:00+08:00', recordedAt: at };
  const put = item => capture.db.prepare('INSERT OR REPLACE INTO inbox(id,message) VALUES (?,?)').run(item.sourceMessageId, JSON.stringify(item));
  put(request); put(original);
  const target = { id: 'request1', senderId: 'requester', text, groupId, rowid: 1, at };
  ledger.seed(groupId, 0); ledger.observe(target, 'mention', now);
  const calls = { upload: 0, submit: 0, native: 0, checks: 0, download: 0 };
  const native = { id: 'image1', accountId, threadId: groupId, senderId: 'photographer', serverId: '12345', type: 3, direction: 'incoming' };
  const client = { accountId, message: async () => { calls.native++; return native; } };
  const accepted = { id: 'job1', accountId, threadId: groupId, sourceId: 'upload1', kind: 'send', phase: 'completed', state: 'accepted',
    serverMessageId: '9007199254740993', result: { nativeReceipt: { status: 'server_accepted', serviceCode: 0,
      serverMessageId: '9007199254740993', clientIdMatches: true } } };
  const transport = {
    upload: async bytes => { calls.upload++; assert.deepEqual(bytes, png); return { id: 'upload1', ...info }; },
    submit: async () => { calls.submit++; return accepted; },
    byKey: async () => { calls.checks++; return accepted; },
    status: async () => { calls.checks++; return accepted; },
  };
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId: 'self', sendingEnabled: true, cooldownMs: 10000 });
  const f = { dir, filename, inboxPath: filename, imageDir, store, capture, ledger, info, original, request, target, task: ledger.task(target.id), client, adapter,
    transport, calls, accepted, native, put, groupId, now, key: 'image-outbox-1', authorize: async () => true };
  f.service = createImageRecallService(f);
  const closeStore = store.close.bind(store);
  store.close = () => { f.service.close(); capture.close(); closeStore(); };
  f.search = request => f.service.search({ ...f, request: request ?? { name: 'image_search', query: '火锅' } });
  f.send = async overrides => f.service.send({ ...f, imageId: f.search().images[0]?.imageId, ...overrides });
  return f;
}

test('image search scopes source account/group/member/date and deduplicates bytes with stable IDs without paths', () => {
  const f = fixture();
  try {
    f.put({ ...f.original, sourceMessageId: 'othergroup', groupId: 'foreign@chatroom' });
    f.put({ ...f.original, sourceMessageId: 'otheraccount', accountId: 'foreign-account' });
    f.put({ ...f.original, sourceMessageId: 'repeat' });
    const result = searchImages(f.filename, { accountId, groupId, request: { query: '火锅', senderId: 'photographer', from: '2026-11-12', to: '2026-11-12' } });
    assert.equal(result.images.length, 1); assert.equal(result.ambiguous, false);
    assert.equal(result.images[0].sourceMessageId, 'repeat');
    assert.equal('imagePath' in result.images[0], false); assert.equal('sha256' in result.images[0], false);
    assert.equal(f.search().images[0].imageId, result.images[0].imageId);
    assert.equal(f.search({ query: '火锅', senderId: 'someone-else' }).images.length, 0);
    assert.equal(f.search({ query: '火锅', from: '2026-11-13' }).images.length, 0);
    assert.throws(() => searchImages(f.filename, { accountId: 'wrong', groupId, request: { query: '火锅' } }), /scope/u);
    assert.throws(() => validateImageSearchRequest({ query: '火锅', groupId: 'foreign@chatroom' }), /scope/u);
    assert.throws(() => validateImageSearchRequest({ query: '火锅', from: '2026-02-30' }), /date/u);
  } finally { f.store.close(); }
});

test('original request and unique fresh candidate are required; limit=1 never hides ambiguity', async () => {
  const f = fixture();
  try {
    const next = Buffer.concat([png, Buffer.from('second')]), info = inspectOriginalImage(next), path = join(f.imageDir, `${info.sha256}.png`);
    writeFileSync(path, next); f.put({ ...f.original, sourceMessageId: 'image2', imageSha256: info.sha256, imagePath: path });
    const result = f.search({ query: '火锅', limit: 1 });
    assert.equal(result.images.length, 1); assert.equal(result.ambiguous, true);
    assert.equal((await f.service.send({ ...f, imageId: result.images[0].imageId })).state, 'not_sent');
    assert.throws(() => f.search({ imageId: result.images[0].imageId }), /explicitly/u);
    f.put({ ...f.request, text: '这个图不错', quote: { text: '发一下火锅图' } });
    assert.throws(() => f.search(), /explicit/u);
    assert.equal(f.calls.submit, 0);
    assert.equal(explicitImageRecallRequest('别发那张图'), false);
    assert.equal(explicitImageRecallRequest('生成一张火锅图'), false);
    assert.equal(explicitImageRecallRequest('上次那张火锅图呢'), true);
  } finally { f.store.close(); }
});

test('a same-speaker message burst can request an image after its opening mention; later cancellation wins', async () => {
  for (const cancel of [false, true]) {
    const f = fixture();
    try {
      f.put({ ...f.request, text: '肥鱼' });
      const target2 = { ...f.target, id: 'request2', rowid: 3, text: '把上次那张火锅图发下' };
      f.put({ ...f.request, sourceMessageId: target2.id, text: target2.text });
      f.ledger.observe(target2, 'ordinary', f.now + 1);
      if (cancel) {
        const target3 = { ...target2, id: 'request3', rowid: 4, text: '不要发了' };
        f.put({ ...f.request, sourceMessageId: target3.id, text: target3.text });
        f.ledger.observe(target3, 'ordinary', f.now + 2);
      }
      f.task = f.ledger.task(f.target.id);
      if (cancel) { assert.throws(() => f.search(), /explicit/u); assert.equal(f.calls.submit, 0); }
      else assert.equal((await f.send()).state, 'sent');
    } finally { f.store.close(); }
  }
});

test('explicit requester can select stable image ID and native original is sent once with durable outbox', async () => {
  const f = fixture();
  try {
    const imageId = f.search().images[0].imageId;
    f.put({ ...f.request, text: `请发原图 ${imageId}` });
    f.search({ imageId });
    const sent = await f.service.send({ ...f, imageId });
    assert.equal(sent.state, 'sent'); assert.equal(f.calls.submit, 1); assert.equal(f.calls.native, 2);
    assert.equal(f.ledger.task(f.target.id).state, 'sent');
    assert.equal(f.store.sendRecord(f.key).state, 'accepted');
    assert.equal(JSON.parse(f.store.sendRecord(f.key).receipt).channel, 'image_recall');
    assert.equal((await f.service.send({ ...f, imageId })).state, 'sent');
    assert.equal(f.calls.submit, 1);
    const restarted = createImageRecallService(f);
    assert.equal((await restarted.send({ ...f, imageId })).state, 'sent'); assert.equal(f.calls.upload, 1);
    restarted.close();
  } finally { f.store.close(); }
});

test('unknown dispatch never retries or text-falls-back; read-only receipt lookup can settle it', async () => {
  const f = fixture();
  try {
    f.transport.submit = async () => { f.calls.submit++; throw new Error('response lost'); };
    const result = await f.send();
    assert.equal(result.state, 'needs_review'); assert.equal(result.safeToFallback, false);
    assert.equal(f.ledger.task(f.target.id).state, 'needs_review');
    f.transport.byKey = async () => { f.calls.checks++; throw new Error('still unknown'); };
    assert.equal((await f.send()).state, 'needs_review'); assert.equal(f.calls.submit, 1);
    f.transport.byKey = async () => { f.calls.checks++; return f.accepted; };
    const [settled] = await f.service.reconcile({ groupId });
    assert.equal(settled.state, 'sent'); assert.equal(f.calls.submit, 1);
    assert.equal(f.store.sendRecord(f.key).state, 'accepted');
  } finally { f.store.close(); }
});

test('concurrent calls share one durable claim and cannot dispatch a second image', async () => {
  const f = fixture();
  try {
    const result = f.search(), imageId = result.images[0].imageId;
    const outcomes = await Promise.all([f.service.send({ ...f, imageId }), f.service.send({ ...f, imageId })]);
    assert.equal(f.calls.submit, 1); assert.ok(outcomes.some(x => x.state === 'sent'));
    await assert.rejects(f.service.send({ ...f, imageId, key: 'another-key' }), /conflict/u);
  } finally { f.store.close(); }
});

test('outbox and task are reserved before the network POST and two concurrent tasks obey group cooldown', async () => {
  const f = fixture();
  try {
    const target2 = { ...f.target, id: 'request2', senderId: 'requester-two', rowid: 3 };
    f.put({ ...f.request, sourceMessageId: target2.id, userId: target2.senderId });
    f.ledger.observe(target2, 'mention', f.now + 1);
    const task2 = f.ledger.task(target2.id), imageId = f.search().images[0].imageId;
    f.service.search({ task: task2, target: target2, request: { query: '火锅' } });
    f.transport.submit = async (_group, _upload, key) => {
      f.calls.submit++;
      assert.equal(f.store.sendRecord(key).state, 'needs_review');
      const taskId = f.store.db.prepare('SELECT task_id FROM image_recall_sends WHERE key=?').get(key).task_id;
      assert.equal(f.ledger.task(taskId).state, 'needs_review');
      return f.accepted;
    };
    const results = await Promise.all([f.service.send({ ...f, imageId }),
      f.service.send({ ...f, task: task2, target: target2, imageId, key: 'second-outbox' })]);
    assert.equal(f.calls.submit, 1); assert.equal(results.filter(x => x.state === 'sent').length, 1);
    assert.equal(results.filter(x => x.state === 'not_sent').length, 1);
  } finally { f.store.close(); }
});

test('changed bytes, out-of-root paths, stale searches, cooldown and revoked native source block dispatch', async () => {
  for (const mode of ['bytes', 'outside', 'stale', 'cooldown', 'revoked', 'disabled', 'wrong-sender', 'requester']) {
    const f = fixture();
    try {
      const imageId = f.search().images[0].imageId;
      if (mode === 'bytes') writeFileSync(f.original.imagePath, Buffer.concat([png, Buffer.from('tamper')]));
      if (mode === 'outside') { const path = join(f.dir, 'outside.png'); writeFileSync(path, png); f.put({ ...f.original, imagePath: path }); }
      if (mode === 'stale') f.store.db.prepare('UPDATE image_recall_searches SET created_at=?').run(f.now - 121000);
      if (mode === 'cooldown') { f.store.draft('prior', groupId, '前一条'); f.store.approve('prior'); f.store.claim('prior', 0, Date.now()); }
      if (mode === 'revoked') f.native.recall = true;
      if (mode === 'wrong-sender') f.native.senderId = 'wrong';
      if (mode === 'disabled') f.adapter.sendingEnabled = false;
      if (mode === 'requester') {
        await assert.rejects(f.service.send({ ...f, imageId, target: { ...f.target, senderId: 'wrong' } }), /task/u); continue;
      }
      const result = await f.service.send({ ...f, imageId });
      assert.equal(result.state, 'not_sent', mode); assert.equal(f.calls.submit, 0, mode);
      assert.equal(f.store.sendRecord(f.key), undefined, mode);
    } finally { f.store.close(); }
  }
});

test('source revoked during upload is rechecked; wrong accepted receipt stays unknown', async () => {
  for (const mode of ['revoke', 'receipt']) {
    const f = fixture();
    try {
      if (mode === 'revoke') f.transport.upload = async () => { f.native.recall = true; return { id: 'upload1', ...f.info }; };
      else f.accepted.threadId = 'foreign@chatroom';
      const result = await f.send();
      assert.equal(result.state, mode === 'revoke' ? 'not_sent' : 'needs_review');
      assert.equal(f.calls.submit, mode === 'revoke' ? 0 : 1);
    } finally { f.store.close(); }
  }
});

test('missing file uses same-account native asset download and requires exact previously recorded bytes', async () => {
  for (const mismatch of [false, true]) {
    const f = fixture();
    try {
      unlinkSync(f.original.imagePath);
      f.client.messageMedia = async () => ({ items: [{ id: 'asset1', accountId, messageId: 'image1', kind: 'image', variant: 'normal', state: 'available', ...f.info }] });
      f.client.requestBytes = async (path, options) => {
        assert.equal(path, '/media/asset1/content'); assert.equal(options.limit, 16 * 1024 * 1024); f.calls.download++;
        return { bytes: mismatch ? Buffer.concat([png, Buffer.from('different')]) : png };
      };
      const result = await f.send();
      assert.equal(result.state, mismatch ? 'not_sent' : 'sent'); assert.equal(f.calls.download, 1);
      assert.equal(f.calls.submit, mismatch ? 0 : 1);
    } finally { f.store.close(); }
  }
});

test('cold original download uses a bounded native media transfer and rejects foreign transfer jobs', async () => {
  for (const foreign of [false, true]) {
    const f = fixture();
    try {
      unlinkSync(f.original.imagePath);
      let ready = false, transfers = 0;
      const asset = { id: 'asset1', accountId, messageId: 'image1', kind: 'image', variant: 'original', ...f.info };
      f.client.messageMedia = async () => ({ items: [{ ...asset, state: ready ? 'available' : 'missing' }] });
      f.client.request = async (path, options) => {
        if (options?.method === 'POST') {
          transfers++; assert.equal(path, '/messages/image1/media-transfers');
          assert.deepEqual(options.body, { messageId: 'image1', assetId: 'asset1', quality: 'original' });
          return { id: 'download1', accountId: foreign ? 'foreign' : accountId, threadId: groupId };
        }
        assert.equal(path, '/jobs/download1'); ready = true;
        return { id: 'download1', accountId, threadId: groupId, assetId: 'asset1', state: 'accepted' };
      };
      f.client.requestBytes = async () => ({ bytes: png });
      assert.equal((await f.send()).state, foreign ? 'not_sent' : 'sent');
      assert.equal(transfers, 1); assert.equal(f.calls.submit, foreign ? 0 : 1);
    } finally { f.store.close(); }
  }
});

test('cache junction/symlink escape is rejected even when contents hash matches', async t => {
  const f = fixture();
  try {
    const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'same.png'), png);
    const link = join(f.imageDir, 'link');
    try { symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return t.skip('Symlink unavailable'); throw error; }
    f.put({ ...f.original, imagePath: join(link, 'same.png') });
    assert.equal((await f.send()).state, 'not_sent'); assert.equal(f.calls.submit, 0);
  } finally { f.store.close(); }
});

test('native image transport binds account, hash and byte length and sends image kind with idempotency key', async () => {
  const info = inspectOriginalImage(png), calls = [];
  const client = { accountId, origin: 'http://127.0.0.1:9999', token: 'fixture-token', request: async (...args) => { calls.push(args); return {}; }, sendByKey: async () => ({}) };
  const transport = createImageRecallTransport({ client, fetchImpl: async (url, options) => {
    assert.equal(url, `http://127.0.0.1:9999/v1/accounts/${accountId}/uploads`);
    assert.equal(options.redirect, 'error'); const file = options.body.get('file');
    assert.equal(file.type, 'image/png'); assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
    return new Response(JSON.stringify({ id: 'upload1', ...info }));
  } });
  assert.equal((await transport.upload(png)).sha256, info.sha256);
  await transport.submit(groupId, 'upload1', 'key1');
  assert.deepEqual(calls[0], ['/sends', { method: 'POST', body: { kind: 'image', threadId: groupId, sourceId: 'upload1' }, key: 'key1', signal: undefined }]);
});
