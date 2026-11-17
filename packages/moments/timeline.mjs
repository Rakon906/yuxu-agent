import { bytesToHex, decodeMessage, encodeFields, hexToBytes, tryDecode } from './protobuf.mjs';

const MAX_XML_BYTES = 256 * 1024;
const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (match, name) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X'
        ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return entities[name.toLowerCase()] ?? match;
  });
}

function parseXml(xml) {
  if (typeof xml !== 'string' || Buffer.byteLength(xml) > MAX_XML_BYTES) throw new Error('Invalid TimelineObject XML');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const pattern = /<([^>]*)>|([^<]+)/gu;
  let match;
  while ((match = pattern.exec(xml))) {
    if (match[2] !== undefined) {
      stack.at(-1).text += decodeEntities(match[2]);
      continue;
    }
    let tag = match[1].trim();
    if (!tag || tag.startsWith('!') || tag.startsWith('?')) continue;
    if (tag.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1).trim();
    const name = /^[A-Za-z_][\w:.-]*/u.exec(tag)?.[0];
    if (!name) continue;
    const attrs = {};
    for (const attr of tag.slice(name.length).matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
      attrs[attr[1]] = decodeEntities(attr[2] ?? attr[3] ?? '');
    }
    const node = { name, attrs, children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  return root;
}

const find = (node, name) => node?.children.find(child => child.name === name) ?? null;
const findAll = (node, name) => node?.children.filter(child => child.name === name) ?? [];
const childText = (node, name) => find(node, name)?.text.trim() ?? '';

function parseMedia(media) {
  const url = find(media, 'url');
  const thumb = find(media, 'thumb');
  const size = find(media, 'size');
  const width = Number(size?.attrs.width);
  const height = Number(size?.attrs.height);
  const bytes = Number(size?.attrs.totalSize);
  return {
    id: childText(media, 'id'),
    type: Number(childText(media, 'type')) || null,
    description: childText(media, 'description'),
    md5: url?.attrs.md5 ?? null,
    key: url?.attrs.key ?? null,
    token: url?.attrs.token ?? null,
    encIdx: Number(url?.attrs.enc_idx) || null,
    url: url?.text.trim() || null,
    thumbUrl: thumb?.text.trim() || null,
    width: Number.isFinite(width) && width > 0 ? width : null,
    height: Number.isFinite(height) && height > 0 ? height : null,
    bytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
  };
}

export function parseTimelineXml(xml) {
  const timeline = find(parseXml(xml), 'TimelineObject');
  if (!timeline) throw new Error('TimelineObject XML lacks its root');
  const content = find(timeline, 'ContentObject');
  const media = findAll(content, 'mediaList').flatMap(list => findAll(list, 'media')).map(parseMedia);
  const location = find(timeline, 'location');
  const appInfo = find(timeline, 'appInfo');
  const publicUserName = childText(timeline, 'publicUserName');
  const createTime = Number(childText(timeline, 'createTime'));
  return {
    id: childText(timeline, 'id'),
    username: childText(timeline, 'username'),
    createTime: Number.isFinite(createTime) && createTime > 0 ? createTime : null,
    text: childText(timeline, 'contentDesc'),
    private: childText(timeline, 'private') === '1',
    advertisement: Boolean(publicUserName || childText(appInfo, 'id') || childText(appInfo, 'appName')),
    media,
    location: location && (location.attrs.poiName || location.attrs.poiAddress || location.attrs.city)
      ? { name: location.attrs.poiName ?? '', address: location.attrs.poiAddress ?? '', city: location.attrs.city ?? '' }
      : null,
  };
}

function parseLike(field) {
  const value = number => field.message.find(item => item.number === number);
  return {
    userId: value(1)?.text ?? null,
    name: value(2)?.text ?? '',
    createTime: Number(value(6)?.varint) || null,
  };
}

function parseComment(field) {
  const value = number => field.message.find(item => item.number === number);
  const commentId = value(7)?.varint ?? null;
  const replyCommentId = value(8)?.varint ?? null;
  return {
    userId: value(1)?.text ?? null,
    name: value(2)?.text ?? '',
    text: value(5)?.text ?? '',
    createTime: Number(value(6)?.varint) || null,
    commentId,
    replyCommentId: replyCommentId === '0' ? null : replyCommentId,
    replyTo: value(9)?.text ?? null,
  };
}

function parseObject(field) {
  const value = number => field.message.find(item => item.number === number);
  const xmlBytes = value(5)?.message?.find(item => item.number === 2 && typeof item.text === 'string')?.text;
  const xml = xmlBytes ? parseTimelineXml(xmlBytes) : null;
  const createTime = Number(value(4)?.varint) || xml?.createTime || null;
  const likes = field.message.filter(item => item.number === 9 && item.message).map(parseLike);
  const comments = field.message.filter(item => item.number === 12 && item.message).map(parseComment);
  return {
    id: value(1)?.varint ?? xml?.id ?? null,
    author: { id: value(2)?.text ?? xml?.username ?? null, name: value(3)?.text || '' },
    createTime,
    text: xml?.text ?? '',
    media: xml?.media ?? [],
    location: xml?.location ?? null,
    private: xml?.private ?? null,
    advertisement: xml?.advertisement ?? false,
    likes,
    comments,
  };
}

/** First-page request body; the daemon prepends BaseRequest. */
export function timelineBody({ maxId = 0, minId = 0 } = {}) {
  return bytesToHex(encodeFields([{ number: 3, varint: maxId }, { number: 4, varint: minId }]));
}

export function parseTimelineReply(input) {
  const bytes = Buffer.isBuffer(input) ? input : hexToBytes(input);
  const decoded = tryDecode(bytes);
  if (!decoded.ok) throw new Error(`Invalid timeline reply: ${decoded.error}`);
  let baseCode = null;
  const base = decoded.fields.find(field => field.number === 1 && field.message);
  if (base) {
    const code = base.message.find(field => field.number === 1)?.varint;
    if (code !== undefined) baseCode = Number(code);
  }
  if (baseCode !== null && baseCode !== 0) throw new Error(`Moments timeline base code ${baseCode}`);
  const objects = decoded.fields.filter(field => field.number === 4 && field.message).map(parseObject);
  return {
    baseCode,
    firstPageMd5: decoded.fields.find(field => field.number === 2)?.text ?? null,
    count: Number(decoded.fields.find(field => field.number === 3)?.varint ?? objects.length),
    objects,
  };
}
