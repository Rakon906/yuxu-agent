import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanWxid,
  decodeDatV2,
  encodeDatV2,
  findOfficialAccountDir,
  imageDimensions,
  loadOfficialCacheImages,
  matchCacheToMedia,
} from '../packages/moments/official-cache.mjs';

function png(width, height, extra = 0) {
  const bytes = Buffer.alloc(32 + extra);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('V2 DAT encoder and decoder round-trip small and split payloads', () => {
  const key = Buffer.from('0123456789abcdef', 'ascii');
  const code = 3812345678;
  for (const bytes of [png(800, 600), png(1920, 2560, 5000)]) {
    const dat = encodeDatV2(bytes, key, code);
    const decoded = decodeDatV2(dat, key, code);
    assert.deepEqual(decoded, bytes);
    assert.deepEqual(imageDimensions(decoded), { width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20), mediaType: 'image/png' });
  }
  const dat = encodeDatV2(png(800, 600), key, code);
  assert.equal(decodeDatV2(dat, Buffer.from('fedcba9876543210', 'ascii'), code), null);
});

test('cache images match timeline media only by verified content checksum', () => {
  const cache = [
    { name: 'a', bytes: png(800, 600), width: 800, height: 600, mediaType: 'image/png' },
    { name: 'b', bytes: png(600, 400), width: 600, height: 400, mediaType: 'image/png' },
    { name: 'c', bytes: png(800, 600), width: 800, height: 600, mediaType: 'image/png' },
  ];
  const md5 = value => createHash('md5').update(value).digest('hex');
  const unique = matchCacheToMedia(cache.slice(0, 2), [
    { md5: md5(cache[0].bytes), width: 800, height: 600 },
    { md5: md5(cache[1].bytes), width: 600, height: 400 },
  ]);
  assert.equal(unique.size, 2);
  assert.deepEqual(unique.get(md5(cache[0].bytes)).bytes, cache[0].bytes);
  const ambiguous = matchCacheToMedia(cache, [{ md5: 'm1', width: 800, height: 600 }]);
  assert.equal(ambiguous.size, 0);
});

test('official cache loader derives the key and maps verified image content', t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-official-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const kvcomm = join(root, 'kvcomm');
  const account = join(root, 'wxid_testing_abcd');
  const cacheDir = join(account, 'cache', '2026-11', 'Sns', 'Img', 'aa');
  mkdirSync(kvcomm, { recursive: true });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(kvcomm, 'key_123456789_1.statistic'), 'x');
  const key = Buffer.from(createHash('md5').update('123456789wxid_testing').digest('hex').slice(0, 16), 'ascii');
  const image = png(800, 600, 100);
  writeFileSync(join(cacheDir, 'feedfacefeedfacefeedfacefeedface'), encodeDatV2(image, key, 123456789));
  assert.equal(cleanWxid('wxid_testing_abcd'), 'wxid_testing');
  assert.equal(findOfficialAccountDir(root, 'wxid_testing'), account);
  const md5 = createHash('md5').update(image).digest('hex');
  const media = [{ md5, width: 800, height: 600 }];
  const matches = loadOfficialCacheImages({ accountRoot: root, kvcommDir: kvcomm, wxid: 'wxid_testing', media });
  assert.equal(matches.size, 1);
  assert.deepEqual(matches.get(md5).bytes, image);
  assert.equal(loadOfficialCacheImages({ accountRoot: root, kvcommDir: kvcomm,
    wxid: 'wxid_other', media }).size, 0);
});
