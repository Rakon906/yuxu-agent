import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { StickerProjector, downloadSticker } from '../packages/wechat-adapter/sticker-projection.mjs';
import { classifyParticipation } from '../packages/participation/index.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const accountId = 'account-test';
const groupId = 'group@chatroom';
const selfUserId = 'wxid_self';
const senderId = 'wxid_friend';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const md5 = createHash('md5').update(png).digest('hex');

function varint(value) {
  let n = BigInt(value);
  const out = [];
  while (n >= 128n) { out.push(Number(n & 127n) | 128); n >>= 7n; }
  out.push(Number(n));
  return Buffer.from(out);
}
const integer = (field, value) => Buffer.concat([varint(field * 8), varint(value)]);
const bytes = (field, value) => {
  const body = Buffer.isBuffer(value) ? value : Buffer.from(value);
  return Buffer.concat([varint(field * 8 + 2), varint(body.length), body]);
};
const nested = (field, value) => bytes(field, bytes(1, value));

function seal({ key, batchId, serverId, group }) {
  const content = `${senderId}:\n<msg><emoji md5 = "${md5}" len = "${png.length}" ` +
    'cdnurl = "http://vweixinf.tc.qq.com/test-image" /></msg>';
  const payload = Buffer.concat([integer(1, 9), nested(2, group), nested(3, selfUserId),
    integer(4, 47), nested(5, content), integer(9, 1793790000), integer(12, serverId)]);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`agent-wechat:1:${accountId}:apply:${batchId}`));
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(JSON.stringify({ commands: [
    { id: 5, payload: [...payload] }] }))), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
}

test('sticker projector scopes raw messages, reuses one visual description and preserves speakers', async t => {
  const root = mkdtempSync(join(projectRoot, '.runtime', 'sticker-test-'));
  const dataDir = join(root, 'agent-wechat');
  const agentDir = join(dataDir, 'accounts', accountId, 'agent');
  mkdirSync(agentDir, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(dataDir, 'storage-key'), key);
  const control = new DatabaseSync(join(agentDir, 'control.sqlite'));
  control.exec('CREATE TABLE apply_intents (id TEXT PRIMARY KEY,payload BLOB NOT NULL,state TEXT NOT NULL)');
  const store = new AdapterStore(join(root, 'inbox.sqlite'), accountId);
  let calls = 0;
  const projector = new StickerProjector({ dataDir, accountId, groupIds: [groupId],
    selfUserId, store,
    describe: async () => { calls++; return { summary: '两只兔子', visibleText: '你好', tone: '可能在打招呼',
      context: '打招呼/告别', reusable: true, safety: 'safe', reason: '画面清晰可复用', model: 'fixture-vision' }; },
    fetchImpl: async () => new Response(png, { status: 200 }),
    lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }] });
  t.after(() => { projector.close(); store.close(); control.close(); });
  for (const [index, group] of [groupId, groupId, 'other@chatroom'].entries()) {
    const batchId = String(index + 1).padStart(64, '0');
    control.prepare('INSERT INTO apply_intents(id,payload,state) VALUES (?,?,?)')
      .run(batchId, seal({ key, batchId, serverId: 100 + index, group }), 'projected');
  }
  assert.equal(projector.scan(), 2);
  assert.equal((await projector.processNext()).status, 'captured');
  assert.equal((await projector.processNext()).status, 'captured');
  assert.equal(calls, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sticker_assets').get().n, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM sticker_occurrences').get().n, 2);
  const asset = store.db.prepare('SELECT context,review_state,reusable,safety,classified_at FROM sticker_assets').get();
  assert.equal(asset.context, '打招呼/告别');
  assert.equal(asset.review_state, 'saved');
  assert.equal(asset.reusable, 1);
  assert.equal(asset.safety, 'safe');
  assert.ok(asset.classified_at);
  store.db.prepare("UPDATE sticker_assets SET classified_at=NULL,context='其他'").run();
  const reclassified = await projector.reclassifyNext();
  assert.equal(reclassified.status, 'reclassified');
  assert.equal(store.db.prepare('SELECT context FROM sticker_assets').get().context, '打招呼/告别');
  const messages = store.db.prepare('SELECT message FROM inbox ORDER BY rowid').all()
    .map(row => JSON.parse(row.message));
  assert.equal(messages.length, 2);
  assert.ok(messages.every(item => item.groupId === groupId && item.userId === senderId &&
    item.stickerId === 'STK-000001' && item.interaction === 'sticker' &&
    item.stickerContext === '打招呼/告别' && item.text.includes('语境：打招呼/告别') &&
    item.text.includes('不是群友原话')));
  assert.equal(classifyParticipation({ text: messages[0].text + ' 肥鱼 你在吗？',
    interaction: 'sticker', mentions: { self: false } }), 'ordinary');
  assert.ok(readFileSync(store.db.prepare('SELECT filename FROM sticker_assets').get().filename).equals(png));
});

test('sticker download rejects mismatched bytes and untrusted hosts', async () => {
  const fetchImpl = async () => new Response(png, { status: 200 });
  const lookupImpl = async () => [{ address: '1.1.1.1', family: 4 }];
  await assert.rejects(downloadSticker({ url: 'http://example.com/image', length: png.length, md5 },
    { fetchImpl, lookupImpl }), /rejected/u);
  await assert.rejects(downloadSticker({ url: 'http://vweixinf.tc.qq.com/image',
    length: png.length + 1, md5 }, { fetchImpl, lookupImpl }), /checksum/u);
});
