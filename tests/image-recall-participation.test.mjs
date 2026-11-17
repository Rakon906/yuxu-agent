import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { createParticipationTools } from '../packages/participation/tools.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
import { createImageRecallService, inspectOriginalImage } from '../packages/image-recall/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), accountId = 'recall-integration', groupId = 'recall@chatroom';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
const answer = extra => ({ isQuestion: false, isAddressed: true, isFollowup: false, answeredByHuman: false,
  shouldReply: true, reply: '', reason: 'fixture', ...extra });

function fixture(t) {
  const parent = join(root, '.runtime', 'test-tmp'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'image-recall-integration-')), imageDir = join(dir, 'images'); mkdirSync(imageDir);
  const inboxPath = join(dir, 'capture.sqlite'), capture = new AdapterStore(inboxPath, accountId);
  const store = new AdapterStore(join(dir, 'participation.sqlite'), accountId), ledger = new ParticipationLedger(store);
  const info = inspectOriginalImage(png), imagePath = join(imageDir, `${info.sha256}.png`); writeFileSync(imagePath, png);
  const now = Date.now(), at = new Date(now).toISOString(); let sequence = 0;
  const put = (id, text, extra = {}) => capture.commitEvent(String(++sequence), { accountId, groupId,
    userId: 'requester', sourceMessageId: id, text, interaction: 'text', eventTime: at, recordedAt: at,
    mentions: { state: 'known', self: false, userIds: [] }, ...extra }, 'fixture');
  const original = { userId: 'photographer', interaction: 'image', imageSummary: '一锅红油火锅', imageSafety: 'safe', imagePath,
    imageSha256: info.sha256, serverId: '1234', eventTime: new Date(now - 48 * 3600000).toISOString() };
  put('image1', '[图片]', original); ledger.seed(groupId, 1);
  const calls = { text: 0, image: 0, uploads: 0, plainReceipt: 0 };
  const nativeJob = { id: 'job1', accountId, threadId: groupId, sourceId: 'upload1', kind: 'send', state: 'accepted', phase: 'completed',
    serverMessageId: '123456789012345678', result: { nativeReceipt: { status: 'server_accepted', serviceCode: 0, clientIdMatches: true, serverMessageId: '123456789012345678' } } };
  const client = { accountId, message: async () => ({ id: 'image1', accountId, threadId: groupId, senderId: 'photographer',
    direction: 'incoming', type: 3, serverId: '1234' }),
    send: async (_group, _text, key) => { calls.text++; return { id: 'text1', accountId, destination: groupId, state: 'accepted', key }; },
    sendStatus: async () => { calls.plainReceipt++; throw new Error('Image must not use text receipt API'); },
    sendByKey: async () => { calls.plainReceipt++; throw new Error('Image must use its dedicated transport'); } };
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId: 'self', sendingEnabled: true, cooldownMs: 0 });
  const transport = { upload: async () => { calls.uploads++; return { id: 'upload1', ...info }; },
    submit: async () => { calls.image++; return nativeJob; }, status: async () => nativeJob, byKey: async () => nativeJob };
  const recall = createImageRecallService({ ledger, adapter, client, inboxPath, imageDir, transport });
  const useTool = createParticipationTools({ accountId, groupId, inboxPath, imageRecall: recall, openMemory: async () => { throw new Error('No memory call expected'); } });
  const cycle = (clock, model, extra = {}) => runParticipationCycle({ ledger, adapter, inboxPath, accountId, groupId,
    now: clock, startAtLatest: false, sendEnabled: true, useTool, model, sendRecalledImage: args => recall.send(args), ...extra });
  const prime = async text => { put('request1', text, { mentions: { self: true, state: 'known', userIds: ['self'] } });
    assert.equal((await cycle(now, async () => { throw new Error('Not due yet'); })).status, 'waiting'); };
  t.after(() => { recall.close(); capture.close(); store.close(); });
  return { capture, store, ledger, adapter, recall, useTool, transport, calls, nativeJob, original, put, prime, cycle, now, info, imageDir };
}

test('participation performs scoped image tool continuation then sends original without generated image or text', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下'); let steps = 0, generated = 0;
  const result = await f.cycle(f.now + 16000, async input => {
    steps++;
    if (!input.toolResults.length) return answer({ toolRequest: { name: 'image_search', query: '火锅' } });
    const found = input.toolResults[0]; assert.equal(found.images.length, 1); assert.equal(found.ambiguous, false);
    assert.equal(input.actions.imageRecall, true);
    return answer({ recalledImageId: found.images[0].imageId });
  }, { sendImage: async () => { generated++; } });
  assert.equal(result.status, 'sent'); assert.equal(steps, 2);
  assert.equal(f.calls.image, 1); assert.equal(f.calls.text, 0); assert.equal(generated, 0);
  assert.equal(f.ledger.task('request1').state, 'sent');
});

test('multiple originals support a clarification reply; model cannot make its own ID unique on the next tool call', async t => {
  const f = fixture(t), second = Buffer.concat([png, Buffer.from('different')]), info = inspectOriginalImage(second);
  const imagePath = join(f.imageDir, `${info.sha256}.png`); writeFileSync(imagePath, second);
  f.put('image2', '[图片]', { ...f.original, imageSha256: info.sha256, imagePath });
  f.store.db.prepare('UPDATE participation_cursor SET last_rowid=2 WHERE group_id=?').run(groupId);
  await f.prime('肥鱼，把上次火锅图发一下');
  let chosen;
  const result = await f.cycle(f.now + 16000, async input => {
    if (!input.toolResults.length) return answer({ toolRequest: { name: 'image_search', query: '火锅' } });
    if (input.toolResults.length === 1) {
      assert.equal(input.toolResults[0].ambiguous, true); chosen = input.toolResults[0].images[0].imageId;
      return answer({ toolRequest: { name: 'image_search', imageId: chosen } });
    }
    assert.equal(input.toolResults[1].error, 'unavailable');
    return answer({ reply: '有两张火锅图，你要哪张？', evidenceIds: ['request1'] });
  });
  assert.equal(result.status, 'sent'); assert.equal(f.calls.image, 0); assert.equal(f.calls.text, 1);
});

test('a new message arriving during upload invalidates the send authorization before image POST', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下');
  f.transport.upload = async () => { f.put('new-message', '先等等'); return { id: 'upload1', ...f.info }; };
  const result = await f.cycle(f.now + 16000, async input => !input.toolResults.length
    ? answer({ toolRequest: { name: 'image_search', query: '火锅' } })
    : answer({ recalledImageId: input.toolResults[0].images[0].imageId }));
  assert.notEqual(result.status, 'sent'); assert.equal(f.calls.image, 0); assert.equal(f.calls.text, 0);
});

test('old image tool source IDs can substantiate a textual clarification outside the conversation window', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下');
  const result = await f.cycle(f.now + 16000, async input => !input.toolResults.length
    ? answer({ toolRequest: { name: 'image_search', query: '火锅' } })
    : answer({ reply: '是红油锅底的那张吗？', evidenceIds: ['image1'] }));
  assert.equal(result.status, 'sent'); assert.equal(f.calls.text, 1); assert.equal(f.calls.image, 0);
});

test('conflicting model original-image and generation choices cannot replace an original with a generated picture', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下'); let generated = 0;
  const result = await f.cycle(f.now + 16000, async input => !input.toolResults.length
    ? answer({ toolRequest: { name: 'image_search', query: '火锅' } })
    : answer({ recalledImageId: input.toolResults[0].images[0].imageId, image: { prompt: '火锅照片', reason: '错误的重复选择' } }),
  { sendImage: async () => { generated++; return { state: 'sent' }; } });
  assert.equal(generated, 0); assert.equal(f.calls.text, 0);
  assert.ok(result.status !== 'sent' || f.calls.image === 1);
});

test('new context after upload prevents a precomputed clarification from being sent as fallback', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下');
  f.transport.upload = async () => { f.put('cancel', '不用了，别发了'); return { id: 'upload1', ...f.info }; };
  await f.cycle(f.now + 16000, async input => !input.toolResults.length
    ? answer({ toolRequest: { name: 'image_search', query: '火锅' } })
    : answer({ recalledImageId: input.toolResults[0].images[0].imageId, reply: '你要哪张火锅图？', evidenceIds: ['request1'] }));
  assert.equal(f.calls.image, 0); assert.equal(f.calls.text, 0);
});

test('unknown original-image receipt stays terminal for the ordinary cycle until dedicated reconciliation', async t => {
  const f = fixture(t); await f.prime('肥鱼，把上次火锅图发一下');
  f.transport.submit = async () => { f.calls.image++; throw new Error('lost reply'); };
  const result = await f.cycle(f.now + 16000, async input => !input.toolResults.length
    ? answer({ toolRequest: { name: 'image_search', query: '火锅' } })
    : answer({ recalledImageId: input.toolResults[0].images[0].imageId }));
  assert.equal(result.status, 'needs_review'); assert.equal(f.ledger.task('request1').state, 'needs_review');
  assert.equal((await f.adapter.reconcile(result.key)).state, 'needs_review');
  assert.equal((await f.cycle(f.now + 17000, async () => { throw new Error('Should not replay model'); })).status, 'waiting');
  assert.equal(f.calls.plainReceipt, 0); assert.equal(f.calls.image, 1); assert.equal(f.calls.text, 0);
  const [settled] = await f.recall.reconcile({ groupId }); assert.equal(settled.state, 'sent'); assert.equal(f.calls.image, 1);
});

test('model context exposes stable speaker keys for retrieved images and no raw sender IDs or cache paths', () => {
  const rawSender = 'wxid_fixture_photographer', messages = participationMessages({
    target: { id: 'request1', senderId: 'requester', text: '找图', at: new Date().toISOString() },
    context: [], kind: 'mention', mustReply: true, coreFacts: [], latestDiary: null,
    toolResults: [{ name: 'image_search', images: [{ imageId: 'IMG_0123456789abcdef01234567', sourceMessageId: 'image1', senderId: rawSender, summary: '火锅' }] }],
    actions: { imageRecall: true },
  });
  const content = messages[1].content, parsed = JSON.parse(content);
  assert.equal(content.includes(rawSender), false); assert.match(parsed.toolResults[0].images[0].speakerKey, /^M_/u);
  assert.equal(parsed.actions.imageRecall, true);
});
