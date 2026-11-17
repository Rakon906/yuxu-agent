import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { MomentsPublishService, MomentsPublishStore } from '../packages/moments/publish-service.mjs';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { prepareMomentImage } from '../packages/moments/publish-assets.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const help = `Usage: node scripts/moments-publish.mjs <draft|show|send|status> [options]
  draft --key KEY --account ACCOUNT --self-id WXID --text-file FILE [--image FILE] [--visibility private|friends]
  show --key KEY
  send --key KEY --confirm DIGEST
  status --key KEY
  --db FILE selects an independent publication ledger (default: .runtime/moments/publish.sqlite).
Draft/show never connect to WeChat. Only send can publish. Private text and image publication passed receipt, detail and phone display checks.
send requires the exact SHA-256 digest displayed by draft/show. A previous attempt is checked, never resent.`;

function view(row) {
  return { key: row.key, accountId: row.accountId, selfUserId: row.selfUserId,
    text: row.text, visibility: row.visibility, createdAt: row.createdAt,
    clientId: row.clientId, digest: row.digest, state: row.state, momentId: row.momentId,
    ...(row.media?.length ? { media: row.media } : {}),
    attemptedAt: row.attemptedAt, updatedAt: row.updatedAt,
    baseCode: row.receipt?.baseCode ?? null, verified: row.state === 'verified',
    note: row.state === 'draft' ? '本地草稿，尚未发送；请确认正文和可见范围后再发送。'
      : row.state === 'needs_review' ? '发布结果未证实；仅核对状态，不要换 key 重发相同内容。' : undefined };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    key: { type: 'string' }, account: { type: 'string' }, 'self-id': { type: 'string' },
    text: { type: 'string' }, 'text-file': { type: 'string' }, image: { type: 'string' }, visibility: { type: 'string' },
    confirm: { type: 'string' }, db: { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } });
  if (values.help) { console.log(help); return; }
  const [action] = positionals;
  if (positionals.length !== 1 || !['draft', 'show', 'send', 'status'].includes(action)) throw new Error(help);
  if (!values.key) throw new Error('--key is required');
  const allowed = new Set(action === 'draft' ? ['key', 'account', 'self-id', 'text', 'text-file', 'image', 'visibility', 'db']
    : action === 'send' ? ['key', 'confirm', 'db'] : ['key', 'db']);
  for (const name of Object.keys(values)) if (!allowed.has(name)) throw new Error(`--${name} is not valid for ${action}`);
  const filename = values.db ?? join(root, '.runtime', 'moments', 'publish.sqlite');
  if (action === 'draft' && (!values.account || !values['self-id'])) throw new Error('draft requires --account and --self-id');
  if (action === 'send' && !values.confirm) throw new Error('send requires --confirm <exact draft digest>');
  const store = new MomentsPublishStore(filename, { readOnly: action === 'show' });
  try {
    if (action === 'draft') {
      if ((values.text !== undefined) === (values['text-file'] !== undefined)) throw new Error('Use exactly one of --text or --text-file');
      const text = values.text ?? readFileSync(values['text-file'], 'utf8').replace(/^\ufeff/u, '');
      const media = values.image ? [await prepareMomentImage(values.image, { assetDir: join(dirname(filename), 'assets') })] : undefined;
      const service = new MomentsPublishService({ store, accountId: values.account, selfUserId: values['self-id'] });
      console.log(JSON.stringify(view(service.draft({ key: values.key, text, visibility: values.visibility, media })), null, 2));
      return;
    }
    const existing = store.get(values.key);
    if (!existing) throw new Error('Unknown moments draft');
    const offline = new MomentsPublishService({ store, accountId: existing.accountId, selfUserId: existing.selfUserId });
    offline.get(values.key);
    if (action === 'show' || (action === 'status' && ['draft', 'verified', 'rejected'].includes(existing.state))) {
      console.log(JSON.stringify(view(existing), null, 2)); return;
    }
    if (action === 'send' && values.confirm !== existing.digest) throw new Error('Send requires --confirm <exact draft digest>');
    const dataDir = process.env.SOCIOMEM_WECHAT_DATA_DIR ?? join(root, '.runtime', 'agent-wechat');
    const cli = process.env.SOCIOMEM_WECHAT_CLI ?? join(root, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
    const { stdout } = await promisify(execFileCallback)(cli, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const account = selectOnlineAccount(JSON.parse(stdout).items, { accountId: existing.accountId });
    if (account.selfUserId !== existing.selfUserId) throw new Error('Online account does not match draft identity');
    const tokenPath = process.env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
    const token = readFileSync(tokenPath, 'utf8').trim();
    const { NativeMomentsPublisher } = await import('../packages/moments/publish-native.mjs');
    const gateway = new NativeMomentsPublisher({ baseUrl: process.env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174',
      token, accountId: account.accountId, selfUserId: account.selfUserId });
    const service = new MomentsPublishService({ store, gateway, ...account });
    const result = action === 'send' ? await service.send(values.key, values.confirm) : await service.status(values.key);
    console.log(JSON.stringify(view(result), null, 2));
    if (['needs_review', 'rejected'].includes(result.state)) process.exitCode = 2;
  } finally { store.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
