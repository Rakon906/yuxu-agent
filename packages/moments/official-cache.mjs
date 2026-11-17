import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { validateMomentImage } from './media.mjs';

const MAGIC = Buffer.from('070856320807', 'hex');
const MAX_PLAINTEXT = 64 * 1024 * 1024;
const MAX_CACHE_FILES = 5000;

export function isDatV2(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 15 && buffer.subarray(0, 6).equals(MAGIC);
}

export function decodeDatV2(buffer, key, code) {
  if (!isDatV2(buffer) || !Buffer.isBuffer(key) || key.length !== 16 ||
      !Number.isSafeInteger(code) || code < 0 || code > 0xffffffff) return null;
  const aesSize = buffer.readUInt32LE(6);
  const xorSize = buffer.readUInt32LE(10);
  if (buffer[14] !== 1 || aesSize <= 0 || aesSize > MAX_PLAINTEXT || xorSize > MAX_PLAINTEXT) return null;
  const cipherBytes = aesSize + 16 - (aesSize % 16);
  if (buffer.length < 15 + cipherBytes) return null;
  let head;
  try {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    decipher.setAutoPadding(false);
    head = Buffer.concat([decipher.update(buffer.subarray(15, 15 + cipherBytes)), decipher.final()]);
  } catch {
    return null;
  }
  const pad = head.at(-1);
  if (!pad || pad > 16 || pad > head.length || !head.subarray(head.length - pad).every(byte => byte === pad)) {
    return null;
  }
  head = head.subarray(0, head.length - pad);
  if (head.length !== aesSize) return null;
  const remainder = buffer.subarray(15 + cipherBytes);
  if (xorSize > remainder.length) return null;
  const raw = remainder.subarray(0, remainder.length - xorSize);
  const tail = Buffer.from(remainder.subarray(remainder.length - xorSize));
  const xorKey = code & 0xff;
  for (let index = 0; index < tail.length; index += 1) tail[index] ^= xorKey;
  const output = Buffer.concat([head, raw, tail]);
  return output.length <= MAX_PLAINTEXT ? output : null;
}

export function encodeDatV2(plaintext, key, code, { aesPlainBytes = 1024 } = {}) {
  const aesSize = Math.min(aesPlainBytes, plaintext.length);
  const xorSize = Math.min(plaintext.length - aesSize, 1024 * 1024);
  const cipherBytes = aesSize + 16 - (aesSize % 16);
  const head = Buffer.alloc(cipherBytes, cipherBytes - aesSize);
  plaintext.copy(head, 0, 0, aesSize);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(false);
  const tail = Buffer.alloc(xorSize);
  for (let index = 0; index < xorSize; index += 1) {
    tail[index] = plaintext[plaintext.length - xorSize + index] ^ (code & 0xff);
  }
  return Buffer.concat([
    MAGIC,
    Buffer.from([aesSize & 0xff, (aesSize >>> 8) & 0xff, (aesSize >>> 16) & 0xff, (aesSize >>> 24) & 0xff]),
    Buffer.from([xorSize & 0xff, (xorSize >>> 8) & 0xff, (xorSize >>> 16) & 0xff, (xorSize >>> 24) & 0xff]),
    Buffer.from([1]),
    cipher.update(head), cipher.final(),
    plaintext.subarray(aesSize, plaintext.length - xorSize),
    tail,
  ]);
}

export function imageDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) {
    for (let index = 2; index + 9 < buffer.length;) {
      if (buffer[index] !== 0xff) { index += 1; continue; }
      const marker = buffer[index + 1];
      if (marker === 0xd8 || marker === 0xd9) { index += 2; continue; }
      const length = buffer.readUInt16BE(index + 2);
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: buffer.readUInt16BE(index + 7), height: buffer.readUInt16BE(index + 5), mediaType: 'image/jpeg' };
      }
      index += 2 + length;
    }
    return null;
  }
  if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), mediaType: 'image/png' };
  }
  if (buffer.subarray(0, 4).toString() === 'RIFF') {
    return { width: buffer.readUInt16LE(26), height: buffer.readUInt16LE(28), mediaType: 'image/webp' };
  }
  return null;
}

export function listKvcommCodes(kvcommDir) {
  if (!existsSync(kvcommDir)) return [];
  return [...new Set(readdirSync(kvcommDir)
    .map(name => /^key_(\d+)_.*\.statistic$/u.exec(name)?.[1])
    .filter(Boolean).map(Number))].sort((a, b) => a - b);
}

export function cleanWxid(value) {
  const parts = String(value ?? '').split('_');
  if (parts.length > 1 && /^[a-z0-9]{4}$/iu.test(parts.at(-1))) parts.pop();
  return parts.join('_');
}

export function findOfficialAccountDir(root, wxid) {
  if (!existsSync(root)) return null;
  const prefix = `${cleanWxid(wxid)}_`;
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .map(entry => join(root, entry.name))[0] ?? null;
}

function cacheFiles(accountDir) {
  const cacheDir = join(accountDir, 'cache');
  if (!existsSync(cacheDir)) return [];
  const found = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (found.length >= MAX_CACHE_FILES) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.isFile() || !full.includes(`${'Sns'}\\Img`)) continue;
      try { if (statSync(full).size > 0) found.push(full); } catch { /* skip */ }
    }
  };
  walk(cacheDir);
  return found;
}

export function deriveDatKey(files, codes, wxid) {
  if (!files.length || !codes.length) return null;
  const sample = readFileSync(files[0]);
  for (const code of codes) {
    const key = Buffer.from(createHash('md5').update(`${code}${cleanWxid(wxid)}`).digest('hex').slice(0, 16), 'ascii');
    const decoded = decodeDatV2(sample, key, code);
    if (decoded && imageDimensions(decoded)) return { code, key };
  }
  return null;
}

export function matchCacheToMedia(cacheImages, media) {
  const byDigest = new Map();
  for (const image of cacheImages) {
    if (!Buffer.isBuffer(image?.bytes)) continue;
    const md5 = createHash('md5').update(image.bytes).digest('hex');
    const existing = byDigest.get(md5);
    // Even a checksum collision must not bind two different byte strings.
    if (existing !== undefined && (existing === null || !existing.bytes.equals(image.bytes))) {
      byDigest.set(md5, null);
    } else byDigest.set(md5, image);
  }
  const result = new Map();
  for (const item of media) {
    if (typeof item?.md5 !== 'string' || !/^[a-f0-9]{32}$/iu.test(item.md5)) continue;
    const image = byDigest.get(item.md5.toLowerCase());
    if (!image) continue;
    try { result.set(item.md5.toLowerCase(), validateMomentImage(image, item)); }
    catch { /* Missing or inconsistent content evidence never falls back to dimensions. */ }
  }
  return result;
}

export function loadOfficialCacheImages({ accountRoot, kvcommDir, wxid, media, minSide = 0 } = {}) {
  const accountDir = findOfficialAccountDir(accountRoot, wxid);
  if (!accountDir) return new Map();
  const files = cacheFiles(accountDir);
  const key = deriveDatKey(files, listKvcommCodes(kvcommDir), wxid);
  if (!key) return new Map();
  const images = [];
  for (const file of files) {
    const bytes = decodeDatV2(readFileSync(file), key.key, key.code);
    if (!bytes) continue;
    const size = imageDimensions(bytes);
    if (!size || Math.min(size.width, size.height) < minSide) continue;
    images.push({ name: file, bytes, ...size });
  }
  return matchCacheToMedia(images, media);
}
