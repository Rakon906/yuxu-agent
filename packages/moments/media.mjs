import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { nativeImageEvidence } from './native-image.mjs';

const MAX_IMAGE = 16 * 1024 * 1024;
const HOST_PATTERN = /(?:^|\.)qpic\.cn$/iu;
const MOMENT_REFERER = 'https://servicewechat.com/';
const MOMENT_UA = process.env.SOCIOMEM_MOMENTS_UA ??
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'MicroMessenger/8.0.50.2701(0x28003256) WeChat/arm64 Weixin Windows(26100)';
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');
const DESCRIPTION_VERSION = 'verified-image-v1';

export function momentImageDescriptionKey(md5) {
  if (typeof md5 !== 'string' || !/^[a-f0-9]{32}$/iu.test(md5)) {
    throw new Error('Moment image requires a valid content checksum');
  }
  return `${DESCRIPTION_VERSION}:md5:${md5.toLowerCase()}`;
}

/** Timeline descriptors call this field `bytes`; downloader callers may use `length`. */
export function momentImageByteLength(descriptor = {}) {
  const lengths = [descriptor.length, descriptor.bytes].filter(value => value !== null && value !== undefined);
  if (lengths.some(value => !Number.isSafeInteger(value) || value < 1 || value > MAX_IMAGE) ||
      (lengths.length === 2 && lengths[0] !== lengths[1])) {
    throw new Error('Moment image descriptor length rejected');
  }
  return lengths[0] ?? null;
}

/** Recheck every source, including injected downloaders and local official caches. */
export function validateMomentImage(image, descriptor = {}) {
  momentImageDescriptionKey(descriptor.md5);
  const expectedLength = momentImageByteLength(descriptor);
  const bytes = image?.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_IMAGE) {
    throw new Error('Moment image bytes rejected');
  }
  const native = nativeImageEvidence(image, descriptor);
  // CDN variants can differ from XML's advertised upload checksum and size.
  // Only the authenticated native receipt can establish that association;
  // unbound HTTP/cache/injected sources still require exact content equality.
  if (!native) {
    if (expectedLength !== null && bytes.length !== expectedLength) throw new Error('Moment image size mismatch');
    if (digest('md5', bytes) !== descriptor.md5.toLowerCase()) throw new Error('Moment image checksum mismatch');
  }
  const type = imageType(bytes);
  if (!type) throw new Error('Unsupported moment image format');
  return { ...image, ...type, bytes, byteLength: bytes.length, sha256: digest('sha256', bytes),
    nativeBinding: Boolean(native) };
}

export class MomentImageCdnError extends Error {
  constructor(message, { status = null, errNo = null, info = null } = {}) {
    super(message);
    this.name = 'MomentImageCdnError';
    this.status = status;
    this.errNo = errNo;
    this.info = info;
  }
}

export const MOMENT_VISION_PROMPT = '只根据这张朋友圈图片，输出JSON对象：' +
  'scene（画面里可见的人、物、场景，简短客观）、visibleText（逐字可读文字，看不清写空字符串）、' +
  'tone（可能传达的情绪或用途，注明只是推测）、' +
  'safety（safe、uncertain或unsafe，是否含隐私、辱骂、色情、暴力等不宜评论的内容）。' +
  '不要猜群友身份、真实事件或聊天背景。';

function publicV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a >= 1 && a <= 223 && a !== 10 && a !== 127 && a !== 169 &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 100 && b >= 64 && b <= 127);
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) {
    return { extension: 'png', mediaType: 'image/png' };
  }
  if (/^GIF8[79]a$/u.test(bytes.subarray(0, 6).toString('ascii'))) {
    return { extension: 'gif', mediaType: 'image/gif' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return { extension: 'jpg', mediaType: 'image/jpeg' };
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { extension: 'webp', mediaType: 'image/webp' };
  }
  return null;
}

function validateImageUrl(rawUrl) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !HOST_PATTERN.test(url.hostname) ||
      url.username || url.password || url.port || url.hash) {
    throw new Error('Moment image descriptor rejected');
  }
  return url;
}

export async function downloadMomentImage({ url: rawUrl, fallbackUrl = null, key = null, token = null,
  length = null, bytes = null, md5 = null }, { fetchImpl = fetch, lookupImpl = lookup } = {}) {
  length = momentImageByteLength({ length, bytes });
  if ((key !== null && (typeof key !== 'string' || !key || key.length > 2048)) ||
      (token !== null && (typeof token !== 'string' || !token || token.length > 2048)) ||
      (length !== null && (!Number.isSafeInteger(length) || length < 1 || length > MAX_IMAGE)) ||
      (md5 !== null && !/^[a-f0-9]{32}$/iu.test(md5))) {
    throw new Error('Moment image descriptor rejected');
  }
  const bases = [validateImageUrl(rawUrl)];
  if (fallbackUrl) {
    try { bases.push(validateImageUrl(fallbackUrl)); } catch { /* optional thumbnail */ }
  }
  const hosts = [...new Set(bases.map(url => url.hostname))];
  for (const host of hosts) {
    const addresses = await lookupImpl(host, { all: true });
    if (!addresses.length || addresses.some(item => item.family !== 4 || !publicV4(item.address))) {
      throw new Error('Moment image DNS rejected');
    }
  }
  const candidates = [];
  for (const base of bases) {
    const swapped = new URL(base);
    swapped.protocol = base.protocol === 'https:' ? 'http:' : 'https:';
    for (const item of [base, swapped]) {
      candidates.push(item.toString());
      if (key) {
        const signed = new URL(item);
        signed.searchParams.set('key', key);
        if (token) signed.searchParams.set('token', token);
        candidates.push(signed.toString());
      }
    }
  }
  let lastError = null;
  for (const candidate of [...new Set(candidates)]) {
    let response;
    try {
      response = await fetchImpl(candidate, { redirect: 'manual',
        headers: { 'accept-encoding': 'identity', referer: MOMENT_REFERER, 'user-agent': MOMENT_UA },
        signal: AbortSignal.timeout(15000) });
    } catch (error) {
      lastError = error;
      continue;
    }
    const errNo = response.headers.get('x-errno');
    const info = response.headers.get('x-info');
    if (response.status !== 200 || info === 'illref' ||
        (response.headers.get('content-encoding') &&
         response.headers.get('content-encoding') !== 'identity')) {
      lastError = new MomentImageCdnError(
        info === 'illref' ? 'Moment image CDN rejected (illref)' : 'Moment image download failed',
        { status: response.status, errNo, info });
      continue;
    }
    const chunks = [];
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > MAX_IMAGE) throw new Error('Moment image too large');
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (length !== null && bytes.length !== length) {
      lastError = new Error('Moment image size mismatch');
      continue;
    }
    if (md5 !== null && digest('md5', bytes) !== md5.toLowerCase()) {
      lastError = new Error('Moment image checksum mismatch');
      continue;
    }
    const type = imageType(bytes);
    if (!type) {
      lastError = new Error('Unsupported moment image format');
      continue;
    }
    return { bytes, ...type, sha256: digest('sha256', bytes), sourceUrl: candidate };
  }
  throw lastError ?? new Error('Moment image unavailable');
}

const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max) : '';

function normalizeDescription(value) {
  if (!value || typeof value !== 'object') throw new Error('Moment vision result is not an object');
  const scene = clean(value.scene ?? value.summary, 300);
  if (!scene) throw new Error('Moment vision result lacks a scene');
  const safety = ['safe', 'uncertain', 'unsafe'].includes(value.safety) ? value.safety : 'uncertain';
  return { scene, visibleText: clean(value.visibleText ?? value.visible_text, 200),
    tone: clean(value.tone, 120), safety };
}

export async function describeMomentMedia({ moment, ledger, vision, download = downloadMomentImage,
  budget = { remaining: 8 }, now = Date.now(), maxImages = 4 } = {}) {
  const media = Array.isArray(moment?.media) ? moment.media : [];
  const described = [];
  for (const [index, item] of media.entries()) {
    if (!item || typeof item !== 'object' || !item.url || (item.type != null && item.type !== 2) ||
        index >= maxImages) {
      described.push(item);
      continue;
    }
    try {
      const key = momentImageDescriptionKey(item.md5);
      const expectedLength = momentImageByteLength(item);
      const candidate = ledger.mediaDescription(key);
      // Old unverified rows use a different key. A v1 row also needs the actual
      // byte length and digest recorded during validation, not downloader claims.
      const cached = candidate && /^[a-f0-9]{64}$/u.test(candidate.sha256 ?? '') &&
        Number.isSafeInteger(candidate.byteLength) && candidate.byteLength > 0 && candidate.byteLength <= MAX_IMAGE
        ? candidate : null;
      if (cached) {
        if (expectedLength !== null && expectedLength !== cached.byteLength) throw new Error('Moment image size mismatch');
        described.push({ ...item, vision: cached });
        continue;
      }
      if (!vision || budget.remaining <= 0) {
        described.push({ ...item, vision: null });
        continue;
      }
      const bound = { ...item, momentId: moment.id };
      const image = validateMomentImage(await download({ ...bound, fallbackUrl: item.thumbUrl ?? null }), bound);
      const contentKey = `verified-image-v1:sha256:${image.sha256}`;
      const known = ledger.mediaDescription(contentKey);
      if (known?.sha256 === image.sha256 && known?.byteLength === image.byteLength) {
        described.push({ ...item, vision: known });
        continue;
      }
      budget.remaining--;
      const raw = await vision({ bytes: image.bytes, prompt: MOMENT_VISION_PROMPT });
      const result = normalizeDescription(raw);
      const saved = { sha256: image.sha256, byteLength: image.byteLength, ...result,
        model: typeof raw.model === 'string' ? raw.model : 'unknown', now };
      ledger.saveMediaDescription({ mediaKey: contentKey, ...saved });
      // Only exact byte matches may populate the pre-download MD5 lookup.
      if (!image.nativeBinding || (digest('md5', image.bytes) === item.md5.toLowerCase() &&
          (expectedLength === null || expectedLength === image.byteLength))) ledger.saveMediaDescription({ mediaKey: key, ...saved });
      ledger.trace('moments.media_verified', { momentId: moment.id, mediaId: item.id,
        source: image.nativeBinding ? 'authenticated-sns-media-v1' : 'content-md5',
        declaredMd5Matches: digest('md5', image.bytes) === item.md5.toLowerCase(),
        byteLength: image.byteLength });
      described.push({ ...item, vision: result });
    } catch (error) {
      ledger.trace('moments.media_error', { momentId: moment.id, mediaId: item.id,
        errorType: error.name, cdnInfo: error.info ?? null, cdnStatus: error.status ?? null });
      described.push({ ...item, vision: null, mediaError: error.info ?? error.name });
    }
  }
  return described;
}
