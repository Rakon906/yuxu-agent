import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiaryStore } from '../packages/diary/index.mjs';
import { runDiaryCycle } from '../packages/diary/worker.mjs';
import { createAgentDiaryModel } from '../packages/diary/model.mjs';
import { openIntimacyStore } from '../packages/intimacy/index.mjs';
import { createIntimacyJudgeModel, judgeIntimacy, recoverDiaryIntimacyJobs,
  retryPendingIntimacy } from '../packages/intimacy/judge.mjs';
import { openMem0 } from '../packages/memory/index.mjs';
import { parseGroupAllowlist } from '../packages/wechat-adapter/real-config.mjs';
import { configureLocalMemory } from './local-memory-env.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const groups = parseGroupAllowlist(process.env.SOCIOMEM_WECHAT_GROUPS);
const model = createAgentDiaryModel();
const intimacyStore = openIntimacyStore();
configureLocalMemory();
const inboxPath = process.env.SOCIOMEM_WECHAT_DB ?? join(root, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const diaryPath = join(process.env.SOCIOMEM_DIARY_ROOT ?? join(root, '.runtime', 'diary'), 'diary.sqlite');
const pollMs = Number(process.env.SOCIOMEM_DIARY_POLL_MS ?? 30000);
const arguments_ = process.argv.slice(2);
const once = arguments_.includes('--once');
if (arguments_.some(argument => argument !== '--once')) throw new Error('Only --once is accepted');
if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new Error('SOCIOMEM_DIARY_POLL_MS must be at least 1000');
const db = new DatabaseSync(inboxPath, { readOnly: true });
let accountId;
try { accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value; }
finally { db.close(); }
if (!accountId) throw new Error('Authorized Inbox has no account ID');

const store = new DiaryStore(diaryPath);
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const log = (kind, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...details }));
let intimacyModel = null;
try { intimacyModel = createIntimacyJudgeModel(); }
catch (error) { log('intimacy_model_unavailable', { errorType: error.name }); }
let backoff = pollMs;
let consecutiveFailures = 0;
try {
  const memory = await openMem0();
  log('ready', { accountId, groups, inboxPath, diaryPath, sendingEnabled: false,
    modelProvider: process.env.SOCIOMEM_DIARY_PROVIDER ?? 'ollama',
    diaryTrigger: 'capacity', maxAgeMs: Number(process.env.SOCIOMEM_DIARY_MAX_AGE_MS ?? 0) });
  while (!abort.signal.aborted) {
    try {
      const queued = recoverDiaryIntimacyJobs({ store: intimacyStore, diaryPath, inboxPath,
        accountId, groupIds: groups });
      if (queued) log('intimacy_recovered', { queued });
      if (intimacyModel) {
        for (const result of await retryPendingIntimacy({ model: intimacyModel, store: intimacyStore,
          inboxPath, accountId, groupIds: groups, limit: 1 })) {
          log('intimacy_retry', { segmentId: result.segmentId, groupId: result.groupId,
            state: result.queueState, applied: result.applied.length,
            errorType: result.modelError?.name ?? null });
        }
      }
      const results = await runDiaryCycle({ store, memory, model, inboxPath, accountId, groups,
        triggerTokens: Number(process.env.SOCIOMEM_DIARY_TRIGGER_TOKENS ?? 120000),
        maxBatchTokens: Number(process.env.SOCIOMEM_DIARY_BATCH_TOKENS ?? 30000),
        maxCycleTokens: Number(process.env.SOCIOMEM_DIARY_CYCLE_TOKENS ?? 120000),
        maxAgeMs: Number(process.env.SOCIOMEM_DIARY_MAX_AGE_MS ?? 0),
        maxSegmentsPerGroup: Number(process.env.SOCIOMEM_DIARY_MAX_SEGMENTS_PER_CYCLE ?? 10),
        onIntimacy: intimacyModel ? ({ accountId: diaryAccountId, groupId, batch, diary,
          segmentId, now }) => judgeIntimacy({ model: intimacyModel, store: intimacyStore,
          inboxPath, accountId: diaryAccountId, groupId, batch, diary, segmentId, now }) : null });
      for (const result of results) if (result.status === 'written') {
        log('diary_written', { groupId: result.groupId, segmentId: result.id,
          sources: result.sources, coreUpdates: result.coreUpdates,
          attempts: result.attempts, reusedPreview: result.reusedPreview,
          intimacy: result.intimacy ? {
            applied: result.intimacy.applied?.length ?? 0,
            decayed: result.intimacy.decayed?.length ?? 0,
            modelError: result.intimacy.modelError?.name ?? null,
          } : null });
      }
      backoff = pollMs;
      consecutiveFailures = 0;
    } catch (error) {
      consecutiveFailures++;
      log('diary_error', { errorType: error.name, errorCode: error.code ?? null,
        message: error.message, consecutiveFailures });
      backoff = Math.min(backoff * 2, 600000);
      if (once || ['DIARY_OUTPUT_LIMIT', 'DIARY_VALIDATION_FAILED'].includes(error.code) ||
          consecutiveFailures >= 3) {
        process.exitCode = 1;
        if (!once) log('stopped_after_errors', { consecutiveFailures, errorCode: error.code ?? null });
        break;
      }
    }
    if (once) break;
    try { await delay(backoff, undefined, { signal: abort.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
} finally { intimacyStore.close(); store.close(); log('stopped'); }
