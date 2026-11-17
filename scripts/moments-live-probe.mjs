/**
 * Live, read-only probe of the Moments timeline on the currently signed-in
 * Yuxu WeChat account. Sends a handful of candidate request bodies and records
 * the raw replies so the schema can be determined without touching publishing.
 *
 * Run after rebuilding the native client and restarting the daemon:
 *   npm.cmd run moments:probe
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { projectRoot } from './runtime.mjs';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { runProbePlan, summarize, TIMELINE_CGI } from '../packages/moments/probe-plan.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';

const list = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true });
let payload;
try { payload = JSON.parse(list.stdout); }
catch { throw new Error('Yuxu WeChat accounts response is not valid JSON'); }
const account = selectOnlineAccount(payload.items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID,
  alias: env.SOCIOMEM_WECHAT_ALIAS,
});

const token = (await readFile(tokenPath, 'utf8')).trim();
const client = new MomentsDaemonClient({ baseUrl, token, accountId: account.accountId });

const results = await runProbePlan({ client, cgi: TIMELINE_CGI });
const at = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = join(projectRoot, '.runtime', 'moments');
await mkdir(outDir, { recursive: true });
const outFile = join(outDir, `probe-${at}.json`);
await writeFile(outFile, JSON.stringify({ at: new Date().toISOString(), accountId: account.accountId, results }, null, 2));

console.log(JSON.stringify({ outFile, probes: summarize(results) }, null, 2));
console.log('Full reply hex is in the file above. Share the printed outline; a decode with an object list means the timeline schema is reachable.');
