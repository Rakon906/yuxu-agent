import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const MAX_ASSET_BYTES = 1024 * 1024;
const MAX_PIXELS = 32_000_000;
const MAX_EDGE = 1600;
const supportedFormats = new Set(['jpeg', 'png', 'webp']);
const defaultAssetDir = fileURLToPath(new URL('../../.runtime/moments/assets/', import.meta.url));
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

function localPath(value, { absolute = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || /\0/u.test(value) ||
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) || /^[\\/]{2}/u.test(value) ||
      (absolute && !isAbsolute(value))) {
    throw new Error('Moment image requires a local filesystem path');
  }
  return resolve(value);
}

async function readLocalFile(filename, maxBytes = MAX_INPUT_BYTES) {
  const before = await lstat(filename);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('Moment image must be a regular file');
  if (before.size < 1 || before.size > maxBytes) throw new Error(`Moment image exceeds the ${maxBytes / 1024 / 1024} MiB limit or is empty`);
  const file = await open(filename, 'r');
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error('Moment image changed while opening');
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const part = Buffer.alloc(Math.min(65536, maxBytes + 1 - size));
      const { bytesRead } = await file.read(part, 0, part.length, null);
      if (!bytesRead) break;
      size += bytesRead;
      if (size > maxBytes) throw new Error(`Moment image exceeds the ${maxBytes / 1024 / 1024} MiB limit`);
      chunks.push(part.subarray(0, bytesRead));
    }
    const after = await file.stat();
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Moment image changed while reading');
    }
    return Buffer.concat(chunks, size);
  } finally { await file.close(); }
}

function imageOptions() {
  return { failOn: 'error', limitInputPixels: MAX_PIXELS, animated: false };
}

/** Return only canonical manifest fields; readMomentAsset additionally checks disk bytes. */
export function validateMomentAsset(asset) {
  const keys = ['kind', 'path', 'sha256', 'md5', 'width', 'height', 'bytes', 'mimeType'];
  if (!asset || typeof asset !== 'object' || Array.isArray(asset) ||
      keys.some(key => !Object.hasOwn(asset, key)) ||
      asset.kind !== 'image' || asset.mimeType !== 'image/jpeg' ||
      !/^[a-f0-9]{64}$/u.test(asset.sha256 ?? '') || !/^[a-f0-9]{32}$/u.test(asset.md5 ?? '') ||
      !Number.isSafeInteger(asset.bytes) || asset.bytes < 1 || asset.bytes > MAX_ASSET_BYTES ||
      !Number.isSafeInteger(asset.width) || asset.width < 1 || asset.width > MAX_EDGE ||
      !Number.isSafeInteger(asset.height) || asset.height < 1 || asset.height > MAX_EDGE) {
    throw new Error('Invalid Moment image asset');
  }
  const path = localPath(asset.path, { absolute: true });
  if (path !== asset.path) throw new Error('Moment image asset path must be normalized');
  return { kind: 'image', path, sha256: asset.sha256, md5: asset.md5,
    width: asset.width, height: asset.height, bytes: asset.bytes, mimeType: 'image/jpeg' };
}

/** Return verified JPEG bytes; changed cache files are never silently regenerated. */
export async function readMomentAsset(input) {
  const asset = validateMomentAsset(input);
  const bytes = await readLocalFile(asset.path, MAX_ASSET_BYTES);
  if (bytes.length !== asset.bytes || digest('sha256', bytes) !== asset.sha256 ||
      digest('md5', bytes) !== asset.md5) throw new Error('Moment image asset integrity check failed');
  const metadata = await sharp(bytes, imageOptions()).metadata();
  if (metadata.format !== 'jpeg' || metadata.width !== asset.width || metadata.height !== asset.height) {
    throw new Error('Moment image asset type or dimensions do not match');
  }
  return bytes;
}

/** Normalize a local raster into a metadata-free, content-addressed JPEG asset. */
export async function prepareMomentImage(filename, { assetDir = defaultAssetDir } = {}) {
  const source = localPath(filename);
  const outputDir = localPath(assetDir);
  const bytes = await readLocalFile(source);
  const metadata = await sharp(bytes, imageOptions()).metadata();
  if (!supportedFormats.has(metadata.format) || !metadata.width || !metadata.height ||
      metadata.width * metadata.height > MAX_PIXELS || (metadata.pages ?? 1) > 1) {
    throw new Error('Moment image must be a still JPEG, PNG or WebP with at most 32 million pixels');
  }
  // Keep the encoded asset inside the verified single-packet upload boundary.
  // Every attempt uses the original bytes, avoiding cumulative JPEG degradation.
  let encoded;
  for (const [edge, quality] of [[1600, 85], [1600, 70], [1280, 70], [1024, 70]]) {
    const candidate = await sharp(bytes, imageOptions()).rotate()
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality }).toBuffer({ resolveWithObject: true });
    if (candidate.data.length <= MAX_ASSET_BYTES) { encoded = candidate; break; }
  }
  if (!encoded) throw new Error('Moment image cannot fit the 1 MiB upload limit');
  const { data, info } = encoded;
  const sha256 = digest('sha256', data);
  const asset = validateMomentAsset({ kind: 'image', path: join(outputDir, `${sha256}.jpg`),
    sha256, md5: digest('md5', data), width: info.width, height: info.height,
    bytes: data.length, mimeType: 'image/jpeg' });
  await mkdir(outputDir, { recursive: true });
  const directory = await lstat(outputDir);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Moment asset directory must be a local directory');
  const temporary = join(outputDir, `.preparing-${randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try { await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    try {
      // A hard link atomically makes the complete file visible and cannot overwrite
      // an existing hash path, unlike a cross-platform rename operation.
      await link(temporary, asset.path);
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await readMomentAsset(asset);
    return asset;
  } finally { await unlink(temporary); }
}
