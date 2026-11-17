import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot } from './runtime.mjs';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { NativeCommentReplyGateway } from '../packages/moments/comment-reply-native.mjs';
import { buildCommentReplyBody } from '../packages/moments/comment-reply-protocol.mjs';
import { CommentReplyStore, CommentReplyService } from '../packages/moments/comment-reply-service.mjs';

const help = `node scripts/moments-reply.mjs <prepare|show|send|status|inspect> [options]
  inspect --id MOMENT_ID
  prepare --id MOMENT_ID --reply-to COMMENT_ID --text TEXT (or --text-file FILE)
  show --key KEY
  send --key KEY --confirm DIGEST
  status --key KEY
  --db FILE (default: .runtime/moments/comment-replies.sqlite)
prepare reads the exact moment detail; only send can submit a comment. A prior attempt is never resent.`;
const env = process.env;
function view(row) {
  return { key: row.key, state: row.state, digest: row.digest, momentId: row.momentId ?? row.moment?.id,
    sourceComment: row.sourceComment ?? row.comment, text: row.text, commentId: row.commentId ?? row.verification?.commentId,
    attemptedAt: row.attemptedAt, receipt: row.receipt, verification: row.verification };
}
async function main() {
  const { values: v, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    id: { type: 'string' }, 'reply-to': { type: 'string' }, text: { type: 'string' },
    'text-file': { type: 'string' }, key: { type: 'string' }, confirm: { type: 'string' },
    db: { type: 'string' }, help: { type: 'boolean' },
  } });
  if (v.help) { console.log(help); return; }
  const [action] = positionals;
  if (positionals.length !== 1 || !['prepare', 'show', 'send', 'status', 'inspect'].includes(action)) throw Error(help);
  const allowed = new Set(['db', ...(action === 'prepare' ? ['id', 'reply-to', 'text', 'text-file']
    : action === 'inspect' ? ['id'] : action === 'send' ? ['key', 'confirm'] : ['key'])]);
  for (const key of Object.keys(v)) if (!allowed.has(key)) throw Error(`Invalid option for ${action}: ${key}`);
  if (['prepare', 'inspect'].includes(action) ? !v.id : !v.key) throw Error('Target ID or key is required');
  if (action === 'prepare' && (!v['reply-to'] || (v.text !== undefined) === (v['text-file'] !== undefined))) throw Error('prepare requires source comment and exactly one text input');
  if (action === 'send' && !v.confirm) throw Error('Exact digest confirmation is required');
  const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
  const cli = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
  const list = JSON.parse(execFileSync(cli, ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true, timeout: 20000 }));
  const account = selectOnlineAccount(list.items, { accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID, alias: env.SOCIOMEM_WECHAT_ALIAS });
  const client = new MomentsDaemonClient({ baseUrl: env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174',
    token: readFileSync(env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token'), 'utf8').trim(), accountId: account.accountId });
  const gateway = new NativeCommentReplyGateway({ client, selfId: account.selfUserId, buildBody: buildCommentReplyBody });
  if (action === 'inspect') { console.log(JSON.stringify(await gateway.readMoment(v.id), null, 2)); return; }
  const db = v.db ?? join(projectRoot, '.runtime', 'moments', 'comment-replies.sqlite');
  if (action !== 'prepare' && !existsSync(db)) throw Error('Reply ledger does not exist');
  const store = new CommentReplyStore(db, { accountId: account.accountId, selfId: account.selfUserId });
  try {
    const service = new CommentReplyService({ store, gateway, accountId: account.accountId, selfId: account.selfUserId });
    let result;
    if (action === 'prepare') {
      const moment = await gateway.readMoment(v.id);
      const comment = moment.comments.find(row => row.commentId === v['reply-to']);
      if (!comment) throw Error('Source comment no longer exists');
      const text = v.text ?? readFileSync(v['text-file'], 'utf8').replace(/^\ufeff/u, '');
      result = await service.prepare({ moment, comment, text });
    } else if (action === 'send') result = await service.send(v.key, v.confirm);
    else if (action === 'status') result = await service.status(v.key);
    else result = store.get(v.key);
    if (!result) throw Error('Unknown reply');
    console.log(JSON.stringify(view(result), null, 2));
    if (['needs_review', 'rejected', 'stale'].includes(result.state)) process.exitCode = 2;
  } finally { store.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
