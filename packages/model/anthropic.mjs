import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultAnthropicUsagePath = join(projectRoot, '.runtime', 'metrics', 'anthropic-requests.jsonl');
const defaultVersion = '2023-06-01';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function anthropicKey() {
  if (process.env.SOCIOMEM_ANTHROPIC_API_KEY?.trim()) return process.env.SOCIOMEM_ANTHROPIC_API_KEY.trim();
  if (process.env.ANTHROPIC_API_KEY?.trim()) return process.env.ANTHROPIC_API_KEY.trim();
  const filename = process.env.SOCIOMEM_ANTHROPIC_KEY_FILE ??
    join(projectRoot, '.runtime', 'secrets', 'opencode-go-api-key');
  return existsSync(filename) ? readFileSync(filename, 'utf8').trim() : undefined;
}

export function anthropicMessagesUrl({ baseURL, endpoint } = {}) {
  let url;
  if (endpoint) url = new URL(endpoint);
  else {
    if (typeof baseURL !== 'string' || !baseURL.trim()) {
      throw new Error('SOCIOMEM_ANTHROPIC_BASE_URL or SOCIOMEM_ANTHROPIC_ENDPOINT is required');
    }
    const base = baseURL.trim().replace(/\/$/u, '');
    url = new URL(base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`);
  }
  if (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
    throw new Error('Anthropic endpoint requires HTTPS unless it is loopback');
  }
  return url;
}

function jsonText(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(text);
  return (fenced ? fenced[1] : text).trim();
}

function splitMessages(messages) {  const system = [];
  const conversation = [];
  for (const message of messages) {
    if (message.role === 'system') system.push(typeof message.content === 'string'
      ? message.content : JSON.stringify(message.content));
    else conversation.push({ role: message.role, content: message.content });
  }
  return { system: system.filter(Boolean).join('\n\n') || undefined, conversation };
}

function appendUsage(record) {
  const filename = process.env.SOCIOMEM_ANTHROPIC_USAGE_LOG ?? defaultAnthropicUsagePath;
  mkdirSync(dirname(filename), { recursive: true });
  appendFileSync(filename, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

export function createAnthropicJsonModel({ apiKey = anthropicKey(),
  model = process.env.SOCIOMEM_ANTHROPIC_MODEL,
  baseURL = process.env.SOCIOMEM_ANTHROPIC_BASE_URL,
  endpoint = process.env.SOCIOMEM_ANTHROPIC_ENDPOINT,
  auth = process.env.SOCIOMEM_ANTHROPIC_AUTH ?? 'x-api-key',
  version = process.env.SOCIOMEM_ANTHROPIC_VERSION ?? defaultVersion,
  sessionId = process.env.SOCIOMEM_ANTHROPIC_SESSION_ID,
  fetchImpl = fetch, onUsage = appendUsage } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/u.test(apiKey.trim())) {
    throw new Error('SOCIOMEM_ANTHROPIC_API_KEY or SOCIOMEM_ANTHROPIC_KEY_FILE is required');
  }
  if (typeof model !== 'string' || !model.trim()) throw new Error('SOCIOMEM_ANTHROPIC_MODEL is required');
  if (!['x-api-key', 'bearer'].includes(auth)) throw new Error('SOCIOMEM_ANTHROPIC_AUTH must be x-api-key or bearer');
  const secret = apiKey.trim();
  const url = anthropicMessagesUrl({ baseURL, endpoint });
  const headers = { 'content-type': 'application/json', 'anthropic-version': version,
    'user-agent': process.env.SOCIOMEM_ANTHROPIC_USER_AGENT ?? 'sociomem-agent/0.1',
    ...(auth === 'bearer' ? { authorization: `Bearer ${secret}` } : { 'x-api-key': secret }) };
  return async ({ component, messages, maxTokens, temperature = 0, timeoutMs = 180000, signal }) => {
    const session = sessionId ?? `sociomem-${component}`;
    if (typeof session !== 'string' || !session.trim() || /[\r\n]/u.test(session)) {
      throw new Error('Invalid SOCIOMEM_ANTHROPIC_SESSION_ID');
    }
    const started = performance.now();
    const at = new Date().toISOString();
    const requestId = randomUUID();
    let response, payload, errorName = null;
    try {
      signal?.throwIfAborted();
      const { system, conversation } = splitMessages(messages);
      response = await fetchImpl(url, { method: 'POST',
        headers: { ...headers, 'x-opencode-session': session },
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature,
          ...(system ? { system } : {}), messages: conversation }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
      try { payload = await response.json(); } catch { payload = null; }
      if (!response.ok) {
        const type = payload?.error?.type ?? payload?.error?.code ?? 'http_error';
        const detail = typeof payload?.error?.message === 'string'
          ? `: ${payload.error.message.slice(0, 200)}` : '';
        throw new Error(`Anthropic ${component} request failed: HTTP ${response.status} ${type}${detail}`);
      }
      const stop = payload?.stop_reason;
      if (stop === 'max_tokens') {
        const error = new Error(`Anthropic ${component} response incomplete: max_tokens`);
        error.code = 'DIARY_OUTPUT_LIMIT';
        throw error;
      }
      const text = Array.isArray(payload?.content)
        ? payload.content.filter(block => block?.type === 'text' && typeof block.text === 'string')
          .map(block => block.text).join('') : '';
      if (!text.trim()) throw new Error(`Anthropic ${component} response incomplete: ${stop ?? 'missing'}`);
      try { return JSON.parse(jsonText(text)); }
      catch { throw new Error(`Anthropic ${component} response is not valid JSON`); }
    } catch (error) { errorName = error.name; throw error; }
    finally {
      const inputTokens = count(payload?.usage?.input_tokens);
      const outputTokens = count(payload?.usage?.output_tokens);
      try { onUsage({ schemaVersion: 1, at, requestId, component, provider: 'anthropic',
        service: url.hostname === 'opencode.ai' ? 'opencode' : 'anthropic-compatible',
        execution: ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ? 'local' : 'remote',
        modelRequested: model,
        modelReturned: typeof payload?.model === 'string' ? payload.model : null,
        httpStatus: response?.status ?? null, finishReason: payload?.stop_reason ?? null,
        elapsedMs: Math.round(performance.now() - started), inputTokens, outputTokens,
        totalTokens: inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null,
        cacheHitTokens: count(payload?.usage?.cache_read_input_tokens), errorName }); }
      catch (error) { process.stderr.write(`Anthropic usage recording failed: ${error.name}\n`); }
    }
  };
}
