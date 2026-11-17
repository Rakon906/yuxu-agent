import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { createRuntime, prepareRun, projectRoot } from './runtime.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { PatProjector } from '../packages/wechat-adapter/pat-projection.mjs';
import { StickerProjector, STICKER_CONTEXTS } from '../packages/wechat-adapter/sticker-projection.mjs';
import { createStickerVision, imageMediaType, IMAGE_VISION_PROMPT, stickerVisionPrompt }
  from '../packages/model/vision.mjs';
import { createSenseVoiceTranscriber, createVoiceEnricher, voiceModelReady }
  from '../packages/voice/index.mjs';
import { createHarnessDraftHandler } from '../packages/wechat-adapter/harness-bridge.mjs';
import { capturePending } from '../packages/wechat-adapter/capture.mjs';
import { createSharedMediaEnricher } from '../packages/shared-media/index.mjs';
import { describeImageWithCache, initializeImageDescriptionCache }
  from '../packages/shared-media/image-description-cache.mjs';
import { parseGroupAllowlist, selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { DiaryStore, runDiary } from '../packages/diary/index.mjs';
import { createAgentDiaryModel } from '../packages/diary/model.mjs';
import { openMem0 } from '../packages/memory/index.mjs';

const execFile = promisify(execFileCallback);

const env = process.env;
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const baseUrl = env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174';
const groups = parseGroupAllowlist(env.SOCIOMEM_WECHAT_GROUPS);
const captureOnly = env.SOCIOMEM_CAPTURE_ONLY === '1';
const modelMode = env.SOCIOMEM_MODEL_MODE ?? 'test';
if (captureOnly && (env.SOCIOMEM_MEMORY_ENABLED === '1' || env.SOCIOMEM_DIARY_ENABLED === '1')) throw new Error('Capture-only mode cannot enable memory or diary processing');
if (env.SOCIOMEM_MEMORY_ENABLED === '1' && groups.length !== 1) throw new Error('Memory-enabled watcher requires exactly one authorized group');
const diaryEnabled = env.SOCIOMEM_DIARY_ENABLED === '1';
if (diaryEnabled && env.SOCIOMEM_MEMORY_ENABLED !== '1') throw new Error('Diary watcher requires the memory tool');
const diaryModel = diaryEnabled ? createAgentDiaryModel() : null;

function log(kind, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...details }));
}

async function accountFromCli() {
  let result;
  try {
    result = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'], { encoding: 'utf8', windowsHide: true });
  } catch (error) {
    throw new Error(`Unable to query Yuxu WeChat accounts: ${error.code ?? error.message}`);
  }
  let payload;
  try { payload = JSON.parse(result.stdout); }
  catch { throw new Error('Yuxu WeChat accounts response is not valid JSON'); }
  return selectOnlineAccount(payload.items, {
    accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID,
    alias: env.SOCIOMEM_WECHAT_ALIAS,
  });
}

const account = await accountFromCli();
const token = (await readFile(tokenPath, 'utf8')).trim();
if (!token || /[\r\n]/.test(token)) throw new Error('Local Yuxu WeChat API token is missing or invalid');

const run = captureOnly ? null : await prepareRun('wechat-real', { modelMode, reasoningEffort: env.SOCIOMEM_DEEPSEEK_REASONING ?? 'high' });
const storePath = env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const runtime = captureOnly ? null : createRuntime(run, {
  groupId: groups[0],
  accountId: account.accountId,
  modelMode,
  model: env.SOCIOMEM_DEEPSEEK_MODEL,
  maxTokens: env.SOCIOMEM_DEEPSEEK_MAX_TOKENS,
  memoryEnabled: env.SOCIOMEM_MEMORY_ENABLED === '1',
  wechatDbPath: storePath,
});
const client = new WeChatClient({ baseUrl, token, accountId: account.accountId });
const store = new AdapterStore(storePath, account.accountId);
initializeImageDescriptionCache(store.db);
const ownerGuard = setInterval(() => {
  if (!store.ownsLock()) {
    log('owner_lost', { pid: process.pid });
    process.exit(0);
  }
}, 10000);
ownerGuard.unref?.();
const patControlPath = join(dataDir, 'accounts', account.accountId, 'agent', 'control.sqlite');
let patProjector = null;
if (captureOnly && existsSync(patControlPath) && existsSync(join(dataDir, 'storage-key'))) {
  try { patProjector = new PatProjector({ dataDir,
    accountId: account.accountId, groupIds: groups, selfUserId: account.selfUserId, store }); }
  catch (error) { log('pat_projection_unavailable', { errorType: error.name }); }
}
let vision = null;
try {
  const visionProvider = env.SOCIOMEM_VISION_PROVIDER ?? 'ollama';
  vision = createStickerVision({ provider: visionProvider,
    onFallback: error => log('vision_fallback', { provider: 'ollama', errorType: error.name }) });
  log('vision_ready', { provider: visionProvider });
} catch (error) { log('vision_unavailable', { errorType: error.name }); }
let stickerProjector = null;
if (captureOnly && existsSync(patControlPath) && existsSync(join(dataDir, 'storage-key'))) {
  try {
    if (!vision) throw new Error('Vision unavailable');
    const prompt = stickerVisionPrompt(STICKER_CONTEXTS);
    stickerProjector = new StickerProjector({ dataDir, accountId: account.accountId,
      groupIds: groups, selfUserId: account.selfUserId, store,
      describe: ({ bytes }) => vision({ bytes, prompt }) });
  } catch (error) { log('sticker_projection_unavailable', { errorType: error.name }); }
}
const imageDir = join(projectRoot, '.runtime', 'images');
async function enrichImage(message) {
  mkdirSync(imageDir, { recursive: true });
  const temporary = join(imageDir,
    `${createHash('sha256').update(message.sourceMessageId).digest('hex').slice(0, 16)}-${process.pid}-${randomUUID().slice(0, 8)}.download`);
  rmSync(temporary, { force: true });
  try {
    await execFile(cliPath, ['--json', '--data-dir', dataDir, 'messages', 'media',
      message.groupId, message.sourceMessageId, '--output', temporary, '--wait', '30'],
      { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    const bytes = readFileSync(temporary);
    const extension = imageMediaType(bytes).split('/')[1].replace('jpeg', 'jpg');
    const described = await describeImageWithCache({ db: store.db, accountId: message.accountId,
      bytes, prompt: IMAGE_VISION_PROMPT, vision });
    const { sha256, description: { summary, visibleText, tone, safety, model } } = described;
    const filename = join(imageDir, `${sha256}.${extension}`);
    if (existsSync(filename)) {
      if (createHash('sha256').update(readFileSync(filename)).digest('hex') !== sha256) {
        throw new Error('Existing image cache bytes do not match their content hash');
      }
    } else writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    const text = safety === 'unsafe'
      ? '[群友发送图片；内容可能不适合在群里转述]'
      : `[群友发送图片；以下是看图描述，不是群友原话] ${summary || '画面暂时无法描述'}` +
        (visibleText ? `；图中文字：${visibleText}` : '') +
        (tone ? `；可能语气/用途：${tone}` : '');
    return { ...message, text, interaction: 'image', imageSummary: summary,
      imageVisibleText: visibleText, imageTone: tone, imageSafety: safety,
      imageSha256: sha256, imagePath: filename, imageModel: model,
      imageDescriptionProvenance: described.imageDescriptionProvenance };
  } finally {
    rmSync(temporary, { force: true });
  }
}
const transcriber = createSenseVoiceTranscriber();
const enrichVoice = createVoiceEnricher({ client, transcriber });
const enrichSharedMedia = createSharedMediaEnricher({ client,
  vision: vision ?? (async () => { throw new Error('Vision unavailable'); }), transcriber,
  ffmpegPath: env.SOCIOMEM_FFMPEG_PATH ?? join(projectRoot, '.tools/shared-media/ffmpeg.exe') });
const enrichImageLogged = async (message, signal) => {
  try { return await enrichImage(message); }
  catch (error) {
    log('image_failed', { sourceMessageId: message.sourceMessageId, errorType: error.name,
      errorMessage: String(error.message).slice(0, 300) });
    throw error;
  }
};
log('voice_ready', { model: voiceModelReady() ? 'sensevoice-small-int8' : 'missing' });
let diaryStore, adapter;
try {
  diaryStore = diaryEnabled ? new DiaryStore(join(env.SOCIOMEM_DIARY_ROOT ?? join(projectRoot, '.runtime', 'diary'), 'diary.sqlite')) : null;
  adapter = new WeChatAdapter({
    client,
    store,
    allowedGroups: groups,
    selfUserId: account.selfUserId,
    consumer: env.SOCIOMEM_WECHAT_CONSUMER ?? 'sociomem-real',
    sendingEnabled: false,
    enrichImage: enrichImageLogged,
    enrichVoice,
    enrichSharedMedia,
  });
} catch (error) {
  diaryStore?.close();
  store.close();
  await runtime?.close();
  throw error;
}
const handlers = captureOnly ? new Map() : new Map(groups.map(groupId => [
  groupId,
  createHarnessDraftHandler({ runtime, adapter, groupId }),
]));
const abort = new AbortController();
let drainQueue = Promise.resolve();
let diaryQueue = Promise.resolve();
let diaryMemory;
let diaryCircuitOpen = false;
let stopping = false;
let stickerQueue = Promise.resolve();
let stickerBusy = false;
let voiceQueue = Promise.resolve();
let voiceBusy = false;

const stop = () => {
  if (stopping) return;
  stopping = true;
  abort.abort();
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);

async function drainPending() {
  if (captureOnly) {
    await capturePending(adapter, groups, message => log('captured', {
      sourceMessageId: message.sourceMessageId, groupId: message.groupId,
    }));
    return;
  }
  await adapter.drain(async message => {
    const handler = handlers.get(message.groupId);
    if (!handler) throw new Error('Pending message belongs to a group outside the allowlist');
    const draft = await handler(message);
    log('draft', { sourceMessageId: message.sourceMessageId, state: draft?.state ?? null });
  });
}

async function retryVoice() {
  if (!captureOnly || typeof adapter.enrichVoice !== 'function') return;
  const failures = store.inboxVoiceFailures(5).filter(row => {
    const attempts = row.message.voiceAttempts ?? 0;
    const at = Date.parse(row.message.eventTime);
    return attempts < 3 && Number.isFinite(at) && Date.now() - at < 30 * 60000;
  });
  for (const row of failures) {
    try {
      const enriched = await adapter.enrichVoice(row.message, abort.signal);
      const next = { ...enriched, voiceAttempts: 0 };
      delete next.voiceError;
      delete next.voiceErrorMessage;
      store.updateInbox(row.id, next);
      log('voice_retry', { sourceId: row.id, status: 'done' });
    } catch (error) {
      store.updateInbox(row.id, { ...row.message,
        voiceAttempts: (row.message.voiceAttempts ?? 0) + 1,
        voiceError: error.name, voiceErrorMessage: error.message.slice(0, 300) });
      log('voice_retry', { sourceId: row.id, status: 'failed', errorType: error.name });
    }
  }
}

function queueDiary() {  if (!diaryEnabled || diaryCircuitOpen) return;
  diaryQueue = diaryQueue.catch(() => {}).then(async () => {
    diaryMemory ??= openMem0();
    for (const groupId of groups) {
      const result = await runDiary({ store: diaryStore, memory: await diaryMemory, model: diaryModel,
        inboxPath: storePath, accountId: account.accountId, groupId,
        triggerTokens: Number(env.SOCIOMEM_DIARY_TRIGGER_TOKENS ?? 120000),
        maxBatchTokens: Number(env.SOCIOMEM_DIARY_BATCH_TOKENS ?? 30000),
        maxAgeMs: Number(env.SOCIOMEM_DIARY_MAX_AGE_MS ?? 0) });
      if (result.status === 'written') log('diary_written', { groupId, segmentId: result.id,
        sources: result.sources, coreUpdates: result.coreUpdates });
    }
  }).catch(error => {
    log('diary_error', { errorType: error.name, errorCode: error.code ?? null,
      message: error.message });
    if (['DIARY_OUTPUT_LIMIT', 'DIARY_VALIDATION_FAILED'].includes(error.code)) {
      diaryCircuitOpen = true;
      log('diary_stopped_after_model_output', { errorCode: error.code });
    }
  });
}

log('ready', {
  accountId: account.accountId,
  alias: account.alias,
  baseUrl,
  groups,
  modelMode,
  captureOnly,
  cursor: store.cursor(),
  sendingEnabled: false,
  storePath,
});

const interval = setInterval(() => {
  drainQueue = drainQueue.catch(() => {}).then(drainPending).catch(error => {
    log('drain_error', { errorType: error.name, message: error.message });
  });
}, 250);
const patInterval = patProjector ? setInterval(() => {
  try {
    const count = patProjector.scan();
    if (count) log('pat_captured', { count });
  } catch (error) { log('pat_projection_error', { errorType: error.name }); }
}, 2000) : null;
const stickerInterval = stickerProjector ? setInterval(() => {
  if (stickerBusy) return;
  stickerBusy = true;
  stickerQueue = (async () => {
    const found = stickerProjector.scan();
    if (found) log('stickers_found', { count: found });
    for (let index = 0; index < 3; index++) {
      const result = await stickerProjector.processNext();
      if (!result) break;
      log('sticker_projection', result);
    }
    const reclassified = await stickerProjector.reclassifyNext();
    if (reclassified) log('sticker_reclassify', reclassified);
  })().catch(error => log('sticker_projection_error', { errorType: error.name }))
    .finally(() => { stickerBusy = false; });
}, 2000) : null;
const diaryInterval = diaryEnabled ? setInterval(queueDiary, 30000) : null;
const voiceInterval = captureOnly && typeof adapter.enrichVoice === 'function' ? setInterval(() => {
  if (voiceBusy) return;
  voiceBusy = true;
  voiceQueue = retryVoice().catch(error => log('voice_retry_error', { errorType: error.name }))
    .finally(() => { voiceBusy = false; });
}, 10000) : null;
if (voiceInterval) {
  voiceBusy = true;
  voiceQueue = retryVoice().catch(error => log('voice_retry_error', { errorType: error.name }))
    .finally(() => { voiceBusy = false; });
}
queueDiary();

try {
  await adapter.watch(abort.signal);
} finally {
  clearInterval(interval);
  if (patInterval) clearInterval(patInterval);
  if (stickerInterval) clearInterval(stickerInterval);
  if (voiceInterval) clearInterval(voiceInterval);
  if (diaryInterval) clearInterval(diaryInterval);
  stop();
  await drainQueue;
  await diaryQueue;
  await stickerQueue;
  await voiceQueue;
  const finalCursor = store.cursor();
  await runtime?.close();
  store.close();
  patProjector?.close();
  stickerProjector?.close();
  diaryStore?.close();
  log('stopped', { cursor: finalCursor });
}
