import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile, open } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { prepareMomentImage, validateMomentAsset, readMomentAsset } from '../packages/moments/publish-assets.mjs';

const runRoot = fileURLToPath(new URL('../.runtime/runs/', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function fixture({ width = 240, height = 120, format = 'png', orientation } = {}) {
  await mkdir(runRoot, { recursive: true });
  const root = await mkdtemp(join(runRoot, 'moment-assets-'));
  let pipeline = sharp({ create: { width, height, channels: 3, background: '#aaccee' } });
  if (orientation) pipeline = pipeline.withMetadata({ orientation });
  const bytes = await pipeline[format]().toBuffer();
  const source = join(root, `source.${format}`);
  await writeFile(source, bytes);
  return { root, source, sourceBytes: bytes, assetDir: join(root, 'assets') };
}

test('staging rotates EXIF, strips metadata and preserves the source', async () => {
  const f = await fixture({ format: 'jpeg', orientation: 6 });
  const asset = await prepareMomentImage(f.source, f);
  assert.equal(isAbsolute(asset.path), true);
  assert.equal(asset.kind, 'image');
  assert.equal(asset.mimeType, 'image/jpeg');
  assert.equal(asset.width, 120);
  assert.equal(asset.height, 240);
  const bytes = await readMomentAsset(asset);
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  assert.equal(metadata.orientation, undefined);
  assert.equal(asset.sha256, sha(bytes));
  assert.equal(asset.md5, createHash('md5').update(bytes).digest('hex'));
  assert.equal(asset.bytes, bytes.length);
  assert.deepEqual(await readFile(f.source), f.sourceBytes);
});

test('large images resize proportionally and small PNG/WebP inputs are not enlarged', async () => {
  const large = await fixture({ width: 4000, height: 2000 });
  const asset = await prepareMomentImage(large.source, large);
  assert.equal(asset.width, 1600);
  assert.equal(asset.height, 800);
  for (const format of ['png', 'webp']) {
    const small = await fixture({ width: 20, height: 10, format });
    const result = await prepareMomentImage(small.source, small);
    assert.equal(result.width, 20);
    assert.equal(result.height, 10);
    assert.equal((await sharp(await readMomentAsset(result)).metadata()).format, 'jpeg');
  }
});

test('concurrent duplicate staging reuses one complete hash asset without overwriting it', async () => {
  const f = await fixture();
  const copies = await Promise.all(Array.from({ length: 3 }, () => prepareMomentImage(f.source, f)));
  for (const copy of copies) assert.deepEqual(copy, copies[0]);
  assert.deepEqual(await readdir(f.assetDir), [`${copies[0].sha256}.jpg`]);
  const before = await stat(copies[0].path);
  assert.deepEqual(await prepareMomentImage(f.source, f), copies[0]);
  assert.equal((await stat(copies[0].path)).mtimeMs, before.mtimeMs);
});

test('high-entropy input is deterministically compressed below the 1 MiB upload boundary', async () => {
  const f = await fixture();
  const noisy = await sharp(randomBytes(1600 * 1600 * 3),
    { raw: { width: 1600, height: 1600, channels: 3 } }).png().toBuffer();
  const initial = await sharp(noisy).jpeg({ quality: 85 }).toBuffer();
  assert.ok(initial.length > 1024 * 1024, 'fixture must exercise the fallback encoding');
  const source = join(f.root, 'noise.png');
  await writeFile(source, noisy);
  const asset = await prepareMomentImage(source, f);
  assert.ok(asset.bytes <= 1024 * 1024);
  assert.ok(asset.width <= 1600 && asset.height <= 1600);
  assert.equal((await readMomentAsset(asset)).length, asset.bytes);
  assert.deepEqual(await prepareMomentImage(source, f), asset);
  assert.deepEqual(await readFile(source), noisy);
});

test('corrupted hash cache is rejected and never overwritten', async () => {
  const f = await fixture();
  const asset = await prepareMomentImage(f.source, f);
  const tampered = Buffer.from('tampered image');
  await writeFile(asset.path, tampered);
  await assert.rejects(() => readMomentAsset(asset), /integrity/u);
  await assert.rejects(() => prepareMomentImage(f.source, f), /integrity/u);
  assert.deepEqual(await readFile(asset.path), tampered);
  assert.deepEqual(await readdir(f.assetDir), [`${asset.sha256}.jpg`]);
});

test('manifest hashes, byte size, dimensions and image type are independently verified', async () => {
  const f = await fixture();
  const asset = await prepareMomentImage(f.source, f);
  for (const altered of [{ sha256: '0'.repeat(64) }, { md5: '0'.repeat(32) }, { bytes: asset.bytes + 1 }]) {
    await assert.rejects(() => readMomentAsset({ ...asset, ...altered }), /integrity/u);
  }
  await assert.rejects(() => readMomentAsset({ ...asset, width: asset.width + 1 }), /dimensions/u);
  const fake = { ...asset, path: f.source, sha256: sha(f.sourceBytes),
    md5: createHash('md5').update(f.sourceBytes).digest('hex'), bytes: f.sourceBytes.length };
  await assert.rejects(() => readMomentAsset(fake), /type or dimensions/u);
  for (const altered of [{ path: 'https://example.test/image.jpg' }, { path: '\\\\server\\image.jpg' },
    { path: 'relative.jpg' }, { width: 0 }, { height: 1601 }, { bytes: 1024 * 1024 + 1 },
    { mimeType: 'image/png' }, { kind: 'video' }, { sha256: 'invalid' }]) {
    assert.throws(() => validateMomentAsset({ ...asset, ...altered }));
  }
  assert.deepEqual(validateMomentAsset({ extra: 'not part of the manifest', ...asset }), asset);
  assert.deepEqual(Object.keys(validateMomentAsset(asset)),
    ['kind', 'path', 'sha256', 'md5', 'width', 'height', 'bytes', 'mimeType']);
});

test('malformed, unsupported, empty, oversized and over-pixel-limit sources are rejected', async () => {
  const f = await fixture();
  for (const [name, bytes] of [['malformed.jpg', Buffer.from('not an image')],
    ['empty.png', Buffer.alloc(0)], ['vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>')]]) {
    const filename = join(f.root, name);
    await writeFile(filename, bytes);
    await assert.rejects(() => prepareMomentImage(filename, f));
  }
  const big = join(f.root, 'oversized.jpg');
  const handle = await open(big, 'wx');
  try { await handle.truncate(12 * 1024 * 1024 + 1); } finally { await handle.close(); }
  await assert.rejects(() => prepareMomentImage(big, f), /12 MiB/u);
  await assert.rejects(() => prepareMomentImage(f.root, f), /regular file/u);
  await assert.rejects(() => prepareMomentImage('https://example.test/x.jpg', f), /local filesystem/u);
  const huge = await fixture({ width: 8001, height: 4000 });
  await assert.rejects(() => prepareMomentImage(huge.source, huge), /pixel limit|32 million/iu);
});
