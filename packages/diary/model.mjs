import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendDeepSeekUsage, operationDigest, recordDeepSeekRequest } from '../telemetry/deepseek-usage.mjs';
import { createOllamaJsonModel } from '../model/ollama.mjs';
import { createAnthropicJsonModel } from '../model/anthropic.mjs';

const skillUrl = new URL('../../skills/rolling-memory/SKILL.md', import.meta.url);
const projectRoot = new URL('../../', import.meta.url);

export function localDeepSeekKey() {
  if (process.env.DEEPSEEK_API_KEY?.trim()) return process.env.DEEPSEEK_API_KEY.trim();
  const filename = process.env.SOCIOMEM_DEEPSEEK_KEY_FILE ??
    join(fileURLToPath(projectRoot), '.runtime', 'secrets', 'deepseek-api-key');
  return existsSync(filename) ? readFileSync(filename, 'utf8').trim() : undefined;
}

export function diarySystemPrompt() {
  return readFileSync(skillUrl, 'utf8');
}

function diaryMessages({ messages, previousDiary, coreFacts, personHistory = [], retryFeedback = null }) {
  const userContent = JSON.stringify({
    task: '把这一段授权群消息整理成 JSON 日记和必要的核心事实更新',
    retryFeedback, previousDiary: previousDiary ?? null, coreFacts, personHistory, messages,
  });
  return [{ role: 'system', content: diarySystemPrompt() }, { role: 'user', content: userContent }];
}

function compactDiaryIds(input) {
  const originalByLabel = new Map();
  const compact = (items, prefix) => (items ?? []).map((item, index) => {
    const label = `${prefix}${index + 1}`;
    originalByLabel.set(label, item.id);
    return { ...item, id: label };
  });
  return {
    input: { ...input, messages: compact(input.messages, 'm'),
      personHistory: compact(input.personHistory, 'h') },
    restore(output) {
      if (!output || typeof output !== 'object') return output;
      const restoreRefs = item => item && typeof item === 'object' && Array.isArray(item.sourceMessageIds)
        ? { ...item, sourceMessageIds: item.sourceMessageIds.map(id => originalByLabel.get(id) ?? id) } : item;
      return { ...output,
        ...(output.diary && typeof output.diary === 'object' ? { diary: { ...output.diary,
          ...(Array.isArray(output.diary.events) ? { events: output.diary.events.map(restoreRefs) } : {}) } } : {}),
        ...(Array.isArray(output.coreUpdates)
          ? { coreUpdates: output.coreUpdates.map(restoreRefs) } : {}) };
    },
  };
}

export function createDeepSeekDiaryModel({
  apiKey = localDeepSeekKey(),
  model = process.env.SOCIOMEM_DIARY_MODEL ?? 'deepseek-flash',
  maxOutputTokens = Number(process.env.SOCIOMEM_DIARY_MAX_OUTPUT_TOKENS ?? 6000),
  thinkingMode = process.env.SOCIOMEM_DIARY_THINKING ?? 'disabled',
  baseURL = process.env.SOCIOMEM_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  fetchImpl = fetch,
  onUsage = appendDeepSeekUsage,
} = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/.test(apiKey.trim())) {
    throw new Error('DEEPSEEK_API_KEY is required for automatic diary generation');
  }
  const secret = apiKey.trim();
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1000 || maxOutputTokens > 8192) {
    throw new Error('SOCIOMEM_DIARY_MAX_OUTPUT_TOKENS must be 1000..8192');
  }
  if (!['disabled', 'enabled'].includes(thinkingMode)) {
    throw new Error('SOCIOMEM_DIARY_THINKING must be disabled or enabled');
  }
  const endpoint = new URL('chat/completions', `${baseURL.replace(/\/$/, '')}/`);
  return async input => {
    const { messages } = input;
    const requestMessages = diaryMessages(input);
    const started = performance.now();
    const operationId = operationDigest(['diary', messages.map(item => item.id)]);
    let response, payload, errorName = null;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, temperature: 0, thinking: { type: thinkingMode },
          max_tokens: maxOutputTokens, response_format: { type: 'json_object' },
          messages: requestMessages }),
        signal: AbortSignal.timeout(90000),
      });
      if (!response.ok) throw new Error(`DeepSeek diary request failed: HTTP ${response.status}`);
      payload = await response.json();
      const choice = payload.choices?.[0];
      if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim()) {
        const reason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : 'missing';
        const error = new Error(`DeepSeek diary response is incomplete or empty (finish_reason=${reason}, content_chars=${choice?.message?.content?.length ?? 0}, completion_tokens=${payload.usage?.completion_tokens ?? 'unknown'})`);
        if (reason === 'length') error.code = 'DIARY_OUTPUT_LIMIT';
        throw error;
      }
      try { return JSON.parse(choice.message.content); }
      catch { throw new Error('DeepSeek diary response is not valid JSON'); }
    } catch (error) { errorName = error.name; throw error; }
    finally { recordDeepSeekRequest({ component: 'diary', operationId,
      modelRequested: model, response, payload, elapsedMs: performance.now() - started, errorName, onUsage }); }
  };
}

export function createAgentDiaryModel({ provider = process.env.SOCIOMEM_DIARY_PROVIDER ?? 'ollama',
  fallback = process.env.SOCIOMEM_MODEL_FALLBACK ?? 'deepseek',
  ollama = createOllamaJsonModel(), anthropic = null } = {}) {
  if (!['ollama', 'deepseek', 'anthropic'].includes(provider)) throw new Error('Invalid diary provider');
  if (!['deepseek', 'none'].includes(fallback)) throw new Error('Invalid model fallback');
  if (provider === 'deepseek') return createDeepSeekDiaryModel();
  const model = provider === 'anthropic' ? anthropic ?? createAnthropicJsonModel() : ollama;
  const label = provider === 'anthropic' ? 'Anthropic' : 'Local';
  let deepseek;
  return async input => {
    const compact = compactDiaryIds(input);
    const initialOutput = Number(process.env.SOCIOMEM_DIARY_LOCAL_MAX_OUTPUT_TOKENS ?? 16000);
    const retryOutput = Number(process.env.SOCIOMEM_DIARY_LOCAL_RETRY_OUTPUT_TOKENS ?? 24000);
    if (!Number.isSafeInteger(initialOutput) || !Number.isSafeInteger(retryOutput) ||
        initialOutput < 1000 || retryOutput < initialOutput || retryOutput > 32768) {
      throw new Error('Invalid local diary output budgets');
    }
    try {
      let output;
      try {
        output = await model({ component: 'diary', messages: diaryMessages(compact.input),
          maxTokens: initialOutput, temperature: 0, timeoutMs: 300000 });
      } catch (error) {
        if (error.code !== 'DIARY_OUTPUT_LIMIT') throw error;
        output = await model({ component: 'diary', messages: diaryMessages(compact.input),
          maxTokens: retryOutput, temperature: 0, timeoutMs: 300000 });
      }
      return compact.restore(output);
    } catch (error) {
      if (error.code === 'DIARY_OUTPUT_LIMIT' || fallback !== 'deepseek' || !localDeepSeekKey()) throw error;
      process.stderr.write(`${label} diary model failed (${error.name}); using DeepSeek fallback\n`);
      deepseek ??= createDeepSeekDiaryModel();
      return deepseek(input);
    }
  };
}
