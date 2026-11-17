import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { generatePicture } from '../packages/selfie/index.mjs';
import { summarizeModelUsage } from '../packages/telemetry/model-usage.mjs';

const png = await sharp({ create: { width: 2, height: 2, channels: 3,
  background: { r: 255, g: 255, b: 255 } } }).png().toBuffer();
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-image-usage-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const image = extra => ({ status: 'completed', model: 'actual-model', ...extra,
  output: [{ type: 'image_generation_call', result: png.toString('base64') }] });

test('image fallback records each request once, counts tool results separately, and preserves missing usage', async t => {
  const rows = [], requests = [];
  const result = await generatePicture({ prompt: 'synthetic-private-prompt', apiKey: 'synthetic-private-key',
    outputDir: fixture(t), component: 'moments_publish_image', models: ['blocked', 'available'], onUsage: row => rows.push(row),
    fetchImpl: async (url, options) => {
      requests.push(JSON.parse(options.body).model);
      return requests.length === 1 ? { ok: false, status: 403, json: async () => ({}) }
        : { ok: true, status: 200, json: async () => image({ usage: { input_tokens: 25,
          output_tokens: 50, total_tokens: 75, input_tokens_details: { cached_tokens: 5 } } }) };
    } });
  assert.equal(result.model, 'available');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].operationId, rows[1].operationId);
  assert.notEqual(rows[0].requestId, rows[1].requestId);
  assert.equal(rows[0].inputTokens, null);
  assert.equal(rows[0].errorName, 'Error');
  assert.equal(rows[1].attempt, 2);
  assert.equal(rows[1].component, 'moments_publish_image');
  assert.equal(rows[1].imagesReturned, 1);
  assert.equal(rows[1].modelReturned, 'actual-model');
  assert.equal(rows[1].cacheHitTokens, 5);
  assert.ok(!JSON.stringify(rows).includes('synthetic-private'));
  assert.ok(!JSON.stringify(rows).includes(png.toString('base64')));
  const report = summarizeModelUsage(rows);
  assert.equal(report.totalRequests, 2);
  assert.equal(report.providers.image.totalTokens, 75);
  assert.equal(report.providers.image.unknownUsageRequests, 1);
  assert.equal(report.providers.image.errorRequests, 1);
});

test('image network failure is logged once and not silently retried', async t => {
  const rows = [];
  await assert.rejects(generatePicture({ prompt: 'plain picture', apiKey: 'test-key', outputDir: fixture(t),
    models: ['one', 'two'], onUsage: row => rows.push(row),
    fetchImpl: async () => { const error = new Error('synthetic timeout'); error.name = 'TimeoutError'; throw error; } }),
  /timeout/u);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].httpStatus, null);
  assert.equal(rows[0].errorName, 'TimeoutError');
  assert.equal(rows[0].inputTokens, null);
});

test('image response without usage stays unknown, and a failing telemetry sink does not discard the image', async t => {
  let recorded;
  const result = await generatePicture({ prompt: 'plain picture', apiKey: 'test-key', outputDir: fixture(t),
    models: ['one'], onUsage: row => { recorded = row; throw new Error('synthetic sink failure'); },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => image({}) }) });
  assert.ok(result.path.endsWith('.jpg'));
  assert.equal(recorded.totalTokens, null);
  assert.equal(recorded.cacheHitTokens, null);
  assert.equal(recorded.errorName, null);
});
