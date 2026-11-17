import { encodeFields } from './protobuf.mjs';

export function replyRootId(comment) {
  return BigInt(comment.replyCommentId ?? comment.commentId);
}

export function replyBody({ momentId, comment, selfId, clientId, text, now = Math.floor(Date.now() / 1000) }) {
  const rootId = replyRootId(comment);
  const action = encodeFields([
    { number: 1, bytes: selfId },
    { number: 2, bytes: comment.userId },
    { number: 5, varint: 2 },
    { number: 6, varint: 1 },
    { number: 7, varint: now },
    { number: 8, bytes: text },
    { number: 12, varint: 0 },
    { number: 13, varint: rootId },
  ]);
  const refer = encodeFields([
    { number: 1, bytes: comment.userId },
    { number: 2, bytes: comment.replyTo ?? selfId },
    { number: 5, varint: 2 },
    { number: 6, varint: 1 },
    { number: 7, varint: comment.createTime ?? 0 },
    { number: 8, bytes: comment.text ?? '' },
    { number: 12, varint: BigInt(comment.commentId) },
    { number: 13, varint: comment.replyCommentId ? BigInt(comment.replyCommentId) : 0n },
  ]);
  const group = encodeFields([
    { number: 1, varint: BigInt(momentId) },
    { number: 2, varint: rootId },
    { number: 3, bytes: action },
    { number: 4, bytes: refer },
    { number: 5, bytes: clientId },
  ]);
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}
