import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MomentPersonMemory, readMomentObservations } from '../packages/moments/person-memory.mjs';
import { refreshMomentMemory } from '../packages/moments/person-memory-refresh.mjs';
import { decodeMessage, encodeFields, hexToBytes } from '../packages/moments/protobuf.mjs';

const now = Date.parse('2026-11-13T06:00:00Z'), DAY = 86400000, accountId = 'account-a';
const originalAt = now - 2 * DAY;
function detail({ id = '9001', author = 'friend', text = '回天津了', xmlId = id, xmlAuthor = author, code = 0, privatePost = false } = {}) {
  const base = encodeFields([{ number: 1, varint: code }]);
  const xml = `<TimelineObject><id>${xmlId}</id><username>${xmlAuthor}</username><createTime>${Math.floor(originalAt / 1000)}</createTime><contentDesc>${text}</contentDesc><private>${privatePost ? 1 : 0}</private><ContentObject/></TimelineObject>`;
  const descriptor = encodeFields([{ number: 1, varint: Buffer.byteLength(xml) }, { number: 2, bytes: xml }]);
  const object = encodeFields([{ number: 1, varint: BigInt(id) }, { number: 2, bytes: author },
    { number: 4, varint: Math.floor(originalAt / 1000) }, { number: 5, bytes: descriptor }]);
  return { cgi: 210, ok: true, baseCode: code, replyHex: encodeFields([{ number: 1, bytes: base },
    ...(code === 0 ? [{ number: 2, bytes: object }] : [])]).toString('hex') };
}
function fixture(t, count = 1) {
  const parent = resolve(tmpdir()), dir = mkdtempSync(join(parent, 'moment-refresh-')), path = join(dir, 'memory.sqlite');
  const memory = new MomentPersonMemory(path);
  t.after(() => { memory.close();
    if (!resolve(dir).startsWith(parent + '/') && !resolve(dir).startsWith(parent + '\\')) throw Error('Unexpected fixture path');
    rmSync(dir, { recursive: true, force: true }); });
  for (let i = 0; i < count; i++) memory.record({ accountId, moment: { id: String(9001 + i),
    author: { id: 'friend' }, text: '这两天在青岛旅游', createTime: originalAt / 1000 }, now: originalAt });
  return { memory, path, row: id => memory.db.prepare('SELECT * FROM moments_sources WHERE account_id=? AND moment_id=?').get(accountId, id ?? '9001') };
}

test('memory refresh sends only CGI 210 with exact source ID and renews verified original text', async t => {
  const f = fixture(t); let calls = 0;
  const client = { accountId, probe: async (cgi, body, options) => {
    calls++; assert.equal(cgi, 210); assert.deepEqual(options, { withBaseRequest: true, write: false });
    const fields = decodeMessage(hexToBytes(body)).fields;
    assert.equal(fields.length, 1); assert.equal(fields[0].number, 2); assert.equal(fields[0].varint, '9001');
    return detail();
  } };
  assert.deepEqual(await refreshMomentMemory({ memory: f.memory, client, accountId, now }),
    { attempted: 1, refreshed: 1, unavailable: 0, failed: 0 });
  assert.equal(f.row().text, '回天津了'); assert.equal(f.row().checked_at, now);
  assert.equal(readMomentObservations(f.path, { accountId, subjectId: 'friend', now })[0].evidence[0].quote, '回天津了');
  assert.equal((await refreshMomentMemory({ memory: f.memory, client, accountId, now: now + 1000 })).attempted, 0);
  assert.equal(calls, 1);
});

test('explicit unavailable detail suppresses retrieval while preserving original history', async t => {
  const f = fixture(t);
  const client = { accountId, probe: async () => detail({ code: 205 }) };
  assert.equal((await refreshMomentMemory({ memory: f.memory, client, accountId, now })).unavailable, 1);
  assert.equal(f.row().state, 'unavailable'); assert.equal(f.row().text, '这两天在青岛旅游');
  assert.deepEqual(readMomentObservations(f.path, { accountId, subjectId: 'friend', now }), []);
  assert.equal((await refreshMomentMemory({ memory: f.memory, client, accountId, now: now + 3 * DAY })).attempted, 0);
});

test('a bound private flag survives the existing detail parser and withdraws a formerly visible source', async t => {
  const f = fixture(t);
  const client = { accountId, probe: async () => detail({ privatePost: true }) };
  const result = await refreshMomentMemory({ memory: f.memory, client, accountId, now });
  assert.equal(result.refreshed, 1); assert.equal(f.row().state, 'withdrawn');
  assert.equal(f.row().text, '这两天在青岛旅游'); assert.equal(f.row().checked_at, now);
  assert.deepEqual(readMomentObservations(f.path, { accountId, subjectId: 'friend', now }), []);
});

test('network failure does not renew checked time or mark deletion and cannot starve later sources', async t => {
  const f = fixture(t, 3); const calls = [];
  const client = { accountId, probe: async (cgi, body) => {
    const id = decodeMessage(hexToBytes(body)).fields[0].varint; calls.push(id);
    if (id === '9001') throw new Error('network timeout');
    return detail({ id });
  } };
  const first = await refreshMomentMemory({ memory: f.memory, client, accountId, now, limit: 1 });
  assert.equal(first.failed, 1); assert.equal(f.row().checked_at, originalAt); assert.equal(f.row().state, 'visible');
  const second = await refreshMomentMemory({ memory: f.memory, client, accountId, now: now + 1000, limit: 1 });
  assert.equal(second.refreshed, 1); assert.deepEqual(calls, ['9001', '9002']);
  assert.equal(f.memory.db.prepare('SELECT status FROM moments_memory_checks WHERE moment_id=?').get('9001').status, 'failed');
});

test('wrong account/object/author/XML binding or envelope status cannot replace cached source', async t => {
  const f = fixture(t);
  await assert.rejects(refreshMomentMemory({ memory: f.memory, client: { accountId: 'other', probe: async () => detail() }, accountId, now }), /scope/);
  const badReplies = [detail({ id: '9002' }), detail({ author: 'other' }), detail({ xmlId: '9002' }),
    detail({ xmlAuthor: 'other' }), { ...detail({ code: 205 }), baseCode: 0 }, { ...detail(), cgi: 211 }];
  for (let index = 0; index < badReplies.length; index++) {
    const result = await refreshMomentMemory({ memory: f.memory, client: { accountId, probe: async () => badReplies[index] },
      accountId, now: now + index * DAY });
    assert.equal(result.failed, 1); assert.equal(f.row().text, '这两天在青岛旅游');
    assert.equal(f.row().checked_at, originalAt); assert.equal(f.row().state, 'visible');
  }
});

test('a concurrent newer observation is not withdrawn by an older unavailable response', async t => {
  const f = fixture(t);
  const client = { accountId, probe: async () => {
    f.memory.record({ accountId, moment: { id: '9001', author: { id: 'friend' }, text: '刚刚换了新内容', createTime: originalAt / 1000 }, now: now + 1 });
    return detail({ code: 205 });
  } };
  const result = await refreshMomentMemory({ memory: f.memory, client, accountId, now });
  assert.equal(result.unavailable, 0); assert.equal(f.row().state, 'visible'); assert.equal(f.row().text, '刚刚换了新内容');
});
