import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultUsagePath = join(fileURLToPath(new URL('../../', import.meta.url)),
  '.runtime', 'metrics', 'deepseek-requests.jsonl');

export function operationDigest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function appendDeepSeekUsage(record) {
  const filename = process.env.SOCIOMEM_API_USAGE_LOG ?? defaultUsagePath;
  mkdirSync(dirname(filename), { recursive: true });
  appendFileSync(filename, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function recordDeepSeekRequest({ component, operationId, attempt = 1, modelRequested,
  response, payload, elapsedMs, errorName = null, onUsage = appendDeepSeekUsage }) {
  const usage = payload?.usage;
  const record = {
    schemaVersion: 1,
    at: new Date().toISOString(),
    component,
    operationId,
    attempt,
    modelRequested,
    modelReturned: typeof payload?.model === 'string' ? payload.model : null,
    httpStatus: response?.status ?? null,
    finishReason: payload?.choices?.[0]?.finish_reason ?? null,
    elapsedMs: Math.round(elapsedMs),
    errorName,
    inputTokens: token(usage?.prompt_tokens),
    outputTokens: token(usage?.completion_tokens),
    cacheHitTokens: token(usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens),
    cacheMissTokens: token(usage?.prompt_cache_miss_tokens),
    reasoningTokens: token(usage?.completion_tokens_details?.reasoning_tokens),
    totalTokens: token(usage?.total_tokens),
  };
  try { onUsage(record); }
  catch (error) {
    process.stderr.write(`DeepSeek usage recording failed: ${error.name}\n`);
  }
}

export function summarizeDeepSeekUsage(records) {
  const groups = new Map();
  for (const record of records) {
    if (!record || record.schemaVersion !== 1 || !['participation', 'diary'].includes(record.component)) continue;
    const key = `${record.component}:${record.modelRequested}`;
    if (!groups.has(key)) groups.set(key, { component: record.component,
      modelRequested: record.modelRequested, requests: 0, measuredRequests: 0,
      unknownUsageRequests: 0, operations: new Set(), inputTokens: 0, outputTokens: 0,
      cacheHitTokens: 0, cacheMissTokens: 0, reasoningTokens: 0,
      lengthResponses: 0, errorResponses: 0, totalElapsedMs: 0 });
    const group = groups.get(key);
    group.requests++;
    if (record.operationId) group.operations.add(record.operationId);
    if (record.inputTokens === null || record.outputTokens === null) group.unknownUsageRequests++;
    else group.measuredRequests++;
    for (const name of ['inputTokens', 'outputTokens', 'cacheHitTokens', 'cacheMissTokens', 'reasoningTokens']) {
      if (Number.isSafeInteger(record[name]) && record[name] >= 0) group[name] += record[name];
    }
    if (record.finishReason === 'length') group.lengthResponses++;
    if (record.errorName || (record.httpStatus !== null && record.httpStatus >= 400)) group.errorResponses++;
    if (Number.isFinite(record.elapsedMs) && record.elapsedMs >= 0) group.totalElapsedMs += record.elapsedMs;
  }
  return [...groups.values()].map(({ operations, totalElapsedMs, ...group }) => ({
    ...group, distinctOperations: operations.size,
    meanRequestsPerOperation: operations.size ? Number((group.requests / operations.size).toFixed(2)) : null,
    meanElapsedMs: group.requests ? Math.round(totalElapsedMs / group.requests) : null,
  }));
}
