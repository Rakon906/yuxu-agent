import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeFields } from '../packages/moments/protobuf.mjs';
import { parseCommentMomentDetail, verifyCommentReply, NativeCommentReplyGateway } from '../packages/moments/comment-reply-native.mjs';

const base = encodeFields([{ number: 1, varint: 0 }]);
const client = { origin: 'http://127.0.0.1:6174', token: 'fixture-token', accountId: 'account-test',
  timeoutMs: 20000, probe: () => { throw new Error('The parsed client transport must not be used'); } };
function detail(id = '9001', extensions = []) {
  const xml = Buffer.from('<TimelineObject><id>9001</id><username>self</username><contentDesc>文字</contentDesc><private>1</private></TimelineObject>');
  const desc = encodeFields([{ number: 1, varint: xml.length }, { number: 2, bytes: xml }]);
  const comment = encodeFields([{ number: 1, bytes: 'friend' }, { number: 5, bytes: '在呀' },
    { number: 6, varint: 1700000000 }, { number: 7, varint: 33 }, ...extensions]);
  const object = encodeFields([{ number: 1, varint: BigInt(id) }, { number: 2, bytes: 'self' },
    { number: 5, bytes: desc }, { number: 12, bytes: comment }]);
  return encodeFields([{ number: 1, bytes: base }, { number: 2, bytes: object }]).toString('hex');
}
test('detail lookup parses comments without requiring the moment on the first timeline page', () => {
  const object = parseCommentMomentDetail(detail(), '9001');
  assert.equal(object.id, '9001');
  assert.equal(object.text, '文字');
  assert.equal(object.comments[0].commentId, '33');
  assert.equal(object.comments[0].userId, 'friend');
  assert.throws(() => parseCommentMomentDetail(detail(), '9002'), /identity/u);
  assert.throws(() => parseCommentMomentDetail('1200', '9001'), /field/u);
});
test('unmapped nonzero extensions disable legacy reply references instead of discarding them', () => {
  assert.equal(parseCommentMomentDetail(detail(), '9001').comments[0].replyReferenceSupported, true);
  assert.equal(parseCommentMomentDetail(detail('9001', [{ number: 12, varint: 99 }]), '9001')
    .comments[0].replyReferenceSupported, false);
  const zero = encodeFields([{ number: 1, varint: 0 }]);
  assert.equal(parseCommentMomentDetail(detail('9001', [{ number: 17, bytes: zero }]), '9001')
    .comments[0].replyReferenceSupported, true);
});
const context = { momentId: '9001', selfId: 'self', text: '我在', sentAt: 1700000000,
  sourceComment: { commentId: '33', userId: 'friend', replyCommentId: '17' }, priorCommentIds: ['65'] };
const actual = { commentId: '129', userId: 'self', text: '我在', createTime: 1700000001,
  replyCommentId: '33', replyTo: 'friend' };
test('only a new comment with exact target and text proves a targeted reply', () => {
  assert.equal(verifyCommentReply({ id: '9001', comments: [actual] }, context).verified, true);
  for (const changed of [{ replyTo: null, replyCommentId: null }, { replyTo: 'someone' },
    { replyCommentId: '17' }, { text: '不同' }, { userId: 'other' }, { commentId: '65' }]) {
    assert.equal(verifyCommentReply({ id: '9001', comments: [{ ...actual, ...changed }] }, context).verified, false);
  }
  assert.equal(verifyCommentReply({ id: '9001', comments: [actual, { ...actual, commentId: '161' }] }, context).reason, 'ambiguous_reply');
  assert.equal(verifyCommentReply({ id: '9001', comments: [{ ...actual, createTime: 1699999900 }] }, context).verified, true);
});
test('native gateway captures response before parsing and never retries a failed write', async () => {
  const calls = [], saved = [];
  const raw = '{ "cgi": 213, "baseCode": 0, "replyHex": "not-hex" }\n';
  const gateway = new NativeCommentReplyGateway({ client, selfId: 'self', buildBody: () => '00',
    fetchImpl: async (url, options) => {
      calls.push({ url, ...options, payload: JSON.parse(options.body) });
      return new Response(raw, { status: 200 });
    } });
  await assert.rejects(gateway.send({ selfId: 'self', moment: { id: '9001' }, attemptedAt: 1700000000000 },
    { onResponse: response => saved.push(response) }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.cgi, 213);
  assert.equal(calls[0].payload.write, true);
  assert.equal(calls[0].redirect, 'error');
  assert.match(calls[0].url, /\/account-test\/moments\/probe$/u);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].phase, 'send');
  assert.equal(saved[0].responseBody, raw);
  assert.equal(JSON.stringify(saved).includes('fixture-token'), false);
});
test('detail and status gateway use read-only CGI 210', async () => {
  const calls = [];
  const gateway = new NativeCommentReplyGateway({ selfId: 'self', client,
    fetchImpl: async (_url, options) => {
      const payload = JSON.parse(options.body);
      calls.push(payload);
      return new Response(JSON.stringify({ cgi: payload.cgi, baseCode: 0, replyHex: detail() }));
    },
  });
  assert.equal((await gateway.readMoment('9001')).id, '9001');
  assert.equal(calls[0].cgi, 210);
  assert.equal(calls[0].write, undefined);
  await assert.rejects(gateway.send({ selfId: 'different' }), /identity/u);
  assert.equal(calls.length, 1);
});

test('malformed JSON and HTTP errors retain exact original response and real status', async () => {
  for (const status of [200, 403, 500]) {
    const saved = [];
    let requests = 0;
    const raw = 'not json\n';
    const gateway = new NativeCommentReplyGateway({ client, selfId: 'self', buildBody: () => '00',
      fetchImpl: async () => { requests++; return new Response(raw, { status }); } });
    await assert.rejects(gateway.send({ selfId: 'self', moment: { id: '9001' }, attemptedAt: 1700000000000 },
      { onResponse: response => saved.push(response) }));
    assert.equal(requests, 1);
    assert.equal(saved.length, 1);
    assert.equal(saved[0].responseBody, raw);
    assert.equal(saved[0].httpStatus, status);
  }
});

test('a failed receipt save never retries a write', async () => {
  let requests = 0;
  const gateway = new NativeCommentReplyGateway({ client, selfId: 'self', buildBody: () => '00',
    fetchImpl: async () => { requests++; return new Response(JSON.stringify({ cgi: 213,
      baseCode: 0, replyHex: encodeFields([{ number: 1, bytes: base }]).toString('hex') })); } });
  await assert.rejects(gateway.send({ selfId: 'self', moment: { id: '9001' }, attemptedAt: 1700000000000 },
    { onResponse: () => { throw new Error('disk full'); } }), /disk full/u);
  assert.equal(requests, 1);
});

test('transport bounds reject oversized responses and invalid operations without retry', async () => {
  let requests = 0;
  const gateway = new NativeCommentReplyGateway({ client, selfId: 'self', buildBody: () => '00',
    fetchImpl: async () => { requests++; return new Response('x'.repeat(8 * 1024 * 1024 + 4097)); } });
  await assert.rejects(gateway.readMoment('9001'), /too large/u);
  assert.equal(requests, 1);
  await assert.rejects(gateway.request(209, '00', 'send'), /Unsupported/u);
  await assert.rejects(gateway.request(213, 'invalid', 'send'), /Invalid/u);
  assert.equal(requests, 1);
  assert.throws(() => new NativeCommentReplyGateway({ selfId: 'self', client: { ...client, origin: 'http://example.com' } }), /HTTPS/u);
});
