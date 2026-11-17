import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { parseGroupAllowlist, selectOnlineAccount, validateSendGate } from '../packages/wechat-adapter/real-config.mjs';
import { listStickerAssets, listStickerReview, reconcileStickerSend, sendSticker,
  setStickerReview } from '../packages/wechat-adapter/sticker-send.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dbPath = env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';
const configuredGroups = env.SOCIOMEM_WECHAT_GROUPS ? parseGroupAllowlist(env.SOCIOMEM_WECHAT_GROUPS) : [];

const [command, ...args] = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.filter((value, index) => !value.startsWith('--') &&
  !['--group', '--confirm', '--key', '--limit'].includes(args[index - 1]));

function usage() {
  console.error('Usage: node scripts/sticker-send.mjs list [--group <group>] [--limit N]');
  console.error('       node scripts/sticker-send.mjs send <STK-000001> [--group <group>] --confirm "SEND STK-000001" [--key <key>]');
  console.error('       node scripts/sticker-send.mjs status <key>');
  console.error('       node scripts/sticker-send.mjs review list [--state needs_review] [--group <group>] [--limit N]');
  console.error('       node scripts/sticker-send.mjs review approve|reject <STK-000001>');
  console.error('       node scripts/sticker-send.mjs review edit <STK-000001> [--context <语境>] [--summary "..."]');
  process.exitCode = 2;
}

function resolveGroup({ required }) {
  const groupId = option('--group') ?? (configuredGroups.length === 1 ? configuredGroups[0] : undefined);
  if (!groupId) {
    if (!required) return null;
    throw new Error('Specify --group <groupId> or set SOCIOMEM_WECHAT_GROUPS to one group');
  }
  if (configuredGroups.length && !configuredGroups.includes(groupId)) {
    throw new Error('Group is not in SOCIOMEM_WECHAT_GROUPS');
  }
  return groupId;
}

async function onlineAccount() {
  const result = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
    { encoding: 'utf8', windowsHide: true });
  return selectOnlineAccount(JSON.parse(result.stdout).items, {
    accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID, alias: env.SOCIOMEM_WECHAT_ALIAS,
  });
}

function openClient(account) {
  const token = readFileSync(tokenPath, 'utf8').trim();
  if (!token || /[\r\n]/u.test(token)) throw new Error('Local Yuxu WeChat API token is missing or invalid');
  return new WeChatClient({ baseUrl, token, accountId: account.accountId });
}

function openDatabase({ readOnly = false } = {}) {
  if (!existsSync(dbPath)) throw new Error(`Adapter database not found: ${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly });
  if (!readOnly) db.exec('PRAGMA busy_timeout=5000');
  return db;
}

try {
  if (command === 'list') {
    const limit = Number(option('--limit') ?? 50);
    const db = openDatabase({ readOnly: true });
    try {
      console.log(JSON.stringify(listStickerAssets(db, { groupId: resolveGroup({ required: false }), limit }), null, 2));
    } finally { db.close(); }
  } else if (command === 'send') {
    const stickerId = positional[0];
    if (!stickerId) usage();
    else {
      const confirmation = option('--confirm');
      validateSendGate({ enabled: env.SOCIOMEM_ENABLE_SEND, key: stickerId, confirmation });
      const groupId = resolveGroup({ required: true });
      const account = await onlineAccount();
      const client = openClient(account);
      const db = openDatabase();
      try {
        const result = await sendSticker({ db, client, account, groupId, stickerId,
          key: option('--key'), signal: AbortSignal.timeout(30000) });
        console.log(JSON.stringify(result));
        if (!['sent', 'pending_receipt'].includes(result.state)) process.exitCode = 1;
      } finally { db.close(); }
    }
  } else if (command === 'status') {
    const key = positional[0];
    if (!key) usage();
    else {
      const account = await onlineAccount();
      const client = openClient(account);
      const db = openDatabase();
      try {
        const result = await reconcileStickerSend({ db, client, key, signal: AbortSignal.timeout(30000) });
        console.log(JSON.stringify(result));
        if (!['sent', 'pending_receipt'].includes(result.state)) process.exitCode = 1;
      } finally { db.close(); }
    }
  } else if (command === 'review') {
    const [subcommand, ...reviewArgs] = args;
    const reviewValue = name => {
      const index = reviewArgs.indexOf(name);
      return index >= 0 ? reviewArgs[index + 1] : undefined;
    };
    const reviewPositional = reviewArgs.filter((value, index) => !value.startsWith('--') &&
      !['--state', '--group', '--limit', '--context', '--summary'].includes(reviewArgs[index - 1]));
    const stickerId = reviewPositional[0];
    const db = openDatabase();
    try {
      if (subcommand === 'list') {
        const state = reviewValue('--state') ?? 'needs_review';
        const groupId = reviewValue('--group') ?? (configuredGroups.length === 1 ? configuredGroups[0] : null);
        if (groupId && configuredGroups.length && !configuredGroups.includes(groupId)) {
          throw new Error('Group is not in SOCIOMEM_WECHAT_GROUPS');
        }
        console.log(JSON.stringify(listStickerReview(db,
          { state, groupId, limit: Number(reviewValue('--limit') ?? 50) }), null, 2));
      } else if (subcommand === 'approve' || subcommand === 'reject') {
        if (!stickerId) usage();
        else console.log(JSON.stringify(setStickerReview(db,
          { stickerId, reviewState: subcommand === 'approve' ? 'saved' : 'rejected' })));
      } else if (subcommand === 'edit') {
        if (!stickerId) usage();
        else {
          const context = reviewValue('--context') ?? null;
          const summary = reviewValue('--summary') ?? null;
          if (context === null && summary === null) throw new Error('Specify --context or --summary');
          console.log(JSON.stringify(setStickerReview(db, { stickerId, context, summary })));
        }
      } else usage();
    } finally { db.close(); }
  } else usage();
} catch (error) {
  console.error(`sticker-send: ${error.message}`);
  process.exitCode = 1;
}
