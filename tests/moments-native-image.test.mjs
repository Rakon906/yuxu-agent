import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { downloadNativeMomentImage, nativeImageEvidence } from '../packages/moments/native-image.mjs';
import { describeMomentMedia, validateMomentImage } from '../packages/moments/media.mjs';
import { MomentsLedger } from '../packages/moments/ledger.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const hash = (kind, bytes) => createHash(kind).update(bytes).digest('hex');
const client = { origin: 'http://127.0.0.1:6174', accountId: 'synthetic-account', token: 'synthetic-api-token' };
const media = { id: '456', type: 2, md5: 'a'.repeat(32), bytes: 123,
  url: 'https://mmsns.qpic.cn/mmsns/synthetic/0', key: 'sensitive-do-not-forward', token: 'sensitive-do-not-forward' };
function receipt(changes = {}) {
  return { ok: true, verifiedSource: 'authenticated-sns-media-v1', accountId: client.accountId,
    momentId: '123', mediaId: '456', imageBase64: png.toString('base64'),
    bytes: png.length, contentType: 'image/png', md5: hash('md5', png), sha256: hash('sha256', png),
    declaredMd5: media.md5, declaredBytes: media.bytes, declaredMd5Matches: false,
    declaredBytesMatch: false, ...changes };
}
const fetchReceipt = changes => async () => new Response(JSON.stringify(receipt(changes)), { status: 200 });

test('native request submits only identifiers and verifies variant bytes separately from XML metadata', async () => {
  let input;
  const image = await downloadNativeMomentImage({ client, momentId: '123', media,
    fetchImpl: async (url, options) => {
      input = { url, options };
      return fetchReceipt()();
    } });
  assert.deepEqual(JSON.parse(input.options.body), { momentId: '123', mediaId: '456' });
  assert.equal(input.options.redirect, 'error');
  assert.equal(input.options.headers.Authorization, `Bearer ${client.token}`);
  const verified = validateMomentImage(image, { ...media, momentId: '123' });
  assert.equal(verified.nativeBinding, true);
  assert.equal(verified.byteLength, png.length);
  assert.equal(verified.sha256, hash('sha256', png));
  assert.equal(verified.declaredMd5Matches, false);
  assert.equal(verified.declaredBytesMatch, false);
});

test('foreign accounts, images, changed descriptors and altered transport bodies are rejected', async () => {
  for (const change of [
    { accountId: 'other' }, { momentId: '124' }, { mediaId: '457' }, { verifiedSource: 'unverified' },
    { declaredMd5: 'b'.repeat(32) }, { declaredBytes: 124 }, { sha256: '0'.repeat(64) },
    { md5: '0'.repeat(32) }, { bytes: png.length + 1 }, { imageBase64: png.toString('base64') + '\n' },
    { declaredMd5Matches: true }, { declaredBytesMatch: true },
  ]) await assert.rejects(downloadNativeMomentImage({ client, momentId: '123', media, fetchImpl: fetchReceipt(change) }));
});

test('native evidence cannot be forged, rebound to another dynamic or reused after byte mutation', async () => {
  const bound = { ...media, momentId: '123' };
  assert.throws(() => validateMomentImage({ bytes: png, sourceUrl: 'native-sns', verifiedSource: 'authenticated-sns-media-v1' }, bound));
  const image = await downloadNativeMomentImage({ client, momentId: '123', media, fetchImpl: fetchReceipt() });
  const proof = nativeImageEvidence(image, bound);
  assert.equal(Object.isFrozen(proof), true);
  assert.throws(() => { proof.momentId = '124'; });
  assert.throws(() => validateMomentImage(image, { ...bound, momentId: '124' }));
  assert.throws(() => validateMomentImage(image, { ...bound, id: '457' }));
  assert.throws(() => validateMomentImage(image, { ...bound, bytes: 124 }));
  image.bytes[0] ^= 1;
  assert.throws(() => validateMomentImage(image, bound));
});

test('identical downloaded bytes reuse one description across different Moments without poisoning XML MD5 cache', async t => {
  const ledger = new MomentsLedger(':memory:');
  t.after(() => ledger.close());
  let calls = 0;
  for (const momentId of ['123', '124']) {
    const result = await describeMomentMedia({ moment: { id: momentId, media: [media] }, ledger,
      download: item => downloadNativeMomentImage({ client, momentId: item.momentId, media: item,
        fetchImpl: fetchReceipt({ momentId }) }),
      vision: async () => { calls++; return { scene: '已验证的同一张图', visibleText: 'same', safety: 'safe' }; } });
    assert.equal(result[0].vision.scene, '已验证的同一张图');
    assert.equal(result[0].vision.visibleText, 'same');
  }
  assert.equal(calls, 1);
  assert.equal(ledger.mediaDescription(`verified-image-v1:md5:${media.md5}`), null);
  assert.equal(ledger.mediaDescription(`verified-image-v1:sha256:${hash('sha256', png)}`).byteLength, png.length);
});

test('native API errors are bounded and never echo credential-bearing response details', async () => {
  await assert.rejects(downloadNativeMomentImage({ client, momentId: '123', media,
    fetchImpl: async () => new Response(JSON.stringify({ error: { code: 'sns_image_download_failed', detail: 'secret-download-url' } }), { status: 502 }) }),
  error => error.message.includes('sns_image_download_failed') && !error.message.includes('secret-download-url'));
  await assert.rejects(downloadNativeMomentImage({ client, momentId: '01', media, fetchImpl: async () => assert.fail('must reject before fetch') }));
});
