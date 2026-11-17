import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { parseGroupAllowlist, selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { openIntimacyStore, DEFAULT_INTIMACY } from '../packages/intimacy/index.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const args = process.argv.slice(2);
const command = args[0];
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const groups = parseGroupAllowlist(env.SOCIOMEM_WECHAT_GROUPS);
if (groups.length !== 1) throw new Error('Set SOCIOMEM_WECHAT_GROUPS to the authorized group');
const groupId = env.SOCIOMEM_GROUP_ID ?? groups[0];
const accountResult = await execFile(cliPath,
  ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true });
const account = selectOnlineAccount(JSON.parse(accountResult.stdout).items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID, alias: env.SOCIOMEM_WECHAT_ALIAS,
});
const store = openIntimacyStore();
const names = new Map();
try {
  const roster = JSON.parse((await execFile(cliPath,
    ['--json', '--data-dir', dataDir, 'groups', 'members', 'list', groupId, '--limit', '200'],
    { encoding: 'utf8', windowsHide: true })).stdout);
  for (const item of roster.items ?? []) {
    const name = item.roomDisplayName ?? item.displayName ?? item.mentionName;
    if (name) names.set(item.id, name);
  }
} catch { /* names are optional for display */ }
const withName = row => ({ ...row, name: names.get(row.userId) ?? null });
try {
  if (command === 'list') {
    console.log(JSON.stringify(store.list(account.accountId, groupId).map(withName), null, 2));
  } else if (command === 'ensure') {
    const ids = [...names.keys()].length ? [...names.keys()] : [];
    store.ensureMembers(account.accountId, groupId, ids);
    console.log(JSON.stringify({ ensured: ids.length }, null, 2));
  } else if (command === 'get' && args[1]) {
    console.log(JSON.stringify(withName({ userId: args[1],
      ...store.get(account.accountId, groupId, args[1]) }), null, 2));
  } else if (command === 'set' && args[1] && args[2] !== undefined) {
    const score = Number(args[2]);
    if (!Number.isFinite(score)) throw new Error('Score must be a number');
    const reason = args.slice(3).join(' ') || '手动调整';
    console.log(JSON.stringify(withName({ userId: args[1],
      ...store.setScore({ accountId: account.accountId, groupId, userId: args[1], score, reason }) }),
    null, 2));
  } else if (command === 'lock' && args[1]) {
    console.log(JSON.stringify(withName({ userId: args[1],
      ...store.lock({ accountId: account.accountId, groupId, userId: args[1], locked: true }) }),
    null, 2));
  } else if (command === 'unlock' && args[1]) {
    console.log(JSON.stringify(withName({ userId: args[1],
      ...store.lock({ accountId: account.accountId, groupId, userId: args[1], locked: false }) }),
    null, 2));
  } else if (command === 'reset' && args[1]) {
    console.log(JSON.stringify(withName({ userId: args[1],
      ...store.setScore({ accountId: account.accountId, groupId, userId: args[1],
        score: DEFAULT_INTIMACY, reason: '重置为初始值' }) }), null, 2));
  } else {
    throw new Error('Usage: node scripts/intimacy.mjs list|ensure|get <userId>|set <userId> <0-10> [reason]|lock <userId>|unlock <userId>|reset <userId>');
  }
} finally { store.close(); }
