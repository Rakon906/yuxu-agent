import { runDiary } from './index.mjs';

export async function runDiaryCycle({ store, memory, model, inboxPath, accountId, groups,
  triggerTokens = 120000, maxBatchTokens = 30000, maxCycleTokens = 120000,
  maxAgeMs = 0, now = Date.now(), maxSegmentsPerGroup = 10, onIntimacy = null }) {
  if (!Array.isArray(groups) || !groups.length ||
      !Number.isSafeInteger(maxSegmentsPerGroup) || maxSegmentsPerGroup < 1 ||
      !Number.isSafeInteger(maxCycleTokens) || maxCycleTokens < 100) {
    throw new Error('Invalid diary worker configuration');
  }
  const results = [];
  for (const groupId of groups) {
    let consumed = 0;
    for (let segment = 0; segment < maxSegmentsPerGroup; segment++) {
      const remaining = maxCycleTokens - consumed;
      if (remaining < 100) break;
      const result = await runDiary({ store, memory, model, inboxPath, accountId, groupId,
        triggerTokens, maxBatchTokens: Math.min(maxBatchTokens, remaining),
        maxAgeMs, now, force: segment > 0, onIntimacy });
      results.push({ groupId, ...result });
      if (result.status !== 'written') break;
      consumed += result.estimatedTokens;
    }
  }
  return results;
}
