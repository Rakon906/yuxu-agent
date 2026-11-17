import { execFile as execFileCallback } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { selectOnlineAccount, validateSendGate } from '../packages/wechat-adapter/real-config.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dbPath = process.env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const command = process.argv[2] ?? 'list';
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';

function readDatabase() {
  const db = new DatabaseSync(dbPath);
  try {
    const accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
    const rows = db.prepare('SELECT key,group_id,text,state,approved,attempted_at FROM outbox ORDER BY rowid').all();
    return { accountId, rows };
  } finally {
    db.close();
  }
}

function usage() {
  console.error('Usage: node scripts/drafts.mjs list | approve <draft-key> | send <draft-key> --confirm "SEND <draft-key>"');
  process.exitCode = 2;
}

async function onlineAccount() {
  const result = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true });
  const payload = JSON.parse(result.stdout);
  return selectOnlineAccount(payload.items, { accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID, alias: env.SOCIOMEM_WECHAT_ALIAS });
}

async function sendDraft(key, confirmation) {
  validateSendGate({ enabled: env.SOCIOMEM_ENABLE_SEND, key, confirmation });
  const { accountId, rows } = readDatabase();
  const row = rows.find(candidate => candidate.key === key);
  if (!row) throw new Error('Draft key was not found');
  if (row.approved !== 1) throw new Error('Draft must be approved before sending or reconciliation');
  if (!['draft', 'dispatching', 'queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled'].includes(row.state)) {
    throw new Error(`Draft is not sendable or reconcilable from state: ${row.state}`);
  }
  const account = await onlineAccount();
  const token = (await readFile(tokenPath, 'utf8')).trim();
  if (!token || /[\r\n]/.test(token)) throw new Error('Local Yuxu WeChat API token is missing or invalid');
  const client = new WeChatClient({ baseUrl, token, accountId: account.accountId });
  const store = new AdapterStore(dbPath, accountId);
  try {
    const adapter = new WeChatAdapter({
      client,
      store,
      allowedGroups: [row.group_id],
      selfUserId: account.selfUserId,
      consumer: env.SOCIOMEM_WECHAT_CONSUMER ?? 'sociomem-real',
      sendingEnabled: true,
    });
    const result = await adapter.sendApproved(key, AbortSignal.timeout(30000));
    const receipt = result.receipt ? JSON.parse(result.receipt) : null;
    console.log(JSON.stringify({ key, state: result.state, approved: result.approved, destination: row.group_id,
      receiptState: receipt?.state ?? null, sendId: receipt?.id ?? null }));
  } finally {
    store.close();
  }
}

try {
  if (command === 'list') {
    const { rows } = readDatabase();
    console.log(JSON.stringify(rows, null, 2));
  } else if (command === 'approve') {
    const key = process.argv[3];
    if (!key) { usage(); }
    else {
      const { accountId } = readDatabase();
      if (!accountId) throw new Error('Adapter database has no account identity');
      const store = new AdapterStore(dbPath, accountId);
      try {
        const row = store.approve(key);
        console.log(JSON.stringify({ key, state: row.state, approved: row.approved, sendingEnabled: false }));
      } finally {
        store.close();
      }
    }
  } else if (command === 'send') {
    const key = process.argv[3];
    const confirmIndex = process.argv.indexOf('--confirm');
    const confirmation = confirmIndex >= 0 ? process.argv[confirmIndex + 1] : undefined;
    if (!key) usage();
    else await sendDraft(key, confirmation);
  } else usage();
} catch (error) {
  console.error(`drafts: ${error.message}`);
  process.exitCode = 1;
}
