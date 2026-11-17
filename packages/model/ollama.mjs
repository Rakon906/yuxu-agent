import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultOllamaModel = 'qwen3.6:35b-a3b-mtp-q4_K_M';
export const defaultOllamaUsagePath = join(fileURLToPath(new URL('../../', import.meta.url)),
  '.runtime', 'metrics', 'ollama-requests.jsonl');

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

function appendUsage(record) {
  const filename = process.env.SOCIOMEM_OLLAMA_USAGE_LOG ?? defaultOllamaUsagePath;
  mkdirSync(dirname(filename), { recursive: true });
  appendFileSync(filename, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function createOllamaJsonModel({
  model = process.env.SOCIOMEM_OLLAMA_MODEL ?? defaultOllamaModel,
  baseURL = process.env.SOCIOMEM_OLLAMA_BASE_URL ?? 'http://127.0.0.1:11436',
  fetchImpl = fetch,
  onUsage = appendUsage,
} = {}) {
  if (typeof model !== 'string' || !model.trim()) throw new Error('SOCIOMEM_OLLAMA_MODEL is required');
  const url = new URL('api/chat', `${baseURL.replace(/\/$/u, '')}/`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Ollama URL');
  return async ({ component, messages, maxTokens, temperature = 0, timeoutMs = 180000, signal }) => {
    const started = performance.now();
    let response, payload, errorName = null;
    try {
      signal?.throwIfAborted();
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, messages, stream: false, think: false, format: 'json',
          options: { temperature, num_predict: maxTokens } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`Ollama ${component} request failed: HTTP ${response.status}`);
      payload = await response.json();
      if (payload.done_reason !== 'stop' || typeof payload.message?.content !== 'string' ||
          !payload.message.content.trim()) {
        const error = new Error(`Ollama ${component} response incomplete: ${payload.done_reason ?? 'missing'}`);
        if (payload.done_reason === 'length') error.code = 'DIARY_OUTPUT_LIMIT';
        throw error;
      }
      try { return JSON.parse(payload.message.content); }
      catch { throw new Error(`Ollama ${component} response is not valid JSON`); }
    } catch (error) { errorName = error.name; throw error; }
    finally {
      try { onUsage({ at: new Date().toISOString(), component, provider: 'ollama',
        modelRequested: model, modelReturned: payload?.model ?? null, httpStatus: response?.status ?? null,
        finishReason: payload?.done_reason ?? null, elapsedMs: Math.round(performance.now() - started),
        inputTokens: count(payload?.prompt_eval_count), outputTokens: count(payload?.eval_count), errorName }); }
      catch (error) { process.stderr.write(`Ollama usage recording failed: ${error.name}\n`); }
    }
  };
}
