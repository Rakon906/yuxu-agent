import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { listStickerAssets, listStickerCandidates, listStickerReview, reconcileStickerSend,
  sendSticker, setStickerReview } from '../packages/wechat-adapter/sticker-send.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN } from './fixtures/wechat-server.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const md5 = createHash('md5').update(png).digest('hex');
const xml = `<msg><emoji md5="${md5}" len="${png.length}" fromusername="wxid_other" tousername="${GROUP}" /></msg>`;

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE sticker_assets (id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, md5 TEXT NOT NULL,
      bytes INTEGER NOT NULL, filename TEXT NOT NULL, scene TEXT NOT NULL, visible_text TEXT NOT NULL,
      tone TEXT NOT NULL, model TEXT NOT NULL, described_at TEXT NOT NULL, send_xml TEXT,
      context TEXT NOT NULL DEFAULT '其他', reusable INTEGER NOT NULL DEFAULT 1,
      safety TEXT NOT NULL DEFAULT 'safe', review_state TEXT NOT NULL DEFAULT 'saved',
      review_reason TEXT NOT NULL DEFAULT '');
    CREATE TABLE sticker_occurrences (source_id TEXT PRIMARY KEY, asset_id INTEGER NOT NULL,
      group_id TEXT NOT NULL, sender_id TEXT NOT NULL, event_time TEXT NOT NULL);`);
  db.prepare("INSERT INTO meta VALUES ('accountId',?)").run(ACCOUNT);
  db.prepare(`INSERT INTO sticker_assets
    (id,sha256,md5,bytes,filename,scene,visible_text,tone,model,described_at,send_xml,context)
    VALUES (1,?,?,?,?,?,?,?,?,?,?,?)`).run('a'.repeat(64), md5, png.length, 'sticker.png',
    '两只兔子', '你好', '可能在打招呼', 'fixture-vision', '2026-11-05T00:00:00.000Z', xml, '无语/尴尬');
  db.prepare(`INSERT INTO sticker_occurrences VALUES ('sticker:1',1,?,'wxid_friend','2026-11-05T00:00:00.000Z')`)
    .run(GROUP);
  return db;
}

test('sticker send entry lists captured assets and posts one validated sticker exactly once', async t => {
  const db = database();
  const server = await startWeChatFixture();
  t.after(async () => { db.close(); await server.close(); });
  const client = new WeChatClient({ baseUrl: server.origin, accountId: ACCOUNT, token: TOKEN, timeoutMs: 1000 });
  const account = { accountId: ACCOUNT, selfUserId: SELF };
  const listed = listStickerAssets(db, { groupId: GROUP });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].stickerId, 'STK-000001');
  assert.equal(listed[0].groupId, GROUP);
  assert.equal(listed[0].sendable, true);
  const sent = await sendSticker({ db, client, account, groupId: GROUP, stickerId: 'STK-000001' });
  assert.equal(sent.state, 'sent');
  assert.equal(sent.receipt.state, 'accepted');
  assert.equal(server.state.posts, 1);
  assert.equal(server.state.lastSendInput.kind, 'sticker');
  assert.equal(server.state.lastSendInput.threadId, GROUP);
  assert.equal(server.state.lastSendInput.md5, md5);
  assert.equal(server.state.lastSendInput.length, png.length);
  assert.equal(server.state.lastSendInput.xml,
    `<msg><emoji md5="${md5}" len="${png.length}" fromusername="${SELF}" tousername="${GROUP}" /></msg>`);
  assert.equal(db.prepare('SELECT state FROM sticker_sends WHERE key=?').get(sent.key).state, 'sent');
  const replay = await sendSticker({ db, client, account, groupId: GROUP, stickerId: 'STK-000001', key: sent.key });
  assert.equal(replay.state, 'sent');
  assert.equal(server.state.posts, 1, 'a recorded attempt is reconciled, not reposted');
  assert.equal((await reconcileStickerSend({ db, client, key: sent.key })).state, 'sent');
});

test('sticker send entry refuses a sticker that never appeared in the group', async t => {
  const db = database();
  const server = await startWeChatFixture();
  t.after(async () => { db.close(); await server.close(); });
  const client = new WeChatClient({ baseUrl: server.origin, accountId: ACCOUNT, token: TOKEN, timeoutMs: 1000 });
  await assert.rejects(sendSticker({ db, client, account: { accountId: ACCOUNT, selfUserId: SELF },
    groupId: 'other@chatroom', stickerId: 'STK-000001' }), /unavailable/u);
  assert.equal(server.state.posts, 0);
  assert.equal(listStickerAssets(db, { groupId: 'other@chatroom' }).length, 0);
});

test('sticker review state controls the automatic candidate pool', () => {
  const db = database();
  try {
    const [initial] = listStickerCandidates(db, { groupId: GROUP });
    assert.equal(initial.stickerId, 'STK-000001');
    assert.equal(initial.context, '无语/尴尬');
    setStickerReview(db, { stickerId: 'STK-000001', reviewState: 'needs_review' });
    assert.equal(listStickerCandidates(db, { groupId: GROUP }).length, 0);
    assert.equal(listStickerReview(db, { state: 'needs_review' }).length, 1);
    setStickerReview(db, { stickerId: 'STK-000001', reviewState: 'saved',
      context: '开心/笑', summary: '改成笑脸' });
    const [updated] = listStickerCandidates(db, { groupId: GROUP });
    assert.equal(updated.context, '开心/笑');
    assert.equal(updated.summary, '改成笑脸');
  } finally { db.close(); }
});
