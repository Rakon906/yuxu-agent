import { MomentsDaemonClient } from './daemon-client.mjs';
import { decodeMessage, encodeFields, hexToBytes } from './protobuf.mjs';
import { createHash } from 'node:crypto';
import { readMomentAsset, validateMomentAsset } from './publish-assets.mjs';

// Publication codec for the Linux 4.1.13.26 SNS path.
// Protocol evidence and the remaining live acceptance checks: docs/moments-publish.md.
export const SNS_POST = 209;
const MAX_REPLY = 4 * 1024 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
  .replaceAll('\r', '&#13;');

async function captureTransportResponse(response, phase, onResponse) {
  const reader = response.body?.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (reader) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_REPLY * 2 + 4096) throw new Error('Moments transport reply too large');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader?.cancel().catch(() => {}); }
  const responseBody = utf8.decode(Buffer.concat(chunks));
  if (onResponse) await onResponse({ phase, httpStatus: response.status, responseBody, receivedAt: new Date().toISOString() });
  if (!response.ok) throw new Error(`Moments transport HTTP ${response.status}`);
  return JSON.parse(responseBody);
}

export function validatePostDraft(draft) {
  if (!draft || !['friends', 'private'].includes(draft.visibility)) throw new Error('Unsupported Moments visibility');
  if (typeof draft.text !== 'string' || !draft.text.trim() || draft.text.length > 5000 ||
      !draft.text.isWellFormed() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/u.test(draft.text)) {
    throw new Error('Invalid Moments text');
  }
  for (const name of ['accountId', 'selfUserId', 'clientId']) {
    if (typeof draft[name] !== 'string' || !/^[\w.-]{1,200}$/u.test(draft[name])) throw new Error(`Invalid ${name}`);
  }
  if (draft.audience !== undefined && (!Array.isArray(draft.audience) || draft.audience.length)) {
    throw new Error('Selected audiences are not supported');
  }
  if (draft.media !== undefined && (!Array.isArray(draft.media) || draft.media.length > 1)) {
    throw new Error('Only one Moments image is supported');
  }
  for (const asset of draft.media ?? []) validateMomentAsset(asset);
  const time = draft.attemptedAt ?? Date.parse(draft.createdAt);
  if (!Number.isSafeInteger(time) || time < 0 || time > 0xffffffff * 1000) throw new Error('Invalid Moments timestamp');
  return draft;
}

export function validateTextDraft(draft) {
  validatePostDraft(draft);
  if (draft.media?.length || draft.uploadedMedia?.length) throw new Error('Only text is supported by this codec');
  return draft;
}

function uploadedUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/u.test(value)) {
    throw new Error('Invalid uploaded Moments URL');
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error('Invalid uploaded Moments URL');
  }
  return value;
}

/** The receipt must belong to the exact immutable image manifest, not a chat file ID. */
export function validateUploadedMedia(draft) {
  const assets = draft.media ?? [];
  const uploaded = draft.uploadedMedia ?? [];
  if (!Array.isArray(uploaded) || uploaded.length !== assets.length) throw new Error('Missing Moments upload receipt');
  return uploaded.map((item, index) => {
    const asset = validateMomentAsset(assets[index]);
    if (!item || typeof item !== 'object' || item.sha256 !== asset.sha256 ||
        item.width !== asset.width || item.height !== asset.height || item.bytes !== asset.bytes ||
        (item.md5 !== undefined && item.md5 !== asset.md5)) throw new Error('Moments upload asset mismatch');
    for (const type of [item.urlType, item.thumbType]) {
      if (!Number.isSafeInteger(type) || type < 0 || type > 0xffffffff) throw new Error('Invalid uploaded Moments URL type');
    }
    uploadedUrl(item.url); uploadedUrl(item.thumbUrl);
    return item;
  });
}

export function buildTextPostXml(input) {
  const draft = validateTextDraft(input);
  return buildPostXml(draft);
}

export function buildPostXml(input) {
  const draft = validatePostDraft(input);
  const uploaded = validateUploadedMedia(draft);
  // The official photo serializer uses media/type=2 inside contentStyle=1. The
  // top-level privacy controls the post; media/private itself is always zero.
  const media = uploaded.map(item => '<media><id>0</id><type>2</type><title></title><description></description>' +
    '<private>0</private><userData></userData><subType>0</subType>' +
    `<videoSize width="${item.width}" height="${item.height}"/>` +
    `<url type="${item.urlType}">${xmlEscape(item.url)}</url>` +
    `<thumb type="${item.thumbType}">${xmlEscape(item.thumbUrl)}</thumb>` +
    `<size width="${item.width}" height="${item.height}" totalSize="${item.bytes}"/></media>`).join('');
  const at = Math.floor((draft.attemptedAt ?? Date.parse(draft.createdAt)) / 1000);
  return `<TimelineObject><id>0</id><username>${xmlEscape(draft.selfUserId)}</username>` +
    `<createTime>${at}</createTime><private>${draft.visibility === 'private' ? 1 : 0}</private>` +
    `<contentDesc>${xmlEscape(draft.text)}</contentDesc><contentDescShowType>0</contentDescShowType>` +
    `<ContentObject><contentStyle>${uploaded.length ? 1 : 2}</contentStyle><title></title><description></description>` +
    `<mediaList>${media}</mediaList></ContentObject></TimelineObject>`;
}

export function buildTextPostBody(draft) {
  validateTextDraft(draft);
  return buildPostBody(draft);
}

export function buildPostBody(draft) {
  const xml = Buffer.from(buildPostXml(draft), 'utf8');
  // BaseRequest (field 1) is supplied once by the daemon, not by this codec.
  const objectDesc = encodeFields([{ number: 1, varint: xml.length }, { number: 2, bytes: xml }]);
  const body = encodeFields([
    { number: 2, bytes: objectDesc },
    { number: 5, varint: draft.visibility === 'private' ? 1 : 0 },
    { number: 7, bytes: draft.clientId },
  ]);
  if (body.length > 60 * 1024) throw new Error('Moments body too large');
  return body.toString('hex');
}

function field(fields, number, wire, required = true) {
  const found = fields.filter(item => item.number === number);
  if (found.length > 1 || (found.length === 1 && found[0].wire !== wire) || (required && found.length !== 1)) {
    throw new Error(`Invalid SNS field ${number}`);
  }
  return found[0];
}
const nested = item => decodeMessage(Buffer.from(item.bytes, 'hex')).fields;
const text = item => utf8.decode(Buffer.from(item.bytes, 'hex'));

function entityText(value) {
  return value.replace(/&([^;]*);|&/gu, (match, name) => {
    const literals = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (Object.hasOwn(literals, name)) return literals[name];
    if (/^#(?:[0-9]+|x[0-9a-f]+)$/iu.test(name ?? '')) {
      const n = name[1].toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff)) return String.fromCodePoint(n);
    }
    throw new Error(`Invalid XML entity`);
  });
}

/** Small strict XML reader: no DTD/entities, preserves text/CDATA without trimming. */
export function readPostXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > 256 * 1024) throw new Error('Invalid SNS XML size');
  const root = { name: '#document', children: [], value: '' };
  const stack = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<([^>]*?)>|([^<]+)/gu;
  let offset = 0;
  for (const match of xml.matchAll(token)) {
    if (match.index !== offset) throw new Error('Malformed SNS XML');
    offset = match.index + match[0].length;
    if (match[1] !== undefined) { stack.at(-1).value += match[1]; continue; }
    if (match[3] !== undefined) { stack.at(-1).value += entityText(match[3]); continue; }
    if (match[0].startsWith('<!--')) continue;
    const tag = match[2].trim();
    if (/^\?xml\s/u.test(tag) && stack.length === 1 && !root.children.length) continue;
    if (tag.startsWith('!') || tag.startsWith('?')) throw new Error('Unsupported XML declaration');
    if (tag.startsWith('/')) {
      if (stack.length <= 1 || stack.at(-1).name !== tag.slice(1).trim()) throw new Error('Mismatched XML element');
      stack.pop(); continue;
    }
    const name = /^([A-Za-z_][\w:.-]*)(?:\s|\/|$)/u.exec(tag)?.[1];
    if (!name || stack.length > 32 || !/^[A-Za-z_][\w:.-]*(?:\s+[A-Za-z_][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*\/?$/u.test(tag)) {
      throw new Error('Invalid XML element');
    }
    const attrs = Object.create(null);
    for (const attr of tag.slice(name.length).matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/gu)) {
      if (Object.hasOwn(attrs, attr[1])) throw new Error('Ambiguous XML attribute');
      attrs[attr[1]] = entityText(attr[2] ?? attr[3]);
    }
    const node = { name, attrs, children: [], value: '' };
    stack.at(-1).children.push(node);
    if (!tag.endsWith('/')) stack.push(node);
  }
  if (offset !== xml.length || stack.length !== 1 || root.value.trim() || root.children.length !== 1 ||
      root.children[0].name !== 'TimelineObject') throw new Error('Invalid TimelineObject XML');
  const object = root.children[0];
  const child = (parent, name, required = true) => {
    const children = parent.children.filter(item => item.name === name);
    if (children.length > 1 || (required && children.length !== 1)) throw new Error(`Missing or ambiguous XML ${name}`);
    return children[0] ?? null;
  };
  const get = (parent, name) => {
    const node = child(parent, name);
    if (node.children.length) throw new Error(`Invalid XML ${name}`);
    return node.value;
  };
  const privateFlag = get(object, 'private');
  if (!['0', '1'].includes(privateFlag)) throw new Error('Unknown SNS privacy flag');
  const content = child(object, 'ContentObject', false);
  let contentStyle = null;
  const media = [];
  const numeric = (value, name, { positive = false } = {}) => {
    if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.0+)?$/u.test(value)) throw new Error(`Invalid XML ${name}`);
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < (positive ? 1 : 0)) throw new Error(`Invalid XML ${name}`);
    return number;
  };
  if (content) {
    contentStyle = numeric(get(content, 'contentStyle'), 'contentStyle');
    const list = child(content, 'mediaList', false);
    if (list) {
      if (list.children.length > 9 || list.children.some(item => item.name !== 'media')) throw new Error('Invalid XML mediaList');
      for (const item of list.children) {
        const url = child(item, 'url');
        const thumb = child(item, 'thumb');
        const size = child(item, 'size');
        if (url.children.length || thumb.children.length || size.children.length) throw new Error('Invalid XML media');
        media.push({ id: get(item, 'id'), type: numeric(get(item, 'type'), 'media type'),
          url: url.value, urlType: numeric(url.attrs.type, 'url type'),
          thumbUrl: thumb.value, thumbType: numeric(thumb.attrs.type, 'thumb type'),
          width: numeric(size.attrs.width, 'width', { positive: true }),
          height: numeric(size.attrs.height, 'height', { positive: true }),
          bytes: numeric(size.attrs.totalSize, 'totalSize', { positive: true }),
          md5: url.attrs.md5 ?? null });
      }
    }
  }
  return { id: get(object, 'id'), authorId: get(object, 'username'), text: get(object, 'contentDesc'),
    visibility: privateFlag === '1' ? 'private' : 'friends', contentStyle, media };
}

function responseFields(replyHex) {
  const raw = hexToBytes(replyHex);
  if (!raw.length || raw.length > MAX_REPLY) throw new Error('Invalid SNS reply size');
  return decodeMessage(raw).fields;
}

/** Preserve an unambiguous receipt ID even when a new XML shape needs investigation. */
export function parsePostIdentity(replyHex) {
  const fields = responseFields(replyHex);
  const base = nested(field(fields, 1, 2));
  const baseCode = Number(BigInt.asIntN(32, BigInt(field(base, 1, 0).varint)));
  if (baseCode !== 0) return { baseCode, momentId: null };
  const sns = field(fields, 2, 2, false);
  if (!sns) return { baseCode, momentId: null };
  const object = nested(sns);
  const id = BigInt(field(object, 1, 0).varint);
  if (id <= 0n || id > 0xffffffffffffffffn) throw new Error('Invalid SNS object ID');
  return { baseCode, momentId: id.toString() };
}

export function parsePostReply(replyHex) {
  const identity = parsePostIdentity(replyHex);
  if (identity.baseCode !== 0 || !identity.momentId) return { ...identity, object: null };
  const object = nested(field(responseFields(replyHex), 2, 2));
  const authorId = text(field(object, 2, 2));
  const desc = nested(field(object, 5, 2));
  const data = field(desc, 2, 2);
  if (BigInt(field(desc, 1, 0).varint) !== BigInt(data.size)) throw new Error('SNS XML length mismatch');
  const xml = readPostXml(text(data));
  if ((xml.id !== '0' && xml.id !== identity.momentId) || xml.authorId !== authorId) throw new Error('SNS object identity mismatch');
  return { ...identity, object: { ...xml, id: identity.momentId, authorId } };
}

function sameOfficialMediaHost(before, after) {
  try {
    uploadedUrl(after);
    const a = new URL(before), b = new URL(after);
    return !b.port && a.hostname === b.hostname && /(?:^|\.)qpic\.cn$/iu.test(b.hostname) &&
      /^\/(?:mmsns|sns)\//u.test(a.pathname) && /^\/(?:mmsns|sns)\//u.test(b.pathname);
  } catch { return false; }
}

function compareObject(object, draft, acceptedMediaIds = null) {
  if (!object) return 'missing_object';
  if (object.authorId !== draft.selfUserId) return 'author_mismatch';
  if (object.text !== draft.text) return 'text_mismatch';
  if (object.visibility !== draft.visibility) return 'visibility_mismatch';
  let uploaded;
  try { uploaded = validateUploadedMedia(draft); }
  catch { return 'missing_or_invalid_upload_receipt'; }
  if (object.media.length !== uploaded.length) return 'media_count_mismatch';
  if (uploaded.length && object.contentStyle !== 1) return 'content_style_mismatch';
  if (!uploaded.length && object.contentStyle !== null && object.contentStyle !== 2) return 'content_style_mismatch';
  for (let index = 0; index < uploaded.length; index++) {
    const expected = uploaded[index];
    const actual = object.media[index];
    if (actual.type !== 2) return 'media_type_mismatch';
    if (acceptedMediaIds && actual.id !== acceptedMediaIds[index]) return 'media_id_mismatch';
    if (actual.urlType !== expected.urlType || actual.thumbType !== expected.thumbType) return 'media_reference_mismatch';
    const sameUrls = actual.url === expected.url && actual.thumbUrl === expected.thumbUrl;
    // WeChat can rotate opaque CDN paths after accepting a post. The stable
    // media ID must first be bound by a saved successful post response that
    // matched the exact upload URLs. Host/size alone never establish identity.
    if (!sameUrls && !(acceptedMediaIds &&
        sameOfficialMediaHost(expected.url, actual.url) &&
        sameOfficialMediaHost(expected.thumbUrl, actual.thumbUrl))) return 'media_reference_mismatch';
    if (actual.width !== expected.width || actual.height !== expected.height || actual.bytes !== expected.bytes) {
      return 'media_size_mismatch';
    }
    if (actual.md5 && actual.md5.toLowerCase() !== draft.media[index].md5) return 'media_md5_mismatch';
  }
  return null;
}

function acceptedMediaIds(draft, responses) {
  if (!draft.media?.length || !Array.isArray(responses)) return null;
  const bindings = new Map();
  for (const row of responses) {
    if (row.key !== draft.key || row.phase !== 'publish' || row.http_status < 200 || row.http_status >= 300 ||
        typeof row.body !== 'string' || Buffer.byteLength(row.body) > MAX_REPLY * 2 + 4096 ||
        createHash('sha256').update(row.body).digest('hex') !== row.sha256) continue;
    try {
      const envelope = JSON.parse(row.body);
      if (envelope.ok === false || envelope.cgi !== SNS_POST || envelope.baseCode !== 0) continue;
      const parsed = parsePostReply(envelope.replyHex);
      if (parsed.baseCode !== 0 || compareObject(parsed.object, draft)) continue;
      if (parsed.momentId !== draft.momentId) return null;
      const ids = parsed.object.media.map(item => item.id);
      if (ids.some(id => !/^[1-9][0-9]{0,19}$/u.test(id) || BigInt(id) > 0xffffffffffffffffn) ||
          new Set(ids).size !== ids.length) continue;
      bindings.set(JSON.stringify(ids), ids);
    } catch { /* A malformed or mismatched saved response cannot authorize rotation. */ }
  }
  return bindings.size === 1 ? [...bindings.values()][0] : null;
}

export class NativeMomentsPublisher {
  constructor({ baseUrl, token, accountId, selfUserId, timeoutMs = 20000, fetchImpl = fetch }) {
    this.client = new MomentsDaemonClient({ baseUrl, token, accountId, timeoutMs });
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) throw new Error('Invalid timeout');
    this.accountId = accountId;
    this.selfUserId = selfUserId;
    this.fetch = fetchImpl;
  }
  check(draft) {
    validatePostDraft(draft);
    if (draft.accountId !== this.accountId || draft.selfUserId !== this.selfUserId) throw new Error('Draft account identity mismatch');
  }
  async request(cgi, bodyHex, { onResponse } = {}) {
    if (![SNS_POST, 210].includes(cgi)) throw new Error('Unsupported publication operation');
    const response = await this.fetch(`${this.client.origin}/v1/accounts/${encodeURIComponent(this.accountId)}/moments/probe`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.client.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ cgi, bodyHex, withBaseRequest: true, ...(cgi === SNS_POST ? { write: true } : {}) }),
      signal: AbortSignal.timeout(this.client.timeoutMs),
    });
    // Commit the received response text before interpreting JSON/protobuf/XML. No request
    // headers or API token are included in this record. Failure here never retries.
    const reply = await captureTransportResponse(response, cgi === SNS_POST ? 'publish' : 'detail', onResponse);
    if (reply.ok === false) return { error: 'daemon_rejected_or_transport_unknown' };
    if (reply.cgi !== cgi) throw new Error('SNS response CGI mismatch');
    let parsed;
    try { parsed = parsePostReply(reply.replyHex); }
    catch {
      let identity = { baseCode: null, momentId: null };
      try {
        const found = parsePostIdentity(reply.replyHex);
        if (reply.baseCode === found.baseCode) identity = found;
      } catch { /* Raw response is retained; an uncertain identity stays unknown. */ }
      return { error: 'unrecognized_post_response', ...identity };
    }
    if (reply.baseCode !== parsed.baseCode) throw new Error('SNS response status mismatch');
    return parsed;
  }
  async uploadImage(input, { onResponse } = {}) {
    const asset = validateMomentAsset(input);
    const bytes = await readMomentAsset(asset);
    const response = await this.fetch(`${this.client.origin}/v1/accounts/${encodeURIComponent(this.accountId)}/moments/upload-image`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.client.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ imageBase64: bytes.toString('base64'), sha256: asset.sha256 }),
      signal: AbortSignal.timeout(Math.max(90000, this.client.timeoutMs)),
    });
    const reply = await captureTransportResponse(response, 'upload', onResponse);
    if (reply.ok !== true || reply.accountId !== this.accountId) throw new Error('Moments image upload was not confirmed for this account');
    const receipt = { sha256: reply.sha256, md5: reply.md5, width: reply.width, height: reply.height,
      bytes: reply.bytes, url: reply.url, urlType: reply.urlType, thumbUrl: reply.thumbUrl, thumbType: reply.thumbType };
    validateUploadedMedia({ media: [asset], uploadedMedia: [receipt] });
    return receipt;
  }
  async publish(draft, options = {}) {
    this.check(draft);
    const result = await this.request(SNS_POST, buildPostBody(draft), options);
    if (result.error) return { state: 'needs_review', ...result };
    if (result.baseCode !== 0) return { state: 'rejected', baseCode: result.baseCode, momentId: null };
    const reason = compareObject(result.object, draft);
    return { state: reason ? 'needs_review' : 'accepted', baseCode: result.baseCode,
      momentId: result.momentId, ...(reason ? { reason } : {}) };
  }
  recoverReceipt(draft, responses) {
    this.check(draft);
    const ids = new Set();
    for (const row of responses) {
      if (row.phase !== 'publish' || row.http_status < 200 || row.http_status >= 300) continue;
      if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > MAX_REPLY * 2 + 4096 ||
          createHash('sha256').update(row.body).digest('hex') !== row.sha256) continue;
      try {
        const envelope = JSON.parse(row.body);
        if (envelope.ok === false || envelope.cgi !== SNS_POST || envelope.baseCode !== 0) continue;
        const parsed = parsePostIdentity(envelope.replyHex);
        if (parsed.baseCode === 0 && parsed.momentId) ids.add(parsed.momentId);
      } catch { /* The saved reply may itself be malformed; never guess an ID. */ }
    }
    return ids.size === 1 ? { momentId: [...ids][0], source: 'saved_response' } : null;
  }
  async verify(draft, options = {}) {
    this.check(draft);
    // No fuzzy matching on text/time: a lost receipt cannot prove which post is ours.
    if (!/^[1-9][0-9]{0,19}$/u.test(draft.momentId ?? '') || BigInt(draft.momentId) > 0xffffffffffffffffn) {
      return { verified: false, reason: 'missing_receipt_id', momentId: null };
    }
    const body = encodeFields([{ number: 2, varint: BigInt(draft.momentId) }]).toString('hex');
    const result = await this.request(210, body, options);
    if (result.error) return { verified: false, ...result, momentId: draft.momentId };
    const mediaIds = acceptedMediaIds(draft, options.publicationResponses);
    const reason = result.baseCode !== 0 ? 'detail_rejected'
      : result.momentId !== draft.momentId ? 'moment_id_mismatch' : compareObject(result.object, draft, mediaIds);
    return { verified: !reason, reason, baseCode: result.baseCode, momentId: draft.momentId };
  }
}
