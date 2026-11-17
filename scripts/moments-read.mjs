import { execFile as execFileCallback } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { parseTimelineReply, timelineBody } from '../packages/moments/timeline.mjs';
import { readTimeline } from '../packages/moments/worker.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';

const args = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const integer = (value, fallback, name) => {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`Invalid ${name}`);
  return number;
};
const bigInteger = (value, fallback, name) => {
  if (value === undefined) return fallback;
  if (!/^\d{1,20}$/u.test(value)) throw new Error(`Invalid ${name}`);
  return BigInt(value);
};
const limit = integer(option('--limit'), 20, 'limit');
const maxId = bigInteger(option('--max-id'), 0n, 'max id');
const minId = bigInteger(option('--min-id'), 0n, 'min id');
const momentId = option('--id') ?? null;
const all = args.includes('--all');

const list = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
  { encoding: 'utf8', windowsHide: true });
const account = selectOnlineAccount(JSON.parse(list.stdout).items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID,
  alias: env.SOCIOMEM_WECHAT_ALIAS,
});
const token = readFileSync(tokenPath, 'utf8').trim();
const client = new MomentsDaemonClient({ baseUrl, token, accountId: account.accountId });
let timeline;
if (all) {
  timeline = await readTimeline({ client, now: Date.now(), maxAgeMs: 365 * 24 * 3600000 });
} else {
  const reply = await client.probe(211, timelineBody({ maxId, minId }), { withBaseRequest: true });
  if (reply.ok === false) throw new Error(reply.detail ?? 'Moments timeline probe failed');
  timeline = parseTimelineReply(reply.replyHex);
}
const objects = timeline.objects
  .filter(object => !momentId || String(object.id) === String(momentId))
  .slice(0, limit).map(object => ({
  ...object,
  media: (object.media ?? []).map(({ key, token, ...media }) => media),
  createdAt: object.createTime ? new Date(object.createTime * 1000).toISOString() : null,
}));
console.log(JSON.stringify({ accountId: account.accountId, firstPageMd5: timeline.firstPageMd5,
  count: timeline.count, pages: timeline.pages ?? 1, returned: objects.length, objects }, null, 2));
