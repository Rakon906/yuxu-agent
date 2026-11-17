import { encodeFields } from './protobuf.mjs';

const positiveId = (value, label, max) => {
  if (!['string', 'bigint', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isSafeInteger(value)) ||
      !/^[1-9][0-9]*$/u.test(String(value))) throw new Error(`Invalid ${label}`);
  const id = BigInt(value);
  if (id > max) throw new Error(`Unsupported ${label} range`);
  return id;
};

const username = (value, label) => {
  if (typeof value !== 'string' || !/^[\w.-]{1,200}$/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
};

const boundedText = (value, label, max, allowEmpty = false) => {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max ||
      !value.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new Error(`Invalid ${label}`);
  }
  return value;
};

/**
 * Official Linux 4.1.13.26 text-comment builder, not the old guessed root-ID shape.
 * Ghidra VA 0x6e07dc0 (ELF 0x6d07dc0): reply branch writes target model ID to
 * action+0x3c and its extended ID to action+0x48. Serializer 0x7fd0ae0 maps these
 * to fields 9 and 12; field 13 is a different member. Group serializer 0x7fd1ea0
 * maps +0x18/+0x20 to new action/reference action (fields 3/4). The builder does
 * not set group fields 2 or 5. Its constructor 0x6e07870 sets action recipient
 * from the post author's username; reference field 1 identifies the commenter.
 * Evidence: .runtime/moments-reply-official-headless.log and constructor.log.
 * Extended comment IDs are deliberately unsupported until their response mapping
 * is verified; current timeline commentId is the legacy signed-32-bit ID.
 */
export function buildCommentReplyBody({ momentId, moment, authorId, comment, selfId,
  selfName = '', clientId, text, now = Math.floor(Date.now() / 1000) } = {}) {
  const id = positiveId(momentId ?? moment?.id, 'moment ID', 0xffffffffffffffffn);
  if (moment?.id !== undefined && String(moment.id) !== String(id)) {
    throw new Error('Moment ID mismatch');
  }
  const owner = username(moment?.author?.id ?? authorId, 'moment author');
  if (authorId !== undefined && owner !== authorId) throw new Error('Moment author mismatch');
  const ownId = username(selfId, 'self identity');
  const targetId = username(comment?.userId, 'comment author');
  if (targetId === ownId) throw new Error('Cannot reply to self');
  const targetCommentId = positiveId(comment?.commentId, 'comment ID', 0x7fffffffn);
  if (comment.commentId64 !== undefined && comment.commentId64 !== null &&
      String(comment.commentId64) !== '0') throw new Error('Extended comment IDs are unsupported');
  if (typeof clientId !== 'string' || !clientId || clientId.length > 200 ||
      /[\u0000-\u0020\u007f]/u.test(clientId)) throw new Error('Invalid comment client ID');
  const replyText = boundedText(text, 'reply text', 5000);
  const ownName = boundedText(selfName, 'self name', 256, true);
  const targetName = boundedText(comment.name ?? '', 'comment name', 256, true);
  const source = comment.source ?? 0;
  if (!Number.isInteger(source) || source < 0 || source > 0xffffffff) {
    throw new Error('Invalid comment source');
  }
  if (comment.type !== undefined && comment.type !== 2) throw new Error('Target is not a text comment');
  if (!Number.isSafeInteger(now) || now <= 0 || now > 0xffffffff) throw new Error('Invalid current time');
  // The official reply branch overwrites the outgoing action's timestamp with
  // the referenced comment's time. Verification must therefore use new IDs and
  // reply linkage, not require createTime >= local send time.
  const at = comment.createTime ?? now;
  if (!Number.isSafeInteger(at) || at <= 0 || at > 0xffffffff) throw new Error('Invalid comment time');
  const action = encodeFields([
    { number: 1, bytes: ownId },
    { number: 2, bytes: owner },
    { number: 3, bytes: ownName },
    { number: 4, bytes: owner },
    { number: 5, varint: 2 },
    { number: 6, varint: 0 },
    { number: 7, varint: at },
    { number: 8, bytes: replyText },
    { number: 9, varint: targetCommentId },
    { number: 12, varint: 0 },
  ]);
  const reference = encodeFields([
    { number: 1, bytes: targetId },
    { number: 3, bytes: targetName },
    { number: 5, varint: 2 },
    { number: 6, varint: source },
  ]);
  const group = encodeFields([
    { number: 1, varint: id },
    { number: 3, bytes: action },
    { number: 4, bytes: reference },
  ]);
  // BaseRequest is supplied once by the authenticated native daemon.
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}
