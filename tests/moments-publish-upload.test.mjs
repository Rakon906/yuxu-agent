import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { prepareMomentImage } from '../packages/moments/publish-assets.mjs';
import { NativeMomentsPublisher } from '../packages/moments/publish-native.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function assetFixture() {
  const parent = join(root, '.runtime', 'runs'); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(join(parent, 'moments-upload-test-'));
  const source = join(directory, 'source.png');
  await sharp({ create: { width: 32, height: 24, channels: 3, background: '#b5d8e9' } }).png().toFile(source);
  return prepareMomentImage(source, { assetDir: join(directory, 'assets') });
}
const options = { baseUrl: 'http://127.0.0.1:6174', token: 'test-token', accountId: 'test-account', selfUserId: 'wxid_test' };
const receipt = asset => ({ ok: true, accountId: options.accountId, sha256: asset.sha256, md5: asset.md5,
  bytes: asset.bytes, width: asset.width, height: asset.height, url: 'https://mmsns.qpic.cn/mmsns/test/0',
  thumbUrl: 'https://mmsns.qpic.cn/mmsns/test/150', urlType: 1, thumbType: 1 });

test('upload uses verified local JPEG bytes, captures receipt before acceptance and sends only once', async () => {
  const asset = await assetFixture(); const calls = []; const saved = [];
  const client = new NativeMomentsPublisher({ ...options, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(receipt(asset)), { status: 200 });
  } });
  const result = await client.uploadImage(asset, { onResponse: row => saved.push(row) });
  assert.equal(result.sha256, asset.sha256); assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${options.baseUrl}/v1/accounts/test-account/moments/upload-image`);
  assert.equal(calls[0].init.redirect, 'error');
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.sha256, asset.sha256);
  assert.equal(Buffer.from(body.imageBase64, 'base64').length, asset.bytes);
  assert.equal(saved.length, 1); assert.equal(saved[0].phase, 'upload');
  assert.equal(saved[0].responseBody.includes('test-token'), false);
});

test('tampered staged image is rejected before any upload', async () => {
  const asset = await assetFixture(); let calls = 0;
  writeFileSync(asset.path, Buffer.alloc(asset.bytes));
  const client = new NativeMomentsPublisher({ ...options, fetchImpl: () => { calls++; throw new Error('Must not request'); } });
  await assert.rejects(() => client.uploadImage(asset), /integrity/u);
  assert.equal(calls, 0);
});

test('wrong-account, missing media or wrong hash receipts are captured and cannot become uploaded media', async () => {
  const asset = await assetFixture();
  for (const changed of [{ accountId: 'other' }, { sha256: 'c'.repeat(64) }, { thumbUrl: '' }, { ok: false }]) {
    const saved = []; let calls = 0;
    const client = new NativeMomentsPublisher({ ...options, fetchImpl: async () => {
      calls++; return new Response(JSON.stringify({ ...receipt(asset), ...changed }));
    } });
    await assert.rejects(() => client.uploadImage(asset, { onResponse: row => saved.push(row) }));
    assert.equal(saved.length, 1); assert.equal(calls, 1);
  }
});

test('upload parse or storage failure never automatically resubmits', async () => {
  const asset = await assetFixture(); let calls = 0; const saved = [];
  const client = new NativeMomentsPublisher({ ...options, fetchImpl: async () => {
    calls++; return new Response('malformed');
  } });
  await assert.rejects(() => client.uploadImage(asset, { onResponse: row => saved.push(row) }));
  assert.equal(saved[0].responseBody, 'malformed'); assert.equal(calls, 1);
  const second = new NativeMomentsPublisher({ ...options, fetchImpl: async () => {
    calls++; return new Response(JSON.stringify(receipt(asset)));
  } });
  await assert.rejects(() => second.uploadImage(asset, { onResponse: () => { throw new Error('disk full'); } }), /disk full/u);
  assert.equal(calls, 2);
});
