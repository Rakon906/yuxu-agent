import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { AdapterStore, improvesInboxMessage } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { createHarnessDraftHandler } from '../packages/wechat-adapter/harness-bridge.mjs';
import { capturePending } from '../packages/wechat-adapter/capture.mjs';
import { prepareRun, createRuntime } from '../scripts/runtime.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN, message, event } from './fixtures/wechat-server.mjs';

async function fixture(t, options = {}) {
  const run = await prepareRun('wechat-test');
  const server = await startWeChatFixture();
  const filename = join(run.runRoot, 'adapter.sqlite');
  const client = new WeChatClient({ baseUrl: server.origin, accountId: ACCOUNT, token: TOKEN, timeoutMs: 1000 });
  const store = new AdapterStore(filename, ACCOUNT);
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [GROUP], selfUserId: SELF, cooldownMs: 0, ...options });
  let currentStore = store;
  t.after(async () => { currentStore.close(); await server.close(); });
  return { run, server, client, store, adapter, reopen() {
    currentStore.close(); currentStore = new AdapterStore(filename, ACCOUNT);
    return new WeChatAdapter({ client, store: currentStore, allowedGroups: [GROUP], selfUserId: SELF, cooldownMs: 0, ...options });
  } };
}

test('SSE replay deduplicates messages durably; account/group/member IDs stay distinct', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('m1', message('m1'));
  f.server.state.events = [event(1, 'm1'), event(2, 'm1')];
  await f.adapter.syncOnce();
  const pending = f.store.pending(); assert.equal(pending.length, 1);
  assert.equal(pending[0].message.userId, 'wxid_synthetic_alice');
  assert.equal(pending[0].message.groupId, GROUP);
  assert.equal(pending[0].message.serverId, '18446744073709551615');
  assert.deepEqual(pending[0].message.mentions, { state: 'known', self: false, userIds: [] });
  const again = f.reopen();
  await again.syncOnce();
  assert.equal(again.store.pending().length, 1);
  assert.equal(f.server.state.connections.at(-1), '2');
  let delivered = 0; await again.drain(async () => delivered++); await again.drain(async () => delivered++);
  assert.equal(delivered, 1);
});

test('quoted replies keep the quoted sender and text', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('quote-1', message('quote-1', { type: 49, body: '你先举个不同的例子',
    quote: { serverId: '9001', type: 1, state: 'embedded', senderId: 'wxid_synthetic_bob',
      embeddedText: '前面那辆车一直停着不走' } }));
  await f.adapter.ingest(event(1, 'quote-1'));
  const captured = f.store.pending()[0].message;
  assert.equal(captured.text, '你先举个不同的例子');
  assert.equal(captured.quote.text, '前面那辆车一直停着不走');
  assert.equal(captured.quote.senderId, 'wxid_synthetic_bob');
  assert.equal(captured.quote.type, 1);
});

test('type 49 app messages without a quote stay out of the inbox', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('file-1', message('file-1', { type: 49, body: 'file', quote: null }));
  await f.adapter.ingest(event(1, 'file-1'));
  assert.equal(f.store.pending().length, 0);
});

test('structured @self metadata survives ingestion for participation decisions', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('ping', message('ping', {
    body: '我叫一下你', mentions: { state: 'known', self: true, all: false,
      userIds: [SELF], source: 'native' },
  }));
  await f.adapter.ingest(event(1, 'ping'));
  assert.equal(f.store.pending()[0].message.mentions.self, true);
  assert.deepEqual(f.store.pending()[0].message.mentions.userIds, [SELF]);
});

test('an explicit incoming pat directed at the agent becomes a mandatory interaction', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('pat-1', message('pat-1', { type: 10000,
    body: '示例成员19拍了拍我', mentions: null }));
  await f.adapter.ingest(event(1, 'pat-1'));
  const captured = f.store.pending()[0].message;
  assert.equal(captured.interaction, 'pat');
  assert.equal(captured.mentions.self, true);
  assert.equal(captured.text, '拍了拍肥鱼');
});

test('incoming image messages are enriched before entering the inbox', async t => {
  const f = await fixture(t, { enrichImage: async item => ({ ...item,
    text: '[群友发送图片；以下是看图描述，不是群友原话] 一张作业截图',
    interaction: 'image', imageSummary: '一张作业截图' }) });
  f.server.state.messages.set('img', message('img', { type: 3, body: null,
    media: [{ id: 'asset_1', kind: 'image' }] }));
  await f.adapter.ingest(event(1, 'img'));
  const captured = f.store.pending()[0].message;
  assert.equal(captured.interaction, 'image');
  assert.equal(captured.text, '[群友发送图片；以下是看图描述，不是群友原话] 一张作业截图');
  assert.equal(captured.imageSummary, '一张作业截图');
  assert.equal(captured.media[0].id, 'asset_1');
});

test('incoming images without a vision enricher keep a visible placeholder', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('img', message('img', { type: 3, body: null }));
  await f.adapter.ingest(event(1, 'img'));
  const captured = f.store.pending()[0].message;
  assert.equal(captured.interaction, 'image');
  assert.equal(captured.text, '[群友发送图片]');
});

test('disconnect reconnects after the durable cursor and recovers subsequent events', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('m1', message('m1')); f.server.state.messages.set('m2', message('m2'));
  f.server.state.events = [event(1, 'm1'), event(2, 'm2')]; f.server.state.firstStreamLimit = 1;
  await f.adapter.watch(undefined, { reconnectMs: 1, maxReconnects: 1 });
  assert.deepEqual(f.server.state.connections, ['0', '1']);
  assert.equal(f.store.pending().length, 2);
});

test('commit precedes ack; ack failure and restart do not duplicate or lose the inbox', async t => {
  const f = await fixture(t); f.server.state.messages.set('m1', message('m1'));
  f.server.state.ackFailures = 1;
  await assert.rejects(f.adapter.ingest(event(1, 'm1')));
  assert.equal(f.store.cursor(), '1'); assert.equal(f.store.pending().length, 1);
  const resumed = f.reopen(); await resumed.syncOnce();
  assert.equal(resumed.store.pending().length, 1); assert.ok(f.server.state.acks.includes('1'));
});

test('one database has one owner; concurrent ingestion preserves commit ordering', async t => {
  const f = await fixture(t);
  assert.throws(() => new AdapterStore(join(f.run.runRoot, 'adapter.sqlite'), ACCOUNT), /EEXIST/);
  f.server.state.messages.set('a', message('a')); f.server.state.messages.set('b', message('b'));
  const read = f.client.message.bind(f.client);
  f.client.message = async (...args) => { if (args[0] === 'a') await new Promise(resolve => setTimeout(resolve, 15)); return read(...args); };
  await Promise.all([f.adapter.ingest(event(1, 'a')), f.adapter.ingest(event(2, 'b'))]);
  assert.equal(f.store.cursor(), '2'); assert.equal(f.store.pending().length, 2);
});

test('failed downstream handling leaves durable work pending for an idempotent retry', async t => {
  const f = await fixture(t); f.server.state.messages.set('m', message('m'));
  await f.adapter.ingest(event(1, 'm'));
  await assert.rejects(f.adapter.drain(async () => { throw new Error('synthetic consumer interruption'); }));
  assert.equal(f.store.pending().length, 1);
  await f.adapter.drain(async () => {});
  assert.equal(f.store.pending().length, 0);
});

test('capture-only delivers authorized text into Inbox without a model draft or send', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('capture', message('capture'));
  await f.adapter.ingest(event(1, 'capture'));
  const seen = [];
  await capturePending(f.adapter, [GROUP], item => seen.push(item.sourceMessageId));
  await capturePending(f.adapter, [GROUP], () => assert.fail('already captured'));
  assert.deepEqual(seen, ['capture']);
  assert.equal(f.store.pending().length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM inbox').get().n, 1);
  assert.equal(f.store.drafts().length, 0);
  assert.equal(f.server.state.posts, 0);
});

test('capture-only leaves a now unauthorized pending message untouched', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('capture', message('capture'));
  await f.adapter.ingest(event(1, 'capture'));
  await assert.rejects(capturePending(f.adapter, ['other@chatroom']), /outside the allowlist/);
  assert.equal(f.store.pending().length, 1);
});

test('unauthorized groups, self messages, history imports and recalled text never reach the inbox', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('self', message('self', { senderId: SELF }));
  f.server.state.messages.set('recall', message('recall', { recall: { observedAt: new Date().toISOString() } }));
  await f.adapter.ingest(event(1, 'private', { threadId: 'private-peer' }));
  await f.adapter.ingest(event(2, 'history', { origin: 'profile_import' }));
  await f.adapter.ingest(event(3, 'self'));
  await f.adapter.ingest(event(4, 'recall'));
  assert.equal(f.store.pending().length, 0);
  assert.deepEqual(f.server.state.gets, ['self', 'recall']);
});

test('mismatched identities and numeric IDs fail without advancing the cursor', async t => {
  const f = await fixture(t);
  f.server.state.messages.set('m', message('m', { accountId: 'other-account' }));
  await assert.rejects(f.adapter.ingest(event(1, 'm')), /identity/);
  f.server.state.messages.set('m', message('m', { serverId: 9007199254740992 }));
  await assert.rejects(f.adapter.ingest(event(1, 'm')), /string/);
  assert.equal(f.store.cursor(), '0');
});

test('expired event cursor and authentication errors stop instead of resetting history', async t => {
  const f = await fixture(t); f.server.state.streamError = 'event_cursor_expired';
  await assert.rejects(f.adapter.watch(undefined, { maxReconnects: 1 }), /event_cursor_expired/);
  assert.equal(f.store.cursor(), '0'); assert.equal(f.server.state.connections.length, 1);
  const bad = new WeChatClient({ baseUrl: f.server.origin, accountId: ACCOUNT, token: 'wrong-token' });
  await assert.rejects(bad.message('m'), /401/);
});

test('default sending is blocked; explicit approval is required even with sending enabled', async t => {
  const f = await fixture(t);
  f.adapter.propose({ key: 'draft-1', groupId: GROUP, text: 'synthetic draft' });
  await assert.rejects(f.adapter.sendApproved('draft-1'), /disabled/);
  f.adapter.sendingEnabled = true;
  await assert.rejects(f.adapter.sendApproved('draft-1'), /approved draft/);
  assert.equal(f.server.state.posts, 0);
  assert.throws(() => f.adapter.propose({ key: 'draft-1', groupId: GROUP, text: 'different body' }), /conflict/);
});

test('uncertain accepted send is looked up by its original key and never posted twice', async t => {
  const f = await fixture(t, { sendingEnabled: true });
  f.server.state.sendMode = 'drop-after-accept';
  f.adapter.propose({ key: 'same-key', groupId: GROUP, text: 'synthetic send' }); f.store.approve('same-key');
  assert.equal((await f.adapter.sendApproved('same-key')).state, 'accepted');
  const resumed = f.reopen();
  assert.equal((await resumed.sendApproved('same-key')).state, 'accepted');
  assert.equal(f.server.state.posts, 1);
});

test('a verified group mention is persisted with its draft and sent structurally', async t => {
  const f = await fixture(t, { sendingEnabled: true });
  f.adapter.propose({ key: 'mention-1', groupId: GROUP, text: '叫你呢',
    mentionUserIds: ['wxid_synthetic_alice'] });
  assert.equal(f.store.sendRecord('mention-1').mentions_json, '["wxid_synthetic_alice"]');
  f.store.approve('mention-1');
  assert.equal((await f.adapter.sendApproved('mention-1')).state, 'accepted');
  assert.deepEqual(f.server.state.lastSendInput.mentions, { userIds: ['wxid_synthetic_alice'] });
});

test('unresolved send stays needs_review across restart and is not automatically resubmitted', async t => {
  const f = await fixture(t, { sendingEnabled: true }); f.server.state.sendMode = 'unknown-missing';
  f.adapter.propose({ key: 'unknown-key', groupId: GROUP, text: 'synthetic send' }); f.store.approve('unknown-key');
  assert.equal((await f.adapter.sendApproved('unknown-key')).state, 'needs_review');
  const resumed = f.reopen();
  assert.equal((await resumed.sendApproved('unknown-key')).state, 'needs_review');
  assert.equal(f.server.state.posts, 1);
});

test('group cooldown is enforced by durable outbox before POST', async t => {
  const f = await fixture(t, { sendingEnabled: true, cooldownMs: 60000 });
  for (const key of ['a', 'b']) { f.adapter.propose({ key, groupId: GROUP, text: key }); f.store.approve(key); }
  await f.adapter.sendApproved('a');
  await assert.rejects(f.adapter.sendApproved('b'), /rate limit/);
  assert.equal(f.server.state.posts, 1);
});

test('queued send receipt is polled, and native needs_review is never resubmitted', async t => {
  const f = await fixture(t, { sendingEnabled: true });
  f.adapter.propose({ key: 'queued', groupId: GROUP, text: 'synthetic' }); f.store.approve('queued');
  await f.adapter.sendApproved('queued');
  const receipt = f.server.state.receipts.get('queued');
  f.store.receipt('queued', 'queued', { ...receipt, state: 'queued' });
  assert.equal((await f.adapter.reconcile('queued')).state, 'accepted');
  f.server.state.sendMode = 'needs_review';
  f.adapter.propose({ key: 'review', groupId: GROUP, text: 'synthetic' }); f.store.approve('review');
  assert.equal((await f.adapter.sendApproved('review')).state, 'needs_review');
  assert.equal((await f.adapter.sendApproved('review')).state, 'needs_review');
  assert.equal(f.server.state.posts, 2);
});

test('normalized WeChat event reaches real Harness and creates only one durable reply draft', { timeout: 90000 }, async t => {
  const f = await fixture(t);
  f.server.state.messages.set('bridge', message('bridge'));
  await f.adapter.ingest(event(1, 'bridge'));
  const runtime = createRuntime(f.run, { groupId: GROUP });
  try {
    const handle = createHarnessDraftHandler({ runtime, adapter: f.adapter, groupId: GROUP });
    const normalized = f.store.pending()[0].message;
    await f.adapter.drain(handle);
    const duplicate = await handle(normalized);
    assert.match(duplicate.text, /CONTEXT_OK/);
    assert.match(duplicate.text, new RegExp(GROUP));
    assert.equal(duplicate.state, 'draft'); assert.equal(duplicate.approved, 0);
    assert.equal(f.server.state.posts, 0); assert.equal(f.store.pending().length, 0);
    console.log('WeChat/Harness fixture artifacts:', f.run.runRoot);
  } finally { await runtime.close(); }
});

test('a later successful image retry upgrades an earlier placeholder row', async t => {
  const f = await fixture(t);
  const base = { platform: 'wechat', accountId: ACCOUNT, groupId: GROUP, userId: SELF,
    sourceMessageId: 'retry-image', serverId: '1', interaction: 'image', eventTime: '2026-11-11T12:43:24+00:00' };
  f.store.commitEvent('1', { ...base, text: '[群友发送图片；暂时无法识别内容]',
    imageError: 'Error', imageErrorMessage: 'Unsupported sticker image type' }, 'image_unavailable');
  f.store.commitEvent('1', { ...base, text: '[群友发送图片；以下是看图描述，不是群友原话] 熊猫',
    imageSummary: '一只熊猫', imageSafety: 'safe' }, 'image');
  const rows = f.store.pending();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message.imageSummary, '一只熊猫');
  assert.equal(rows[0].message.imageError, undefined);
});

test('only clearly better duplicate messages replace the stored row', () => {
  assert.equal(improvesInboxMessage({ imageError: 'Error' }, { imageSummary: '熊猫' }), true);
  assert.equal(improvesInboxMessage({ imageSummary: '熊猫' }, { imageSummary: '熊猫' }), false);
  assert.equal(improvesInboxMessage({ text: '普通文字' }, { text: '普通文字' }), false);
});
