import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { decodeMessage, encodeFields, hexToBytes } from '../packages/moments/protobuf.mjs';
import { parseTimelineReply, timelineBody } from '../packages/moments/timeline.mjs';
import { replyBody } from '../packages/moments/reply.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';
const ledgerPath = env.SOCIOMEM_MOMENTS_LEDGER ?? join(projectRoot, '.runtime', 'moments', 'ledger.sqlite');
const newClientId = () => `${Math.floor(Date.now() / 1000)}${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = name => args.includes(name);
const author = option('--author') ?? null;
const authorId = option('--author-id') ?? null;
const momentId = option('--id') ?? null;
const deleteCommentId = option('--delete-comment') ?? null;
const replyTo = option('--reply-to') ?? null;
if (replyTo) {
  throw new Error('The experimental --reply-to sender is retired. Use scripts/moments-reply.mjs prepare --id <momentId> --reply-to <commentId> --text <text>, then send --key <key> --confirm <digest>.');
}
const textFile = option('--text-file');
const text = option('--text') ?? (textFile ? readFileSync(textFile, 'utf8').trim() : '');
const like = flag('--like');
const unlike = flag('--unlike');
const send = flag('--send');
const variant = option('--variant') ?? (like || unlike ? 'native' : 'info');
const objectMode = option('--object') ?? 'full';
const contentField = Number(option('--content-field') ?? 4);
const commentType = Number(option('--type') ?? (unlike ? 5 : like ? 1 : 2));
const commentId = option('--comment-id') === 'now' ? BigInt(Math.floor(Date.now() / 1000)) : 0n;
if (!author && !authorId && !momentId) throw new Error('Use --author, --author-id or --id');
if (!like && !unlike && !text.trim() && !deleteCommentId) {
  throw new Error('Use --text, --text-file, --like, --unlike or --delete-comment');
}
if (replyTo && (like || unlike || deleteCommentId)) {
  throw new Error('--reply-to cannot be combined with --like, --unlike or --delete-comment');
}
if (!['info', 'group', 'action', 'info-buffer', 'group-buffer', 'native', 'comment'].includes(variant)) {
  throw new Error('Variant must be info, group, action, info-buffer, group-buffer, native or comment');
}
if (!['full', 'minimal'].includes(objectMode)) throw new Error('Object must be full or minimal');
if (![3, 4, 8].includes(contentField)) throw new Error('Content field must be 3, 4 or 8');

function rawObject(replyHex, id) {
  for (const field of decodeMessage(hexToBytes(replyHex)).fields) {
    if (field.number !== 4 || typeof field.bytes !== 'string') continue;
    const nested = decodeMessage(Buffer.from(field.bytes, 'hex'));
    if (String(nested.fields.find(item => item.number === 1)?.varint) === String(id)) return field.bytes;
  }
  throw new Error('Target moment bytes were not found in the timeline reply');
}

function minimalObject(target) {
  return encodeFields([
    { number: 1, varint: BigInt(target.id) },
    { number: 2, bytes: target.author.id },
    { number: 3, bytes: target.author.name },
    { number: 4, varint: target.createTime ?? 0 },
  ]).toString('hex');
}

function nativeBody(target, self, clientId, actionTo = target.author.id) {
  const now = Math.floor(Date.now() / 1000);
  const action = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: actionTo },
    { number: contentField, bytes: text },
    { number: 5, varint: commentType },
    { number: 6, varint: 1 },
    { number: 7, varint: now },
    { number: 12, varint: commentId },
    { number: 13, varint: 0 },
  ]);
  const group = encodeFields([
    { number: 1, varint: BigInt(target.id) },
    { number: 3, bytes: action },
  ]);
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}

function commentNativeBody(target, self, clientId) {
  const now = Math.floor(Date.now() / 1000);
  const action = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: text },
    { number: 3, bytes: text },
    { number: 4, bytes: text },
    { number: 5, varint: commentType },
    { number: 6, varint: 0 },
    { number: 7, varint: now },
    { number: 8, bytes: text },
    { number: 12, varint: 0 },
    { number: 13, varint: 0 },
  ]);
  const group = encodeFields([
    { number: 1, varint: BigInt(target.id) },
    { number: 3, bytes: action },
  ]);
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}

function deleteBody(target, commentId, owner) {
  const deleteBytes = encodeFields([
    { number: 1, varint: commentId },
    { number: 2, bytes: owner },
  ]);
  const buffer = encodeFields([
    { number: 1, varint: deleteBytes.length },
    { number: 2, bytes: deleteBytes },
  ]);
  const op = encodeFields([
    { number: 1, varint: BigInt(target.id) },
    { number: 2, varint: 4 },
    { number: 3, bytes: buffer },
  ]);
  return encodeFields([
    { number: 2, varint: 1 },
    { number: 3, bytes: op },
  ]).toString('hex');
}

function commentBody(target, objectHex, self) {
  const now = Math.floor(Date.now() / 1000);
  const type = like ? 1 : 2;
  const action = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: target.author.id },
    { number: 3, varint: type },
    { number: 4, varint: 1 },
    { number: 5, bytes: text },
    { number: 6, varint: now },
    { number: 7, varint: commentId },
    { number: 8, varint: 0 },
  ]);
  const info = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: self.name },
    { number: 4, varint: type },
    { number: 5, bytes: text },
    { number: 6, varint: now },
    { number: 7, varint: commentId },
    { number: 8, varint: 0 },
  ]);
  const buffered = value => encodeFields([
    { number: 1, varint: Buffer.byteLength(value) },
    { number: 2, bytes: value },
  ]);
  let third;
  if (variant === 'info') third = info;
  else if (variant === 'info-buffer') third = buffered(info);
  else if (variant === 'group') {
    third = encodeFields([
      { number: 1, varint: BigInt(target.id) },
      { number: 2, varint: BigInt(target.id) },
      { number: 3, bytes: action },
    ]);
  } else if (variant === 'group-buffer') {
    third = encodeFields([
      { number: 1, varint: BigInt(target.id) },
      { number: 2, varint: BigInt(target.id) },
      { number: 3, bytes: buffered(action) },
    ]);
  } else third = action;
  return encodeFields([
    { number: 2, bytes: Buffer.from(objectHex, 'hex') },
    { number: 3, bytes: third },
  ]).toString('hex');
}

const list = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
  { encoding: 'utf8', windowsHide: true });
const account = selectOnlineAccount(JSON.parse(list.stdout).items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID,
  alias: env.SOCIOMEM_WECHAT_ALIAS,
});
const token = readFileSync(tokenPath, 'utf8').trim();
const client = new MomentsDaemonClient({ baseUrl, token, accountId: account.accountId });

const timelineReply = await client.probe(211, timelineBody(), { withBaseRequest: true });
if (timelineReply.ok === false) throw new Error(timelineReply.detail ?? 'Moments timeline failed');
const timeline = parseTimelineReply(timelineReply.replyHex);
const target = momentId
  ? timeline.objects.find(item => String(item.id) === String(momentId))
  : authorId
    ? timeline.objects.find(item => item.author.id === authorId)
    : timeline.objects.find(item => item.author.name === author);
if (!target) throw new Error('Target moment was not found in the first timeline page');
const self = { id: account.selfUserId, name: env.SOCIOMEM_SELF_NAME ?? '肥鱼不肥' };
const replyTarget = replyTo
  ? target.comments.find(comment => String(comment.commentId) === String(replyTo))
  : null;
if (replyTo && !replyTarget) throw new Error(`Comment ${replyTo} was not found under moment ${target.id}`);
if (replyTarget && replyTarget.userId === self.id) {
  throw new Error('Cannot reply to your own comment; send a top-level comment instead');
}
const ledger = new MomentsLedger(ledgerPath);
const objectHex = objectMode === 'minimal'
  ? minimalObject(target)
  : rawObject(timelineReply.replyHex, target.id);
const cgi = deleteCommentId ? 218 : 213;
const storedClientId = deleteCommentId
  ? (option('--delete-client-id') ?? ledger.findCommentClientId(target.id, deleteCommentId))
  : null;
if (deleteCommentId && !storedClientId) {
  ledger.close();
  throw new Error('No local clientId for this comment; delete it manually in WeChat');
}
let clientId;
let actionTo = replyTarget?.userId ?? target.author.id;
let likeClientId = null;
if (deleteCommentId) clientId = null;
else if (unlike) {
  likeClientId = ledger.findLatestClientId(target.id, 'like');
  if (!likeClientId) {
    ledger.close();
    throw new Error('No local like clientId to cancel; unlike manually in WeChat');
  }
  actionTo = option('--action-to') ?? target.author.id;
  clientId = option('--client-id') ?? newClientId();
} else clientId = option('--client-id') ?? newClientId();
const bodyHex = deleteCommentId
  ? deleteBody(target, Number(deleteCommentId), storedClientId)
  : replyTo
    ? replyBody({ momentId: target.id, comment: replyTarget, selfId: self.id, clientId, text })
    : variant === 'comment'
      ? commentNativeBody(target, self, clientId)
      : variant === 'native'
        ? nativeBody(target, self, clientId, actionTo)
        : commentBody(target, objectHex, self);
const targetView = { id: target.id, author: target.author, createdAt: target.createTime
  ? new Date(target.createTime * 1000).toISOString() : null, text: target.text,
  comments: target.comments.length, likes: target.likes.length };
const kind = deleteCommentId ? 'delete' : replyTo ? 'reply' : unlike ? 'unlike' : like ? 'like' : 'comment';

if (!send) {
  ledger.close();
  console.log(JSON.stringify({ dryRun: true, cgi, variant, like, unlike, replyTo, replyTarget,
    text, deleteCommentId, clientId: storedClientId ?? clientId, storedClientId, likeClientId, actionTo,
    accountId: account.accountId, self, target: targetView, bodyHex }, null, 2));
  process.exit(0);
}

const sentAt = Math.floor(Date.now() / 1000);
const actionKey = `moments-${kind}-${target.id}-${Date.now()}-${randomUUID().slice(0, 8)}`;
ledger.recordAction({ key: actionKey, kind, momentId: target.id, authorId: target.author.id,
  text, clientId, state: 'dispatching' });
if (deleteCommentId) {
  ledger.updateAction(actionKey, { state: 'dispatching', commentId: String(deleteCommentId) });
}
const reply = await client.probe(cgi, bodyHex, { withBaseRequest: true, write: true });
if (reply.ok === false) {
  ledger.updateAction(actionKey, { state: 'needs_review',
    receipt: { error: reply.detail ?? 'probe_failed' } });
  ledger.close();
  throw new Error(reply.detail ?? 'Moments comment failed');
}
ledger.updateAction(actionKey, { state: reply.baseCode === 0 ? 'sent' : 'needs_review',
  receipt: { cgi, baseCode: reply.baseCode, baseMessage: reply.baseMessage, replyBytes: reply.replyBytes } });
console.log(JSON.stringify({ sent: true, cgi, variant, like, unlike, replyTo, replyTarget, text, deleteCommentId,
  clientId, storedClientId, likeClientId, actionTo, actionKey, accountId: account.accountId, target: targetView,
  baseCode: reply.baseCode, baseMessage: reply.baseMessage, replyBytes: reply.replyBytes }, null, 2));

if (reply.baseCode !== 0) {
  ledger.close();
  process.exitCode = 1;
} else {
  await new Promise(resolve => setTimeout(resolve, 1500));
  const afterReply = await client.probe(211, timelineBody(), { withBaseRequest: true });
  let verified = false;
  let commentIdFound = null;
  if (afterReply.ok !== false) {
    const after = parseTimelineReply(afterReply.replyHex).objects
      .find(item => String(item.id) === String(target.id));
    const comments = after?.comments ?? [];
    if (deleteCommentId) {
      verified = !comments.some(comment => String(comment.commentId) === String(deleteCommentId));
    } else if (kind === 'reply') {
      const created = comments.filter(comment => comment.userId === self.id && comment.text === text &&
        (comment.createTime ?? 0) >= sentAt - 5)
        .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))[0];
      const expectedRoots = new Set([String(replyTarget.replyCommentId ?? replyTarget.commentId),
        String(replyTarget.commentId)]);
      verified = Boolean(created) && created.replyTo === replyTarget.userId &&
        expectedRoots.has(String(created.replyCommentId ?? ''));
      commentIdFound = created ? String(created.commentId) : null;
    } else if (kind === 'comment') {
      const created = comments.filter(comment => comment.userId === self.id && comment.text === text &&
        (comment.createTime ?? 0) >= sentAt - 5)
        .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))[0];
      verified = Boolean(created);
      commentIdFound = created ? String(created.commentId) : null;
    } else if (kind === 'unlike') {
      verified = !(after?.likes ?? []).some(item => item.userId === self.id);
    } else {
      verified = (after?.likes ?? []).some(like => like.userId === self.id);
    }
    console.log(JSON.stringify({ verified, comments, likes: after?.likes ?? [] }, null, 2));
  }
  ledger.updateAction(actionKey, { state: verified ? 'sent' : 'needs_review', commentId: commentIdFound });
  ledger.markSeen({ momentId: target.id, authorId: target.author.id, authorName: target.author.name,
    createdAt: targetView.createdAt, text: target.text, decision: kind, reason: 'cli',
    comment: text, state: verified ? 'acted' : 'needs_review' });
  ledger.markActed(target.id, { state: verified ? 'acted' : 'needs_review',
    clientId, commentId: commentIdFound ?? (deleteCommentId ? String(deleteCommentId) : null) });
  ledger.close();
}
