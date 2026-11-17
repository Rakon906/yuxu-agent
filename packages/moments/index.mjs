const nonEmpty = value => typeof value === 'string' && value.length > 0;
const STATES = new Set(['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled']);

function asObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function normalizeMedia(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 9) throw new Error('Moment media must contain at most 9 items');
  return value.map((item, index) => {
    const row = asObject(item, `Invalid moment media at index ${index}`);
    const url = row.url ?? row.path ?? null;
    if (!nonEmpty(url) || typeof url !== 'string' || url.length > 4096) throw new Error('Moment media needs a URL or local path');
    const type = row.type ?? 'image';
    if (!['image', 'video'].includes(type)) throw new Error('Moment media type must be image or video');
    return { type, url, ...(nonEmpty(row.sha256) ? { sha256: row.sha256 } : {}) };
  });
}

export function normalizeMoment(raw, accountId) {
  const row = asObject(raw, 'Moment item must be an object');
  if (row.accountId !== undefined && row.accountId !== accountId) throw new Error('Moment account mismatch');
  const id = row.id ?? row.momentId ?? row.moment_id;
  if (!nonEmpty(id) || !nonEmpty(accountId)) throw new Error('Moment item lacks identity');
  const author = row.author ?? { id: row.authorId ?? row.username, name: row.authorName ?? row.nickname };
  if (!author || typeof author !== 'object' || !nonEmpty(author.id)) throw new Error('Moment item lacks author identity');
  const text = row.text ?? row.content ?? '';
  if (typeof text !== 'string' || text.length > 10000) throw new Error('Invalid moment text');
  const createdAt = row.createdAt ?? row.createTime ?? null;
  if (createdAt !== null && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))) {
    throw new Error('Invalid moment timestamp');
  }
  return {
    id,
    accountId,
    author: { id: author.id, name: nonEmpty(author.name) ? author.name : author.id },
    createdAt,
    text,
    media: normalizeMedia(row.media),
    visibility: row.visibility ?? null,
    raw: row,
  };
}

function listItems(response) {
  const row = asObject(response, 'Moments timeline response must be an object');
  const items = row.items ?? row.moments ?? row.data?.items ?? row.data?.moments;
  if (!Array.isArray(items)) throw new Error('Moments timeline response lacks items');
  return { items, nextCursor: row.nextCursor ?? row.next_cursor ?? row.data?.nextCursor ?? row.data?.next_cursor ?? null };
}

function publishPayload({ text = '', media = [], visibility = 'private', audience = [] }) {
  if (typeof text !== 'string' || text.length > 5000) throw new Error('Invalid moments publish text');
  if (!['private', 'friends', 'public', 'selected'].includes(visibility)) throw new Error('Invalid moments visibility');
  if (!Array.isArray(audience) || audience.some(id => !nonEmpty(id)) || audience.length > 200) throw new Error('Invalid moments audience');
  if (visibility === 'selected' && audience.length === 0) throw new Error('Selected moments need an audience');
  const normalizedMedia = normalizeMedia(media);
  if (!text.trim() && normalizedMedia.length === 0) throw new Error('A moment needs text or media');
  return { text, media: normalizedMedia, visibility, audience };
}

function receipt(raw, accountId) {
  const row = asObject(raw, 'Moments publish receipt must be an object');
  const id = row.id ?? row.operationId ?? row.operation_id ?? row.msgId ?? row.newMsgId;
  if (id === undefined || id === null || String(id).length === 0) throw new Error('Moments publish receipt lacks operation ID');
  const state = row.state ?? row.status ?? 'accepted';
  if (!STATES.has(state)) throw new Error('Invalid moments publish receipt state');
  if (row.accountId !== undefined && row.accountId !== accountId) throw new Error('Moments receipt account mismatch');
  return { id: String(id), accountId, state, momentId: row.momentId ?? row.moment_id ?? null, raw: row };
}

export class MomentsService {
  constructor({ gateway, store, accountId, publishingEnabled = false, cooldownMs = 60000, maxLimit = 100 }) {
    if (!gateway || typeof gateway.timeline !== 'function' || typeof gateway.detail !== 'function') throw new Error('Moments gateway lacks read methods');
    if (!store || store.accountId !== accountId) throw new Error('Moments store/account mismatch');
    if (!nonEmpty(accountId) || typeof publishingEnabled !== 'boolean' || !Number.isFinite(cooldownMs) || cooldownMs < 0 || !Number.isInteger(maxLimit) || maxLimit < 1 || maxLimit > 200) {
      throw new Error('Invalid moments service policy');
    }
    this.gateway = gateway;
    this.store = store;
    this.accountId = accountId;
    this.publishingEnabled = publishingEnabled;
    this.cooldownMs = cooldownMs;
    this.maxLimit = maxLimit;
  }

  async capabilities(signal) {
    if (typeof this.gateway.capabilities !== 'function') return { state: 'unknown', read: true, publish: false };
    return this.gateway.capabilities(signal);
  }

  async timeline({ limit = 20, cursor = null, usernames = [], keyword = null, start = null, end = null } = {}, signal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > this.maxLimit) throw new Error('Invalid moments timeline limit');
    if (!Array.isArray(usernames) || usernames.some(id => !nonEmpty(id))) throw new Error('Invalid moments timeline authors');
    const query = { limit, cursor, usernames, keyword, start, end };
    const response = listItems(await this.gateway.timeline(query, signal));
    const items = response.items.map(item => normalizeMoment(item, this.accountId));
    this.store.upsertMoments(items);
    const cacheKey = JSON.stringify(query);
    this.store.cacheTimeline(cacheKey, response.nextCursor, items);
    return { items, nextCursor: response.nextCursor, cacheKey };
  }

  async detail(momentId, signal) {
    if (!nonEmpty(momentId)) throw new Error('Missing moment ID');
    const item = normalizeMoment(await this.gateway.detail(momentId, signal), this.accountId);
    this.store.upsertMoments([item]);
    return item;
  }

  draftPublish({ key, text = '', media = [], visibility = 'private', audience = [] }) {
    const payload = publishPayload({ text, media, visibility, audience });
    return this.store.draft(key, payload);
  }

  approvePublish(key) { return this.store.approve(key); }

  async reconcile(key, signal) {
    const row = this.store.outbox(key);
    if (!row || row.state === 'draft') throw new Error('No previous moments publish attempt to reconcile');
    if (['accepted', 'failed', 'cancelled'].includes(row.state)) return row;
    const prior = row.receipt_json ? JSON.parse(row.receipt_json) : null;
    if (!prior?.id || typeof this.gateway.publishStatus !== 'function') return this.store.receipt(key, 'needs_review', prior);
    try { return this.acceptReceipt(key, await this.gateway.publishStatus(prior.id, signal)); }
    catch (error) {
      if (signal?.aborted) throw error;
      return this.store.receipt(key, 'needs_review', prior);
    }
  }

  acceptReceipt(key, raw) {
    const row = this.store.outbox(key);
    if (!row) throw new Error('Unknown moments publish key');
    const accepted = receipt(raw, this.accountId);
    return this.store.receipt(key, accepted.state, accepted);
  }

  async publishApproved(key, signal) {
    const row = this.store.outbox(key);
    if (!row) throw new Error('Unknown moments publish key');
    if (row.state !== 'draft') return this.reconcile(key, signal);
    if (!this.publishingEnabled) throw new Error('Moments publishing is disabled by host policy');
    if (typeof this.gateway.publish !== 'function') throw new Error('Moments gateway lacks publish method');
    const claim = this.store.claim(key, this.cooldownMs);
    try {
      const response = await this.gateway.publish(JSON.parse(claim.payload_json), key, signal);
      return this.acceptReceipt(key, response);
    } catch (error) {
      this.store.receipt(key, 'needs_review');
      return this.reconcile(key, signal);
    }
  }
}
