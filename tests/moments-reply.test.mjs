import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, hexToBytes } from '../packages/moments/protobuf.mjs';
import { replyBody } from '../packages/moments/reply.mjs';

const field = (fields, number) => fields.find(item => item.number === number);

test('reply to a top-level comment sends the root id and reply target author', () => {
  const hex = replyBody({
    momentId: '9001',
    selfId: 'wxid_self',
    clientId: '170000000000001',
    text: '这句我接',
    now: 1700000000,
    comment: { commentId: '33', replyCommentId: null, userId: 'wxid_friend', text: '说得好',
      createTime: 1699999900, replyTo: null },
  });
  const request = decodeMessage(hexToBytes(hex)).fields;
  assert.equal(field(request, 3).text, '170000000000001');
  const group = field(request, 2).message;
  assert.equal(field(group, 1).varint, '9001');
  assert.equal(field(group, 2).varint, '33');
  assert.equal(field(group, 5).text, '170000000000001');
  const action = field(group, 3).message;
  assert.equal(field(action, 1).text, 'wxid_self');
  assert.equal(field(action, 2).text, 'wxid_friend');
  assert.equal(field(action, 5).varint, '2');
  assert.equal(field(action, 8).text, '这句我接');
  assert.equal(field(action, 13).varint, '33');
  const refer = field(group, 4).message;
  assert.equal(field(refer, 12).varint, '33');
  assert.equal(field(refer, 8).text, '说得好');
});

test('reply to a reply keeps the thread root while naming the immediate author', () => {
  const hex = replyBody({
    momentId: '9001',
    selfId: 'wxid_self',
    clientId: '170000000000002',
    text: '回头聊',
    now: 1700000000,
    comment: { commentId: '353', replyCommentId: '289', userId: 'wxid_friend', text: '你还会看朋友圈',
      createTime: 1699999950, replyTo: 'wxid_self' },
  });
  const group = field(decodeMessage(hexToBytes(hex)).fields, 2).message;
  assert.equal(field(group, 2).varint, '289');
  const action = field(group, 3).message;
  assert.equal(field(action, 2).text, 'wxid_friend');
  assert.equal(field(action, 13).varint, '289');
  const refer = field(group, 4).message;
  assert.equal(field(refer, 1).text, 'wxid_friend');
  assert.equal(field(refer, 2).text, 'wxid_self');
  assert.equal(field(refer, 12).varint, '353');
  assert.equal(field(refer, 13).varint, '289');
});
