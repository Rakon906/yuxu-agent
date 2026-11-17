import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { defaultUsagePath as deepseekPath } from './deepseek-usage.mjs';
import { defaultOllamaUsagePath as ollamaPath } from '../model/ollama.mjs';
import { defaultAnthropicUsagePath as anthropicPath } from '../model/anthropic.mjs';
import { defaultImageUsagePath as imagePath } from './image-usage.mjs';

const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function readJsonLines(filename, provider) {
  if (!filename || !existsSync(filename)) return [];
  return readFileSync(filename, 'utf8').split(/\r?\n/u).filter(Boolean).map((line, index) => {
    let record;
    try { record = JSON.parse(line); }
    catch { throw new Error(`Invalid ${provider} usage log at line ${index + 1}`); }
    if (!record || typeof record !== 'object' || !Number.isFinite(Date.parse(record.at))) {
      throw new Error(`Invalid ${provider} usage record at line ${index + 1}`);
    }
    // New files can be intentionally shared by sinks. Prefer a recognized row
    // provider, while old DeepSeek records without one retain the file default.
    return { ...record, provider: ['deepseek', 'ollama', 'anthropic', 'image'].includes(record.provider)
      ? record.provider : provider };
  });
}

export function modelUsageSources({ deepseekFile = process.env.SOCIOMEM_API_USAGE_LOG ?? deepseekPath,
  ollamaFile = process.env.SOCIOMEM_OLLAMA_USAGE_LOG ?? ollamaPath,
  anthropicFile = process.env.SOCIOMEM_ANTHROPIC_USAGE_LOG ?? anthropicPath,
  imageFile = process.env.SOCIOMEM_IMAGE_USAGE_LOG ?? imagePath } = {}) {
  return { deepseek: deepseekFile, ollama: ollamaFile, anthropic: anthropicFile, image: imageFile };
}

export function readModelUsage(options = {}) {
  const seenFiles = new Set();
  return Object.entries(modelUsageSources(options)).flatMap(([provider, filename]) => {
    if (!filename || !existsSync(filename)) return [];
    const realPath = realpathSync(filename);
    const identity = process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    if (seenFiles.has(identity)) return [];
    seenFiles.add(identity);
    return readJsonLines(filename, provider);
  });
}

export function summarizeModelUsage(records, { since = -Infinity, last = 20 } = {}) {
  if (!(last === 'all' || (Number.isSafeInteger(last) && last >= 0))) throw new Error('Invalid last count');
  if (!(Number.isFinite(since) || since === -Infinity)) throw new Error('Invalid since time');
  const requestIds = new Set();
  let duplicateRecordsIgnored = 0;
  const selected = records.filter(row => {
    if (!row || Date.parse(row.at) < since || !Number.isFinite(Date.parse(row.at))) return false;
    // Only an explicit per-request ID proves a duplicate. Identical historical
    // rows/timestamps can represent separate calls and must not be collapsed.
    if (typeof row.requestId === 'string' && row.requestId) {
      const key = JSON.stringify([row.provider, row.requestId]);
      if (requestIds.has(key)) { duplicateRecordsIgnored++; return false; }
      requestIds.add(key);
    }
    return true;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const summary = Object.create(null);
  const modules = new Map();
  const executions = Object.create(null);
  const execution = row => ['local', 'remote'].includes(row.execution) ? row.execution
    : row.provider === 'ollama' ? 'local' : 'remote';
  const add = (group, row) => {
    group.requests++;
    if (token(row.inputTokens) === null || token(row.outputTokens) === null) group.unknownUsageRequests++;
    else group.measuredRequests++;
    if (token(row.inputTokens) !== null) { group.inputTokens += row.inputTokens; group.measuredInputRequests++; }
    if (token(row.outputTokens) !== null) { group.outputTokens += row.outputTokens; group.measuredOutputRequests++; }
    const total = token(row.totalTokens) ?? (token(row.inputTokens) !== null && token(row.outputTokens) !== null
      ? row.inputTokens + row.outputTokens : null);
    if (total !== null) { group.totalTokens += total; group.measuredTotalRequests++; }
    if (token(row.cacheHitTokens) !== null) { group.cacheHitTokens += row.cacheHitTokens; group.measuredCacheRequests++; }
    if (Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0) {
      group.totalElapsedMs += row.elapsedMs; group.measuredLatencyRequests++;
    }
    if (row.provider === 'image') {
      group.imageToolCalls += token(row.imageToolCalls) ?? 0;
      group.imagesReturned += token(row.imagesReturned) ?? 0;
    }
    if (row.errorName || (Number.isInteger(row.httpStatus) && row.httpStatus >= 400)) group.errorRequests++;
  };
  const fresh = () => ({ requests: 0, measuredRequests: 0, unknownUsageRequests: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cacheHitTokens: 0, errorRequests: 0,
    measuredInputRequests: 0, measuredOutputRequests: 0, measuredTotalRequests: 0,
    measuredCacheRequests: 0, measuredLatencyRequests: 0, totalElapsedMs: 0,
    imageToolCalls: 0, imagesReturned: 0 });
  const finish = group => ({ ...group, meanElapsedMs: group.measuredLatencyRequests
    ? Math.round(group.totalElapsedMs / group.measuredLatencyRequests) : null });
  for (const row of selected) {
    if (!summary[row.provider]) summary[row.provider] = fresh();
    add(summary[row.provider], row);
    const where = execution(row);
    if (!executions[where]) executions[where] = fresh();
    add(executions[where], row);
    const key = JSON.stringify([row.provider, row.service ?? null, row.component ?? 'unknown', row.modelReturned ?? row.modelRequested ?? null]);
    if (!modules.has(key)) modules.set(key, { provider: row.provider,
      service: row.service ?? null, execution: where, component: row.component ?? 'unknown',
      model: row.modelReturned ?? row.modelRequested ?? null, ...fresh() });
    add(modules.get(key), row);
  }
  const calls = (last === 'all' ? selected : last === 0 ? [] : selected.slice(-last)).map(row => ({
    at: row.at, provider: row.provider, service: row.service ?? null, execution: execution(row),
    component: row.component ?? 'unknown', requestId: row.requestId ?? null,
    model: row.modelReturned ?? row.modelRequested ?? null, operationId: row.operationId ?? null,
    attempt: row.attempt ?? 1, inputTokens: token(row.inputTokens),
    outputTokens: token(row.outputTokens),
    totalTokens: token(row.totalTokens) ?? (token(row.inputTokens) !== null &&
      token(row.outputTokens) !== null ? row.inputTokens + row.outputTokens : null),
    cacheHitTokens: token(row.cacheHitTokens),
    elapsedMs: Number.isFinite(row.elapsedMs) && row.elapsedMs >= 0 ? row.elapsedMs : null,
    httpStatus: row.httpStatus ?? null, finishReason: row.finishReason ?? null,
    errorName: row.errorName ?? null,
    imageToolCalls: token(row.imageToolCalls), imagesReturned: token(row.imagesReturned),
  }));
  return { totalRequests: selected.length, duplicateRecordsIgnored,
    providers: Object.fromEntries(Object.entries(summary).map(([name, group]) => [name, finish(group)])),
    executions: Object.fromEntries(Object.entries(executions).map(([name, group]) => [name, finish(group)])),
    modules: [...modules.values()].map(finish),
    displayedCalls: calls.length, calls };
}
