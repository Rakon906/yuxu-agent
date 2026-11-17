import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { createStickerVision } from '../packages/model/vision.mjs';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { createMomentsDecisionModel, isBusy, nextRunAt, claimScheduledRun, runMomentsCycle } from '../packages/moments/worker.mjs';
import { startRuntimeCommentReplies } from '../packages/moments/comment-reply-runtime.mjs';
import { runtimeSocialContext } from '../packages/moments/social-context.mjs';
import { MomentPersonMemory } from '../packages/moments/person-memory.mjs';
import { refreshMomentMemory } from '../packages/moments/person-memory-refresh.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';
const ledgerPath = env.SOCIOMEM_MOMENTS_LEDGER ?? join(projectRoot, '.runtime', 'moments', 'ledger.sqlite');
const inboxPath = env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const once = process.argv.includes('--once');
const send = env.SOCIOMEM_MOMENTS_SEND === '1';
const likeSend = env.SOCIOMEM_MOMENTS_LIKE_SEND === '1';
const commentSend = env.SOCIOMEM_MOMENTS_COMMENT_SEND === '1';
const visionEnabled = env.SOCIOMEM_MOMENTS_VISION !== '0';
const maxImagesPerRun = Number(env.SOCIOMEM_MOMENTS_MAX_IMAGES ?? 8);
const maxImagesPerMoment = Number(env.SOCIOMEM_MOMENTS_MAX_IMAGES_PER_MOMENT ?? 3);
const runsPerDay = Number(env.SOCIOMEM_MOMENTS_RUNS ?? 3);
const startHour = Number(env.SOCIOMEM_MOMENTS_START_HOUR ?? 12);
const endHour = Number(env.SOCIOMEM_MOMENTS_END_HOUR ?? 24);
const minGapMs = Number(env.SOCIOMEM_MOMENTS_MIN_GAP_MS ?? 2 * 3600000);
const limits = {
  maxAgeMs: Number(env.SOCIOMEM_MOMENTS_MAX_AGE_MS ?? 72 * 3600000),
  maxPosts: Number(env.SOCIOMEM_MOMENTS_MAX_POSTS ?? 10),
  maxLikesPerDay: env.SOCIOMEM_MOMENTS_MAX_LIKES === undefined
    ? Infinity : Number(env.SOCIOMEM_MOMENTS_MAX_LIKES),
  maxCommentsPerDay: Number(env.SOCIOMEM_MOMENTS_MAX_COMMENTS ?? 3),
  cooldownMs: Number(env.SOCIOMEM_MOMENTS_COOLDOWN_MS ?? 60000),
  busyMs: Number(env.SOCIOMEM_MOMENTS_BUSY_MS ?? 180000),
};
if (!Number.isInteger(runsPerDay) || runsPerDay < 1 || runsPerDay > 6) throw new Error('Invalid moments runs per day');
if (limits.maxLikesPerDay !== Infinity &&
    (!Number.isInteger(limits.maxLikesPerDay) || limits.maxLikesPerDay < 0)) {
  throw new Error('Invalid moments daily like limit');
}
if (!Number.isInteger(maxImagesPerRun) || maxImagesPerRun < 0 ||
    !Number.isInteger(maxImagesPerMoment) || maxImagesPerMoment < 0) {
  throw new Error('Invalid moments image budget');
}
if (!Number.isFinite(startHour) || !Number.isFinite(endHour) || startHour < 0 || endHour > 24 || startHour >= endHour) {
  throw new Error('Invalid moments window');
}

const list = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
  { encoding: 'utf8', windowsHide: true });
const account = selectOnlineAccount(JSON.parse(list.stdout).items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID,
  alias: env.SOCIOMEM_WECHAT_ALIAS,
});
const token = readFileSync(tokenPath, 'utf8').trim();
const client = new MomentsDaemonClient({ baseUrl, token, accountId: account.accountId });
const ledger = new MomentsLedger(ledgerPath);
const personMemory = new MomentPersonMemory(env.SOCIOMEM_MOMENT_MEMORY_DB ?? join(projectRoot, '.runtime/moments/person-memory.sqlite'));
const self = { id: account.selfUserId, name: env.SOCIOMEM_SELF_NAME ?? '肥鱼不肥' };
const officialCacheRoots = [
  env.SOCIOMEM_WECHAT_OFFICIAL_CACHE_ROOT,
  join(env.USERPROFILE ?? '', 'Documents', 'xwechat_files'),
  'D:\\微信\\微信记录\\xwechat_files',
].filter(Boolean);
const officialCacheRoot = officialCacheRoots.find(root => existsSync(root)) ?? null;
const officialCache = {
  enabled: env.SOCIOMEM_MOMENTS_OFFICIAL_CACHE !== '0' && Boolean(officialCacheRoot),
  accountRoot: officialCacheRoot,
  kvcommDir: env.SOCIOMEM_WECHAT_KVCOMM_DIR ??
    join(env.APPDATA ?? '', 'Tencent', 'xwechat', 'net', 'kvcomm'),
  wxid: self.id,
};
const model = createMomentsDecisionModel({
  provider: env.SOCIOMEM_MOMENTS_PROVIDER ?? (env.SOCIOMEM_ANTHROPIC_MODEL ? 'anthropic' : 'ollama'),
  lookupSocialContext: runtimeSocialContext({ root: projectRoot, accountId: account.accountId, selfId: self.id, env,
    onError: detail => ledger.trace('moments.social_memory_error', detail) }),
});
let vision = null;
if (visionEnabled) {
  try {
    vision = createStickerVision({ onFallback: error => console.error(JSON.stringify({
      at: new Date().toISOString(), kind: 'moments.vision_fallback', errorType: error.name })) });
  } catch (error) {
    console.error(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.vision_unavailable',
      errorType: error.name }));
  }
}

let stopping = false;
const stop = () => { stopping = true; };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'ready', ledger: ledgerPath,
  send, likeSend, commentSend, runsPerDay, startHour, endHour, vision: Boolean(vision),
  imageTransport: 'native-sns', officialCache: false, maxImagesPerRun, maxImagesPerMoment }));

async function cycle(now = Date.now()) {
  try {
    const refreshed = await refreshMomentMemory({ memory: personMemory, client, accountId: account.accountId, now, limit: 8 });
    if (refreshed.attempted) ledger.trace('moments.memory_refreshed', refreshed);
  } catch (error) { ledger.trace('moments.memory_refresh_error', { errorType: error.name }); }
  const summary = await runMomentsCycle({ ledger, client, model, self, now, send, likeSend,
    commentSend, limits, vision, visionEnabled: Boolean(vision), officialCache,
    maxImagesPerRun, maxImagesPerMoment,
    rememberMoment: (moment, proposals, now) => personMemory.record({ accountId: account.accountId, moment, proposals, now }) });
  console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.cycle',
    send, likeSend, commentSend, ...summary }));
  return summary;
}

if (once) {
  try { await cycle(); }
  finally { personMemory.close(); ledger.close(); }
  process.exit(0);
}

let replyMonitor = null;
try {
  replyMonitor = startRuntimeCommentReplies({ root: projectRoot, client, account,
    send, commentSend, legacyLedgerPath: ledgerPath,
    log: (kind, detail) => console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...detail })) });
} catch (error) {
  console.error(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.replies_start_error', error: error.message }));
}
process.on('SIGINT', () => { void replyMonitor?.stop(); });
process.on('SIGTERM', () => { void replyMonitor?.stop(); });

while (!stopping) {
  const now = Date.now();
  const next = nextRunAt(ledger, { now, runsPerDay, startHour, endHour, minGapMs });
  console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.scheduled',
    nextAt: new Date(next).toISOString(), send, likeSend, commentSend }));
  await delay(Math.max(1000, next - Date.now()));
  if (stopping) break;
  for (let attempt = 0; attempt < 3 && !stopping; attempt++) {
    if (!isBusy({ inboxPath, now: Date.now(), busyMs: limits.busyMs })) break;
    console.log(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.busy_deferred',
      attempt: attempt + 1 }));
    await delay(10 * 60000);
  }
  if (stopping) break;
  if (!claimScheduledRun(ledger, { scheduledAt: next, now: Date.now(), runsPerDay, startHour, endHour, minGapMs })) continue;
  try { await cycle(); }
  catch (error) {
    ledger.trace('moments.cycle_error', { errorType: error.name });
    console.error(JSON.stringify({ at: new Date().toISOString(), kind: 'moments.cycle_error',
      errorType: error.name }));
  }
}
await replyMonitor?.stop();
personMemory.close();
ledger.close();
