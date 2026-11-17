import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CommentReplyStore, CommentReplyService } from './comment-reply-service.mjs';
import { NativeCommentReplyGateway } from './comment-reply-native.mjs';
import { buildCommentReplyBody } from './comment-reply-protocol.mjs';
import { createCommentReplyModel, startCommentReplyMonitor } from './comment-reply-worker.mjs';
import { runtimeSocialContext } from './social-context.mjs';

/** Loaded by the existing Moments process; no second WeChat login or daemon. */
export function startRuntimeCommentReplies({ root, client, account, send, commentSend, legacyLedgerPath,
  env = process.env, log = () => {} }) {
  const configPath = join(root, '.runtime', 'moments', 'comment-replies.json');
  let config = {};
  if (existsSync(configPath)) config = JSON.parse(readFileSync(configPath, 'utf8'));
  const setting = env.SOCIOMEM_MOMENTS_REPLY_SEND;
  if (setting !== undefined && !['0', '1'].includes(setting)) throw new Error('Invalid moments reply switch');
  const enabled = setting === undefined ? config.enabled === true : setting === '1';
  if (!enabled || !send || !commentSend) { log('moments.replies_disabled', {}); return null; }
  if (config.accountId !== account.accountId || config.selfId !== account.selfUserId || config.protocolVerified !== true) {
    throw new Error('Moments replies require verified protocol and matching configured account');
  }
  const store = new CommentReplyStore(join(root, '.runtime', 'moments', 'comment-replies.sqlite'),
    { accountId: account.accountId, selfId: account.selfUserId });
  try {
    const gateway = new NativeCommentReplyGateway({ client, selfId: account.selfUserId, buildBody: buildCommentReplyBody });
    const service = new CommentReplyService({ store, gateway, accountId: account.accountId, selfId: account.selfUserId });
    const model = createCommentReplyModel({ provider: env.SOCIOMEM_MOMENTS_PROVIDER ?? 'ollama',
      lookupSocialContext: runtimeSocialContext({ root, accountId: account.accountId, selfId: account.selfUserId, env,
        onError: detail => log('moments.social_memory_error', detail) }) });
    const monitor = startCommentReplyMonitor({ store, gateway, service, model, accountId: account.accountId,
      selfId: account.selfUserId, legacyLedgerPath,
      publishLedgerPath: join(root, '.runtime', 'moments', 'publish.sqlite'),
      intervalMs: Number(env.SOCIOMEM_MOMENTS_REPLY_POLL_MS ?? 120000), send: true, log });
    log('moments.replies_ready', { intervalMs: Number(env.SOCIOMEM_MOMENTS_REPLY_POLL_MS ?? 120000), maxRepliesPerDay: 6 });
    let stopped = false;
    return { async stop() { if (stopped) return; stopped = true; await monitor.stop(); store.close(); } };
  } catch (error) { store.close(); throw error; }
}
