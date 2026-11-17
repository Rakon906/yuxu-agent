import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMessage, hexToBytes } from '../packages/moments/protobuf.mjs';
import { buildCommentReplyBody } from '../packages/moments/comment-reply-protocol.mjs';

const field = (fields, number) => fields.find(item => item.number === number);
const input = () => ({ momentId: '15052267819634397973',
  moment: { id: '15052267819634397973', author: { id: 'wxid_owner' } },
  selfId: 'wxid_self', selfName: '肥鱼不肥', clientId: 'sns_comment:test:1', text: '这句我接',
  now: 1794388000, comment: { commentId: '67', userId: 'wxid_friend', name: '朋友',
    createTime: 1794370000, text: '原评论', replyCommentId: null, replyTo: null } });

test('official reply wire addresses post owner and puts target comment ID in action field 9', () => {
  const request = decodeMessage(hexToBytes(buildCommentReplyBody(input()))).fields;
  assert.deepEqual(request.map(f => f.number), [2, 3]);
  assert.equal(field(request, 3).text, 'sns_comment:test:1');
  const group = field(request, 2).message;
  assert.deepEqual(group.map(f => f.number), [1, 3, 4]);
  assert.equal(field(group, 1).varint, '15052267819634397973');
  const action = field(group, 3).message;
  assert.equal(field(action, 1).text, 'wxid_self');
  assert.equal(field(action, 2).text, 'wxid_owner');
  assert.equal(field(action, 3).text, '肥鱼不肥');
  assert.equal(field(action, 4).text, 'wxid_owner');
  assert.equal(field(action, 5).varint, '2');
  assert.equal(field(action, 6).varint, '0');
  assert.equal(field(action, 7).varint, '1794370000');
  assert.equal(field(action, 8).text, '这句我接');
  assert.equal(field(action, 9).varint, '67');
  assert.equal(field(action, 12).varint, '0');
  assert.equal(field(action, 13), undefined);
  const reference = field(group, 4).message;
  assert.deepEqual(reference.map(f => f.number), [1, 3, 5, 6]);
  assert.equal(field(reference, 1).text, 'wxid_friend');
  assert.equal(field(reference, 3).text, '朋友');
  assert.equal(field(reference, 5).varint, '2');
  assert.equal(field(reference, 6).varint, '0');
});

test('reply to a reply uses its immediate ID, never the old guessed root ID', () => {
  const args = input();
  args.comment = { ...args.comment, commentId: '353', replyCommentId: '289', replyTo: 'wxid_self' };
  const group = field(decodeMessage(hexToBytes(buildCommentReplyBody(args))).fields, 2).message;
  assert.equal(field(field(group, 3).message, 9).varint, '353');
  assert.equal(field(group, 2), undefined);
});

test('reply builder rejects missing/mismatched post ownership and unsupported target identities', () => {
  const args = input();
  for (const delta of [
    { moment: undefined },
    { moment: { ...args.moment, id: '999' } },
    { authorId: 'wxid_someone_else' },
    { momentId: '18446744073709551616' },
    { momentId: 15052267819634397973 },
    { comment: { ...args.comment, userId: args.selfId } },
    { comment: { ...args.comment, commentId: '0' } },
    { comment: { ...args.comment, commentId: '2147483648' } },
    { comment: { ...args.comment, commentId64: '123' } },
    { comment: { ...args.comment, type: 1 } },
    { comment: { ...args.comment, source: -1 } },
    { comment: { ...args.comment, createTime: -1 } },
    { text: '\ud800' }, { text: 'a\u0000b' }, { text: ' ' },
    { clientId: 'unsafe id' }, { now: NaN },
  ]) assert.throws(() => buildCommentReplyBody({ ...args, ...delta }));
});
