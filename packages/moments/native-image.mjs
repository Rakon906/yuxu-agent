import { createHash } from 'node:crypto';

const MAX_IMAGE = 16 * 1024 * 1024;
const MAX_REPLY = Math.ceil(MAX_IMAGE / 3) * 4 + 8192;
const evidence = new WeakMap();
const hash = (kind, bytes) => createHash(kind).update(bytes).digest('hex');
const id = value => {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(value) || BigInt(value) > 0xffffffffffffffffn) {
    throw new Error('Invalid native SNS image identifier');
  }
  return value;
};

async function boundedJson(response, max) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('Native SNS image response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** The daemon resolves IDs through the logged-in account; callers never send URLs or keys. */
export async function downloadNativeMomentImage({ client, momentId, media, fetchImpl = fetch }) {
  id(momentId); id(media?.id);
  const origin = new URL(client.origin);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Untrusted image daemon origin');
  const response = await fetchImpl(`${origin.origin}/v1/accounts/${encodeURIComponent(client.accountId)}/moments/download-image`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
    headers: { Authorization: `Bearer ${client.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ momentId, mediaId: media.id }),
  });
  if (!response.ok) {
    let code = 'native_image_request_failed';
    try {
      const value = await boundedJson(response, 8192);
      if (/^[a-z0-9_]{1,80}$/u.test(value.error?.code ?? '')) code = value.error.code;
    } catch { /* Do not echo remote bodies, URLs or credentials. */ }
    throw new Error(`Native SNS image failed: HTTP ${response.status} ${code}`);
  }
  const value = await boundedJson(response, MAX_REPLY);
  if (value.ok !== true || value.verifiedSource !== 'authenticated-sns-media-v1' ||
      value.accountId !== client.accountId || value.momentId !== momentId || value.mediaId !== media.id ||
      !/^[a-f0-9]{32}$/u.test(value.md5 ?? '') || !/^[a-f0-9]{64}$/u.test(value.sha256 ?? '') ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_IMAGE ||
      !['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(value.contentType) ||
      typeof value.imageBase64 !== 'string' || value.imageBase64.length > Math.ceil(MAX_IMAGE / 3) * 4) {
    throw new Error('Native SNS image identity or receipt rejected');
  }
  if (value.declaredMd5 !== String(media.md5 ?? '').toLowerCase() ||
      (media.bytes != null && value.declaredBytes !== media.bytes) ||
      (media.length != null && value.declaredBytes !== media.length)) {
    throw new Error('SNS image descriptor changed');
  }
  const bytes = Buffer.from(value.imageBase64, 'base64');
  const md5 = hash('md5', bytes), sha256 = hash('sha256', bytes);
  if (bytes.toString('base64') !== value.imageBase64 || bytes.length !== value.bytes ||
      md5 !== value.md5 || sha256 !== value.sha256 ||
      value.declaredMd5Matches !== (md5 === value.declaredMd5) ||
      value.declaredBytesMatch !== (value.declaredBytes == null ? null : value.declaredBytes === bytes.length)) {
    throw new Error('Native SNS image transport checksum mismatch');
  }
  const image = { bytes, sha256, mediaType: value.contentType, sourceUrl: 'native-sns',
    declaredMd5Matches: value.declaredMd5Matches, declaredBytesMatch: value.declaredBytesMatch };
  evidence.set(image, Object.freeze({ momentId, mediaId: media.id, declaredMd5: value.declaredMd5,
    declaredBytes: value.declaredBytes, sha256, byteLength: bytes.length }));
  return image;
}

/** A plain object claiming sourceUrl='native-sns' is not proof of a verified download. */
export function nativeImageEvidence(image, descriptor) {
  const proof = image && evidence.get(image);
  if (!proof) return null;
  if (proof.momentId !== descriptor.momentId || proof.mediaId !== descriptor.id ||
      proof.declaredMd5 !== String(descriptor.md5 ?? '').toLowerCase() ||
      (descriptor.bytes != null && descriptor.bytes !== proof.declaredBytes) ||
      (descriptor.length != null && descriptor.length !== proof.declaredBytes) ||
      !Buffer.isBuffer(image.bytes) || image.bytes.length !== proof.byteLength ||
      hash('sha256', image.bytes) !== proof.sha256) throw new Error('Native SNS image binding changed');
  return proof;
}
