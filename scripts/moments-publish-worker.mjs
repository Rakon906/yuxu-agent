import { execFile as execFileCallback } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createAnthropicJsonModel } from '../packages/model/anthropic.mjs';
import { createOllamaJsonModel } from '../packages/model/ollama.mjs';
import { generatePicture, generateSelfie } from '../packages/selfie/index.mjs';
import { selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { prepareMomentImage } from '../packages/moments/publish-assets.mjs';
import { NativeMomentsPublisher } from '../packages/moments/publish-native.mjs';
import { MomentsPublishStore, MomentsPublishService } from '../packages/moments/publish-service.mjs';
import { MomentsPublishingSchedule } from '../packages/moments/publishing-schedule.mjs';
import { buildMomentPublishingCandidates, createMomentPublishingPlanner, readMomentPublishingTrendRows } from '../packages/moments/publishing-content.mjs';
import { runPublishingCycle } from '../packages/moments/publishing-runner.mjs';
import { projectRoot } from './runtime.mjs';
import { cachedOnlineCheck, onlineCheckInterval } from '../packages/supervisor/online-check.mjs';

const env = process.env;
const directory = join(projectRoot, '.runtime', 'moments');
const configPath = env.SOCIOMEM_MOMENTS_PUBLISH_CONFIG ?? join(directory, 'publishing-config.json');
const schedulePath = env.SOCIOMEM_MOMENTS_PUBLISH_SCHEDULE ?? join(directory, 'publishing.sqlite');
const publicationPath = env.SOCIOMEM_MOMENTS_PUBLISH_LEDGER ?? join(directory, 'publish.sqlite');
const trendPath = env.SOCIOMEM_TRENDS_DB ?? join(projectRoot, '.runtime', 'trends', 'trends.sqlite');
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const wx = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';
const execFile = promisify(execFileCallback);
const log = (kind, detail = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...detail }));

export function readPublishingConfig(filename = configPath) {
  if (!existsSync(filename)) return { enabled: false };
  const value = JSON.parse(readFileSync(filename, 'utf8').replace(/^\ufeff/u, ''));
  if (!value || typeof value !== 'object' || typeof value.enabled !== 'boolean') throw new Error('Invalid publishing configuration');
  if (!value.enabled) return { enabled: false };
  for (const field of ['accountId', 'selfUserId']) {
    if (typeof value[field] !== 'string' || !/^[\w.-]{1,200}$/u.test(value[field])) throw new Error('Publishing account binding is required');
  }
  if (value.visibility !== 'friends') throw new Error('Automatic publishing requires explicit friends visibility');
  if (value.imageAcceptance !== 'verified-on-phone') throw new Error('Image publication has not passed phone acceptance');
  return { enabled: true, accountId: value.accountId, selfUserId: value.selfUserId, visibility: 'friends' };
}

/** Recheck the switch at each actual HTTP boundary, including upload -> publish.
 * A request already sent may finish; it is never retried after cancellation.
 */
export function createPublishingFetchGate({ readConfig, binding, stopping = () => false,
  stopSignal, readToken, expectedToken, fetchImpl = fetch } = {}) {
  if (typeof readConfig !== 'function' || typeof fetchImpl !== 'function' ||
      !binding?.accountId || !binding?.selfUserId ||
      expectedToken !== undefined && (typeof expectedToken !== 'string' || !expectedToken || typeof readToken !== 'function')) {
    throw new Error('Invalid publishing fetch gate');
  }
  return async (url, options = {}) => {
    let current;
    try { current = readConfig(); } catch { current = null; }
    if (stopping() || stopSignal?.aborted || current?.enabled !== true ||
        current.accountId !== binding.accountId || current.selfUserId !== binding.selfUserId) {
      const error = new Error('Publishing was disabled, stopped or rebound before request');
      error.name = 'PublishingStoppedError';
      throw error;
    }
    if (expectedToken !== undefined) {
      let token;
      try { token = readToken(); } catch { token = null; }
      if (token !== expectedToken) {
        const error = new Error('Daemon credentials changed before request');
        error.name = 'PublishingTokenChangedError';
        throw error;
      }
    }
    const signals = [options.signal, stopSignal].filter(Boolean);
    return fetchImpl(url, { ...options, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}) });
  };
}

export async function startMomentsPublishingWorker({ args = process.argv.slice(2) } = {}) {
const readConfig = () => readPublishingConfig(configPath);
if (args.includes('--check')) {
  const config = readConfig();
  let jobs = [];
  if (existsSync(schedulePath) && config.accountId) {
    const db = new DatabaseSync(schedulePath, { readOnly: true });
    try {
      jobs = db.prepare(`SELECT id,state,reason,due_at,attempted_at,moment_id FROM moments_publishing_jobs
        WHERE account_id=? ORDER BY created_at DESC LIMIT 10`).all(config.accountId);
    } finally { db.close(); }
  }
  log('moments.publishing_status', { config, jobs });
  return;
}

mkdirSync(directory, { recursive: true });
mkdirSync(dirname(schedulePath), { recursive: true });
const ownerPath = `${schedulePath}.owner`;
// Startup/supervisor checks a stale PID and the exact script path before repairing
// this lock. A second live worker must never recover the first worker's jobs.
const owner = openSync(ownerPath, 'wx');
writeSync(owner, String(process.pid));
let schedule, store, service, boundAccount = null, model = null;
let stopping = false, previousState = '';
const abort = new AbortController();
const stop = () => { stopping = true; abort.abort(); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
const onlineIntervalMs = onlineCheckInterval(env.SOCIOMEM_ONLINE_CHECK_MS);
const checkAccountOnline = cachedOnlineCheck(async () => {
  const config = readConfig();
  if (stopping || !config.enabled || config.accountId !== boundAccount?.accountId || config.selfUserId !== boundAccount?.selfUserId) return false;
  const { stdout } = await execFile(wx, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true });
  const account = selectOnlineAccount(JSON.parse(stdout).items, { accountId: config.accountId });
  if (account.accountId !== config.accountId || account.selfUserId !== config.selfUserId) return false;
  const current = readConfig();
  if (stopping || !current.enabled || current.accountId !== config.accountId || current.selfUserId !== config.selfUserId) return false;
  const token = readFileSync(tokenPath, 'utf8').trim();
  service.gateway = new NativeMomentsPublisher({ baseUrl, token, accountId: config.accountId,
    selfUserId: config.selfUserId, fetchImpl: guardedFetch(config, token) });
  return true;
}, { intervalMs: onlineIntervalMs });


function getModel() {
  if (model) return model;
  const provider = env.SOCIOMEM_MOMENTS_PUBLISH_PROVIDER ?? env.SOCIOMEM_MOMENTS_PROVIDER ?? 'ollama';
  const fetchImpl = guardedFetch(boundAccount);
  if (provider === 'anthropic') model = createAnthropicJsonModel({ fetchImpl });
  else if (provider === 'ollama') model = createOllamaJsonModel({ fetchImpl });
  else throw new Error('Unsupported Moments publishing model provider');
  return model;
}
function guardedFetch(binding, expectedToken) {
  return createPublishingFetchGate({ readConfig, binding, stopping: () => stopping, stopSignal: abort.signal,
    ...(expectedToken !== undefined ? { expectedToken, readToken: () => readFileSync(tokenPath, 'utf8').trim() } : {}) });
}
const plan = createMomentPublishingPlanner({ model: request => getModel()(request) });
const generate = async job => {
  if (!boundAccount || job.accountId !== boundAccount.accountId) throw new Error('Image job account mismatch');
  const options = { models: [env.SOCIOMEM_MOMENTS_PUBLISH_IMAGE_MODEL ?? 'gpt-6-luna'],
    fetchImpl: guardedFetch(boundAccount) };
  const image = job.imageKind === 'selfie'
    ? await generateSelfie({ ...options, scene: job.imagePrompt, component: 'moments_publish_image' })
    : await generatePicture({ ...options, prompt: job.imagePrompt, component: 'moments_publish_image' });
  const asset = await prepareMomentImage(image.path, { assetDir: join(directory, 'assets') });
  log('moments.publishing_image_ready', { jobId: job.id, model: image.model, bytes: asset.bytes, sha256: asset.sha256 });
  return asset;
};

try {
  log('ready', { component: 'moments-publishing', configPath, schedulePath, send: 'controlled-by-private-config', onlineCheckIntervalMs: onlineIntervalMs });
  do {
    try {
      const config = readConfig();
      if (config.enabled && !boundAccount) {
        const nextSchedule = new MomentsPublishingSchedule(schedulePath);
        let nextStore;
        try {
          nextStore = new MomentsPublishStore(publicationPath);
          const nextService = new MomentsPublishService({ store: nextStore, accountId: config.accountId, selfUserId: config.selfUserId });
          nextSchedule.recoverInterrupted(config.accountId);
          schedule = nextSchedule; store = nextStore; service = nextService; boundAccount = config;
        } catch (error) { nextStore?.close(); nextSchedule.close(); throw error; }
      }
      if (config.enabled && (config.accountId !== boundAccount.accountId || config.selfUserId !== boundAccount.selfUserId)) {
        throw new Error('Account configuration changed; restart the publishing worker');
      }
      const online = async options => {
        try {
          const current = readConfig();
          if (stopping || !current.enabled || current.accountId !== config.accountId || current.selfUserId !== config.selfUserId) return false;
          return await checkAccountOnline(options);
        } catch { return false; }
      };
      const now = Date.now();
      let candidates = [];
      if (config.enabled && schedule.assess(config.accountId).eligible) {
        const rows = existsSync(trendPath) ? readMomentPublishingTrendRows(trendPath, { now }) : [];
        const usedTopicKeys = schedule.list(config.accountId, { limit: 100 })
          .filter(job => job.attemptedAt !== null && job.attemptedAt > now - 7 * 86400000).map(job => job.topicKey);
        candidates = buildMomentPublishingCandidates(rows, { now, usedTopicKeys });
      }
      const result = await runPublishingCycle({ schedule, service, accountId: config.accountId,
        enabled: config.enabled, candidates, plan, generate, online, now: Date.now });
      const signature = JSON.stringify([result.state, result.reason, result.job?.id]);
      if (signature !== previousState || Object.values(result.calls ?? {}).some(value => value > 0)) {
        log('moments.publishing_cycle', { state: result.state, reason: result.reason,
          jobId: result.job?.id, dueAt: result.job?.dueAt, calls: result.calls });
        previousState = signature;
      }
    } catch (error) {
      log('moments.publishing_error', { errorName: error.name });
    }
    if (args.includes('--once') || stopping) break;
    await delay(60000, undefined, { signal: abort.signal }).catch(error => { if (error.name !== 'AbortError') throw error; });
  } while (!stopping);
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  try { store?.close(); }
  finally {
    try { schedule?.close(); }
    finally {
      closeSync(owner);
      try { if (readFileSync(ownerPath, 'utf8').trim() === String(process.pid)) unlinkSync(ownerPath); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
}
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const currentFile = fileURLToPath(import.meta.url);
if (process.platform === 'win32' ? entry.toLowerCase() === currentFile.toLowerCase() : entry === currentFile) {
  await startMomentsPublishingWorker();
}
