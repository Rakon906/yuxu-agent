import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createCipheriv, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { PatProjector, decodePatBatch } from '../packages/wechat-adapter/pat-projection.mjs';

const accountId = 'account-test';
const groupId = 'group@chatroom';
const selfUserId = 'wxid_self';
const actor = 'wxid_friend';
const date = Math.floor(Date.parse('2026-11-04T10:00:00Z') / 1000);
const vint = number => {
  const out = []; let value = BigInt(number);
  do { const byte = Number(value & 127n); value >>= 7n; out.push(value ? byte | 128 : byte); }
  while (value);
  return Buffer.from(out);
};
const bytes = (number, value) => Buffer.concat([vint(number * 8 + 2), vint(value.length), value]);
const scalar = (number, value) => Buffer.concat([vint(number * 8), vint(value)]);
const nested = (number, text) => bytes(number, bytes(1, Buffer.from(text)));

function sealedPat(key, target = selfUserId, body = null, before = []) {
  const xml = body ?? `${groupId}:\n<sysmsg type="pat"><pat><fromusername>${actor}</fromusername>` +
    `<chatusername>${groupId}</chatusername><pattedusername>${target}</pattedusername></pat></sysmsg>`;
  const command = Buffer.concat([nested(2, groupId), nested(3, selfUserId), scalar(4, 10002),
    nested(5, xml), scalar(9, date)]);
  const plain = Buffer.from(JSON.stringify({ commands: [...before, { id: 5, payload: [...command] }] }));
  const batchId = createHash('sha256').update(plain).digest('hex');
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(`agent-wechat:1:${accountId}:apply:${batchId}`));
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  return { batchId, record: Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), encrypted]) };
}

test('sealed pat is projected only for this account, group and self target', () => {
  const key = randomBytes(32);
  const valid = sealedPat(key);
  const args = { record: valid.record, key, accountId, batchId: valid.batchId,
    allowedGroups: new Set([groupId]), selfUserId };
  const items = decodePatBatch(args);
  assert.equal(items.length, 1);
  assert.equal(items[0].userId, actor);
  assert.equal(items[0].mentions.self, true);
  assert.equal(items[0].interaction, 'pat');
  const other = sealedPat(key, 'wxid_other');
  assert.deepEqual(decodePatBatch({ ...args, record: other.record, batchId: other.batchId }), []);
  assert.deepEqual(decodePatBatch({ ...args, allowedGroups: new Set() }), []);
  const afterMalformed = sealedPat(key, selfUserId, null, [{ id: 5, payload: [255] }]);
  assert.equal(decodePatBatch({ ...args, record: afterMalformed.record,
    batchId: afterMalformed.batchId }).length, 1);
  assert.throws(() => decodePatBatch({ ...args, key: randomBytes(32) }));
});

test('projector seeds after history and inserts a fresh pat once without advancing WeChat cursor', () => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-pat-'));
  const accountPath = join(root, 'accounts', accountId, 'agent');
  mkdirSync(accountPath, { recursive: true });
  const key = randomBytes(32);
  writeFileSync(join(root, 'storage-key'), key);
  const control = new DatabaseSync(join(accountPath, 'control.sqlite'));
  control.exec(`CREATE TABLE apply_intents (id TEXT PRIMARY KEY,payload BLOB,state TEXT);`);
  const old = sealedPat(key);
  control.prepare('INSERT INTO apply_intents VALUES (?,?,?)').run(old.batchId, old.record, 'blocked');
  const store = new AdapterStore(join(root, 'inbox.sqlite'), accountId);
  const projector = new PatProjector({ dataDir: root, accountId, groupIds: [groupId], selfUserId, store });
  try {
    assert.equal(projector.scan(date * 1000), 0);
    const fresh = sealedPat(key, selfUserId, `${groupId}:\n<sysmsg type="pat"><pat>` +
      `<fromusername>${actor}</fromusername><chatusername>${groupId}</chatusername>` +
      `<pattedusername>${selfUserId}</pattedusername><patsuffix>x</patsuffix></pat></sysmsg>`);
    control.prepare('INSERT INTO apply_intents VALUES (?,?,?)').run(fresh.batchId, fresh.record, 'blocked');
    assert.equal(projector.scan(date * 1000), 1);
    assert.equal(projector.scan(date * 1000), 0);
    assert.equal(store.pending().length, 1);
    assert.equal(store.pending()[0].message.userId, actor);
    assert.equal(store.cursor(), '0');
  } finally {
    projector.close(); store.close(); control.close();
    rmSync(root, { recursive: true, force: true });
  }
});
