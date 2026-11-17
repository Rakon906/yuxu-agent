import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultImageUsagePath = join(fileURLToPath(new URL('../../', import.meta.url)),
  '.runtime', 'metrics', 'image-requests.jsonl');

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export function appendImageUsage(record) {
  const filename = process.env.SOCIOMEM_IMAGE_USAGE_LOG ?? defaultImageUsagePath;
  mkdirSync(dirname(filename), { recursive: true });
  appendFileSync(filename, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
}

/** One row per actual Responses request, not one row per generated image/tool result. */
export function recordImageUsage({ at, requestId, operationId, attempt, component = 'image_generation',
  service, modelRequested, response, payload, elapsedMs, errorName = null, onUsage = appendImageUsage }) {
  const usage = payload?.usage;
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const tools = Array.isArray(payload?.output)
    ? payload.output.filter(item => item?.type === 'image_generation_call') : [];
  const record = { schemaVersion: 1, at, requestId, operationId, attempt,
    provider: 'image', service: service ?? 'openai-compatible', execution: 'remote', component,
    modelRequested, modelReturned: typeof payload?.model === 'string' ? payload.model : null,
    httpStatus: response?.status ?? null, finishReason: payload?.status ?? null,
    elapsedMs: Math.round(elapsedMs), errorName,
    inputTokens, outputTokens,
    totalTokens: count(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null
      ? inputTokens + outputTokens : null),
    cacheHitTokens: count(usage?.input_tokens_details?.cached_tokens),
    imageToolCalls: tools.length,
    imagesReturned: tools.filter(item => typeof item.result === 'string' && item.result).length,
  };
  // Usage is diagnostic; a full disk or broken custom sink must not change an image result.
  try { onUsage(record); }
  catch (error) { process.stderr.write(`Image usage recording failed: ${error.name}\n`); }
}
