import { decodeMessage, encodeFields, hexToBytes } from './protobuf.mjs';
import { parseTimelineReply } from './timeline.mjs';
import { MomentsDaemonClient } from './daemon-client.mjs';

const UINT64_MAX = 0xffffffffffffffffn;
const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024 + 4096;
const utf8 = new TextDecoder('utf-8', { fatal: true });
export function commentId(value, name = 'ID') {
  const id = String(value ?? '');
  if (!/^[1-9][0-9]{0,19}$/u.test(id) || BigInt(id) > UINT64_MAX) throw new Error(`Invalid ${name}`);
  return id;
}
const one = (fields, number, wire) => {
  const found = fields.filter(field => field.number === number);
  if (found.length !== 1 || found[0].wire !== wire) throw new Error(`Invalid SNS field ${number}`);
  return found[0];
};
export function commentBaseCode(replyHex) {
  const bytes = hexToBytes(replyHex);
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error('Invalid SNS response size');
  const fields = decodeMessage(bytes).fields;
  const base = decodeMessage(Buffer.from(one(fields, 1, 2).bytes, 'hex')).fields;
  return Number(BigInt.asIntN(32, BigInt(one(base, 1, 0).varint)));
}

/** CGI 210 and CGI 211 share SnsObject. Adapt its envelope to the existing parser. */
export function parseCommentMomentDetail(replyHex, expectedId) {
  const id = commentId(expectedId, 'moment ID');
  if (commentBaseCode(replyHex) !== 0) throw new Error('Moment detail was rejected');
  const fields = decodeMessage(hexToBytes(replyHex)).fields;
  const base = one(fields, 1, 2);
  const object = one(fields, 2, 2);
  const sharedEnvelope = encodeFields([
    { number: 1, bytes: Buffer.from(base.bytes, 'hex') },
    { number: 4, bytes: Buffer.from(object.bytes, 'hex') },
  ]);
  const moment = parseTimelineReply(sharedEnvelope).objects[0];
  if (!moment || moment.id !== id || !moment.author?.id) throw new Error('Moment detail identity mismatch');
  const rawComments = decodeMessage(Buffer.from(object.bytes, 'hex')).fields.filter(row => row.number === 12);
  if (rawComments.length !== moment.comments.length || rawComments.some(row => row.wire !== 2)) {
    throw new Error('Invalid raw comment list');
  }
  // The extended-ID mapping is unverified. Preserve that boundary rather than
  // silently dropping nonzero extension data while sending a legacy 32-bit ID.
  for (let i = 0; i < moment.comments.length; i++) {
    const fields = decodeMessage(Buffer.from(rawComments[i].bytes, 'hex')).fields;
    const value = number => fields.find(row => row.number === number);
    moment.comments[i].type = Number(value(4)?.varint ?? 2);
    moment.comments[i].source = Number(value(3)?.varint ?? 0);
    moment.comments[i].replyReferenceSupported = fields.filter(row => row.number >= 11).every(row => {
      if ([11, 12, 13, 14, 16, 19, 20].includes(row.number)) return row.wire === 0 && row.varint === '0';
      if ([17, 18].includes(row.number) && row.wire === 2) {
        const nested = decodeMessage(Buffer.from(row.bytes, 'hex')).fields;
        return nested.length === 1 && nested[0].number === 1 && nested[0].wire === 0 && nested[0].varint === '0';
      }
      return false;
    });
  }
  const ids = new Set();
  for (const row of moment.comments) {
    commentId(row.commentId, 'comment ID');
    if (!row.userId || ids.has(row.commentId)) throw new Error('Invalid or ambiguous comment identity');
    ids.add(row.commentId);
  }
  return moment;
}

export function verifyCommentReply(moment, { momentId, sourceComment, priorCommentIds = [], selfId, text, sentAt }) {
  if (moment.id !== String(momentId)) return { verified: false, reason: 'moment_mismatch' };
  const prior = new Set(priorCommentIds.map(String));
  const sourceId = commentId(sourceComment.commentId);
  // Official reply requests can carry the source comment's timestamp. New IDs and
  // the exact relationship prove the reply; a send-time comparison would reject it.
  const candidates = moment.comments.filter(item => !prior.has(String(item.commentId)) &&
    item.userId === selfId && item.text === text &&
    item.replyTo === sourceComment.userId && String(item.replyCommentId ?? '') === sourceId);
  if (candidates.length !== 1) return { verified: false,
    reason: candidates.length ? 'ambiguous_reply' : 'reply_relationship_not_found' };
  return { verified: true, commentId: candidates[0].commentId, momentId: moment.id,
    authorId: selfId, replyTo: sourceComment.userId, sourceCommentId: sourceId, reason: null };
}

export class NativeCommentReplyGateway {
  constructor({ client, selfId, buildBody, fetchImpl = fetch }) {
    if (!client || typeof client.probe !== 'function' || !selfId) throw new Error('Reply gateway requires an account client');
    // Reuse the account credentials, but capture the original HTTP response before
    // the generic client's JSON parser can discard malformed or rejected replies.
    this.client = new MomentsDaemonClient({ baseUrl: client.origin, token: client.token,
      accountId: client.accountId, timeoutMs: client.timeoutMs });
    if (!Number.isSafeInteger(this.client.timeoutMs) || this.client.timeoutMs < 100 ||
        this.client.timeoutMs > 120000 || typeof fetchImpl !== 'function') throw new Error('Invalid reply transport settings');
    this.selfId = selfId;
    this.buildBody = buildBody;
    this.fetch = fetchImpl;
  }
  async request(cgi, bodyHex, phase, { onResponse } = {}) {
    if (![210, 213].includes(cgi) || phase !== (cgi === 213 ? 'send' : 'detail')) throw new Error('Unsupported comment reply request');
    if (typeof bodyHex !== 'string' || bodyHex.length > 120 * 1024 || bodyHex.length % 2 !== 0 ||
        !/^[a-f0-9]*$/iu.test(bodyHex)) throw new Error('Invalid comment reply request body');
    const response = await this.fetch(`${this.client.origin}/v1/accounts/${encodeURIComponent(this.client.accountId)}/moments/probe`, {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${this.client.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ cgi, bodyHex, withBaseRequest: true, ...(cgi === 213 ? { write: true } : {}) }),
      signal: AbortSignal.timeout(this.client.timeoutMs),
    });
    const reader = response.body?.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_ENVELOPE_BYTES) throw new Error('Comment reply response is too large');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader?.cancel().catch(() => {}); }
    const responseBody = utf8.decode(Buffer.concat(chunks));
    if (onResponse) await onResponse({ phase, httpStatus: response.status,
      responseBody, receivedAt: new Date().toISOString() });
    if (!response.ok) throw new Error(`Comment reply HTTP ${response.status}`);
    const envelope = JSON.parse(responseBody);
    if (envelope.ok === false || envelope.cgi !== cgi) throw new Error('Comment RPC response unavailable or mismatched');
    const baseCode = commentBaseCode(envelope.replyHex);
    if (envelope.baseCode !== baseCode) throw new Error('Comment RPC status mismatch');
    return { ...envelope, baseCode };
  }
  async readMoment(momentId, options = {}) {
    const id = commentId(momentId, 'moment ID');
    const response = await this.request(210, encodeFields([{ number: 2, varint: BigInt(id) }]).toString('hex'), 'detail', options);
    return parseCommentMomentDetail(response.replyHex, id);
  }
  async send(input, options = {}) {
    if (input.selfId !== this.selfId || typeof this.buildBody !== 'function') throw new Error('Reply sender identity/protocol unavailable');
    if (input.comment?.replyReferenceSupported === false) throw new Error('Extended comment reference is unsupported');
    const body = this.buildBody({ ...input, momentId: input.moment.id, now: Math.floor(input.attemptedAt / 1000) });
    const result = await this.request(213, body, 'send', options);
    return { baseCode: result.baseCode, cgi: 213 };
  }
  async verify(input, options = {}) {
    if (input.selfId !== this.selfId) throw new Error('Reply verification account mismatch');
    const moment = await this.readMoment(input.momentId, options);
    return verifyCommentReply(moment, input);
  }
}
