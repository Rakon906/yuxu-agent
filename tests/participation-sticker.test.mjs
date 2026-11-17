import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { classifyParticipation, ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { projectRoot } from '../scripts/runtime.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN } from './fixtures/wechat-server.mjs';

const start = Date.parse('2026-11-02T14:00:00+08:00');
const decision = (reply, extra = {}) => ({ isQuestion: false, isAddressed: false,
  isFollowup: false, answeredByHuman: false, shouldReply: Boolean(reply), reply,
  reason: 'synthetic decision', stickers: [], ...extra });
const candidates = [
  { stickerId: 'STK-000001', context: '无语/尴尬', summary: '黄色动物呆住', visibleText: '', tone: '发愣' },
  { stickerId: 'STK-000002', context: '开心/笑', summary: '笑着流汗', visibleText: '', tone: '强颜欢笑' },
];

async function setup(t, { sendEnabled = true } = {}) {
  await mkdir(join(projectRoot, '.runtime'), { recursive: true });
  const root = await mkdtemp(join(projectRoot, '.runtime', 'participation-sticker-test-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const source = new AdapterStore(inboxPath, ACCOUNT);
  const outbox = new AdapterStore(join(root, 'participation.sqlite'), ACCOUNT);
  const ledger = new ParticipationLedger(outbox);
  const server = await startWeChatFixture();
  const client = new WeChatClient({ baseUrl: server.origin, token: TOKEN, accountId: ACCOUNT });
  const adapter = new WeChatAdapter({ client, store: outbox, allowedGroups: [GROUP],
    selfUserId: SELF, sendingEnabled: sendEnabled, cooldownMs: 0 });
  let sequence = 0;
  const insert = (id, senderId, text, options = {}) => source.commitEvent(String(++sequence), {
    platform: 'wechat', accountId: ACCOUNT, groupId: GROUP, userId: senderId,
    sourceMessageId: id, text, eventTime: new Date(start).toISOString(),
    recordedAt: new Date(start).toISOString(), mentions: options.mentions ??
      { state: 'known', self: false, userIds: [] },
  }, 'text');
  t.after(async () => { source.close(); outbox.close(); await server.close(); });
  const cycle = (now, model, extra = {}) => runParticipationCycle({ ledger, adapter, model,
    inboxPath, accountId: ACCOUNT, groupId: GROUP, now, startAtLatest: false, sendEnabled,
    stickerCandidates: candidates, ...extra });
  return { root, source, outbox, ledger, server, insert, cycle };
}

test('one judgment can choose one sticker per source message and send them after deciding', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  f.insert('m2', 'alice', '我快化了');
  await f.cycle(start, () => assert.fail('not due'));
  const calls = [];
  let modelInput;
  const model = input => {
    modelInput = input;
    return decision('', { shouldReply: false, stickers: [
      { stickerId: 'STK-000001', sourceId: 'm1', reason: '接住热到发呆' },
      { stickerId: 'STK-000002', sourceId: 'm2', reason: '接住快化了' },
    ] });
  };
  const result = await f.cycle(start + 90001, model, {
    sendStickers: async ({ stickers }) => {
      calls.push(stickers);
      return { results: stickers.map(choice => ({ stickerId: choice.stickerId, state: 'sent' })),
        sent: stickers.length, pending: 0, failed: 0 };
    },
  });
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.stickers, ['STK-000001', 'STK-000002']);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].map(choice => [choice.stickerId, choice.sourceId]),
    [['STK-000001', 'm1'], ['STK-000002', 'm2']]);
  assert.equal(modelInput.stickers.length, 2);
  assert.equal(f.ledger.task('m1').state, 'sent');
  assert.equal(f.server.state.posts, 0, 'sticker-only turns do not post text');
});

test('mandatory mentions keep text and drop sticker choices', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '肥鱼在吗', { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  let stickerCalls = 0;
  const model = () => decision('在，刚躺下。', { stickers: [
    { stickerId: 'STK-000001', sourceId: 'm1', reason: '想接个表情' },
  ] });
  const result = await f.cycle(start + 15001, model, {
    sendStickers: async () => { stickerCalls++; return { results: [], sent: 1, pending: 0, failed: 0 }; },
  });
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.stickers, []);
  assert.equal(stickerCalls, 0);
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.server.state.lastSendInput.text, '在，刚躺下。');
});

test('an explicit sticker request in a mention allows a sticker', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '@肥鱼不肥 发个表情包', { mentions: { state: 'known', self: true, userIds: [SELF] } });
  await f.cycle(start, () => assert.fail('not due'));
  const calls = [];
  const model = () => decision('给你。', { stickers: [
    { stickerId: 'STK-000001', sourceId: 'm1', reason: '点名要表情包' },
  ] });
  const result = await f.cycle(start + 15001, model, {
    sendStickers: async ({ stickers }) => {
      calls.push(stickers);
      return { results: stickers.map(choice => ({ stickerId: choice.stickerId, state: 'sent' })),
        sent: stickers.length, pending: 0, failed: 0 };
    },
  });
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.stickers, ['STK-000001']);
  assert.equal(calls.length, 1);
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.server.state.lastSendInput.text, '给你。');
});

test('image descriptions are ordinary chat, not direct questions', () => {
  assert.equal(classifyParticipation({ text: '这张图里写了什么？', interaction: 'image' }), 'ordinary');
});

test('trend context reaches the participation model', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let modelInput;
  const result = await f.cycle(start + 90001, input => {
    modelInput = input;
    return decision('是挺热的。');
  }, {
    lookupTrends: async () => [{ title: '三角洲新版本', summary: '新赛季讨论',
      category: '游戏', source: 'zhihu', lastSeenAt: new Date(start).toISOString() }],
  });
  assert.equal(result.status, 'sent');
  assert.equal(modelInput.trendContext[0].title, '三角洲新版本');
  assert.equal(modelInput.trendContext[0].source, 'zhihu');
});

test('shadow mode records sticker choices without sending them', async t => {
  const f = await setup(t, { sendEnabled: false });
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let stickerCalls = 0;
  const model = () => decision('', { shouldReply: false, stickers: [
    { stickerId: 'STK-000001', sourceId: 'm1', reason: '接住热到发呆' },
  ] });
  const result = await f.cycle(start + 90001, model, {
    sendStickers: async () => { stickerCalls++; return { results: [], sent: 1, pending: 0, failed: 0 }; },
  });
  assert.equal(result.status, 'shadowed');
  assert.deepEqual(result.stickers, ['STK-000001']);
  assert.equal(stickerCalls, 0);
  assert.equal(f.server.state.posts, 0);
});

test('sticker shadow keeps the text reply but records sticker choices', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let stickerCalls = 0;
  const model = () => decision('是挺热的。', { stickers: [
    { stickerId: 'STK-000001', sourceId: 'm1', reason: '接住热到发呆' },
  ] });
  const result = await f.cycle(start + 90001, model, { stickerShadow: true,
    sendStickers: async () => { stickerCalls++; return { results: [], sent: 1, pending: 0, failed: 0 }; } });
  assert.equal(result.status, 'sent');
  assert.deepEqual(result.stickers, ['STK-000001']);
  assert.equal(stickerCalls, 0);
  assert.equal(f.server.state.posts, 1);
  assert.equal(f.server.state.lastSendInput.text, '是挺热的。');
});

test('sticker-only shadow records the choice without sending anything', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let stickerCalls = 0;
  const model = () => decision('', { shouldReply: false, stickers: [
    { stickerId: 'STK-000001', sourceId: 'm1', reason: '接住热到发呆' },
  ] });
  const result = await f.cycle(start + 90001, model, { stickerShadow: true,
    sendStickers: async () => { stickerCalls++; return { results: [], sent: 1, pending: 0, failed: 0 }; } });
  assert.equal(result.status, 'shadowed');
  assert.deepEqual(result.stickers, ['STK-000001']);
  assert.equal(stickerCalls, 0);
  assert.equal(f.server.state.posts, 0);
});

test('an unknown sticker ID is dropped and does not become a response', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '今天真热');
  await f.cycle(start, () => assert.fail('not due'));
  let stickerCalls = 0;
  const model = () => decision('', { shouldReply: false, stickers: [
    { stickerId: 'STK-999999', sourceId: 'm1', reason: '不存在的素材' },
  ] });
  const result = await f.cycle(start + 90001, model, {
    sendStickers: async () => { stickerCalls++; return { results: [], sent: 1, pending: 0, failed: 0 }; },
  });
  assert.equal(result.status, 'deferred');
  assert.equal(stickerCalls, 0);
  assert.equal(f.server.state.posts, 0);
});

test('a drawing request sends a generated picture', async t => {
  const f = await setup(t);
  f.insert('m1', 'alice', '那你画一碗');
  await f.cycle(start, () => assert.fail('not due'));
  const calls = [];
  const model = () => decision('', { shouldReply: true,
    image: { prompt: '一个空碗', reason: '群友要画碗' } });
  const result = await f.cycle(start + 90001, model, {
    sendImage: async ({ image }) => { calls.push(image); return { state: 'sent', key: 'k' }; },
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.image, '一个空碗');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, '一个空碗');
  assert.equal(f.server.state.posts, 0);
});

test('a photo request phrased as 看看 still sends a generated picture', async t => {
  const f = await setup(t);
  f.insert('dorm-1', 'alice', '看看你宿舍的照片');
  await f.cycle(start, () => assert.fail('not due'));
  const calls = [];
  const model = () => decision('', { shouldReply: true,
    image: { prompt: '一间女生宿舍', reason: '群友要看宿舍照片' } });
  const result = await f.cycle(start + 90001, model, {
    sendImage: async ({ image }) => { calls.push(image); return { state: 'sent', key: 'k' }; },
  });
  assert.equal(result.status, 'sent');
  assert.equal(result.image, '一间女生宿舍');
  assert.equal(calls.length, 1);
});
