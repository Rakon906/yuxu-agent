import { setTimeout as delay } from 'node:timers/promises';
import { ApiError, cursor } from './client.mjs';
import { verifyQuoteReference } from './quote-send.mjs';
import { normalizeSharedMedia } from '../shared-media/index.mjs';
import { normalizeForwarded } from '../shared-media/forwarded.mjs';

const id = value => typeof value === 'string' && value.length > 0;
export class WeChatAdapter {
  constructor({ client, store, allowedGroups, selfUserId, consumer = 'sociomem', sendingEnabled = false, cooldownMs = 10000, enrichImage = null, enrichVoice = null, enrichSharedMedia = null }) {
    if (!Array.isArray(allowedGroups) || !allowedGroups.length || !allowedGroups.every(group => id(group) && group.endsWith('@chatroom'))) throw new Error('Explicit group allowlist required');
    if (!id(selfUserId)) throw new Error('Explicit self user ID required');
    if (store.accountId !== client.accountId) throw new Error('Account scope mismatch');
    if (typeof sendingEnabled !== 'boolean' || !Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('Invalid host send policy');
    if (enrichImage !== null && typeof enrichImage !== 'function') throw new Error('Invalid image enricher');
    if (enrichVoice !== null && typeof enrichVoice !== 'function') throw new Error('Invalid voice enricher');
    if (enrichSharedMedia !== null && typeof enrichSharedMedia !== 'function') throw new Error('Invalid shared media enricher');
    Object.assign(this, { client, store, selfUserId, consumer, sendingEnabled, cooldownMs, enrichImage, enrichVoice, enrichSharedMedia });
    this.allowed = new Set(allowedGroups);
    this.ingestion = Promise.resolve();
    this.delivery = Promise.resolve();
  }
  normalize(message, expectedId) {
    if (message.id !== expectedId || message.accountId !== this.client.accountId) throw new Error('Message identity mismatch');
    if (!id(message.threadId) || !this.allowed.has(message.threadId)) return { reason: 'group_not_allowed' };
    if (!id(message.senderId) || message.senderId === this.selfUserId || message.direction !== 'incoming') return { reason: 'self_or_unknown_direction' };
    const pat = [10000, 922746929].includes(message.type) && typeof message.body === 'string' &&
      /拍了拍(?:我|肥鱼不肥|肥鱼)(?:[\s。！!，,]|$)/u.test(message.body);
    const quoted = message.type === 49 && message.quote && typeof message.quote === 'object' &&
      typeof message.body === 'string' && message.body.trim().length > 0;
    const image = message.type === 3 && !message.recall;
    const voice = message.type === 34 && !message.recall;
    const shared = !quoted && !message.recall ? normalizeForwarded(message) ?? normalizeSharedMedia(message) : null;
    if ((message.type !== 1 && !image && !voice && !pat && !quoted && !shared) || (!image && !voice && !shared && typeof message.body !== 'string') || message.recall) {
      return { reason: 'non_text_or_recalled' };
    }
    if (message.serverId !== null && message.serverId !== undefined && !id(message.serverId)) throw new Error('Server ID must remain a string');
    if (message.createdAt !== null && (typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)))) throw new Error('Invalid event time');
    const mentions = message.mentions;
    if (mentions !== undefined && mentions !== null &&
        (typeof mentions !== 'object' || typeof mentions.state !== 'string' ||
          typeof mentions.self !== 'boolean' || !Array.isArray(mentions.userIds) ||
          !mentions.userIds.every(id))) throw new Error('Invalid mention metadata');
    const quote = message.quote && typeof message.quote === 'object' ? {
      serverId: typeof message.quote.serverId === 'string' ? message.quote.serverId : null,
      senderId: typeof message.quote.senderId === 'string' ? message.quote.senderId : null,
      type: Number.isSafeInteger(message.quote.type) ? message.quote.type : null,
      state: typeof message.quote.state === 'string' ? message.quote.state : null,
      text: typeof message.quote.embeddedText === 'string' ? message.quote.embeddedText : null,
      sticker: message.quote.embeddedSticker === true,
      image: message.quote.embeddedImage === true,
    } : null;
    return { reason: image ? 'image' : 'text', message: {
      platform: 'wechat', accountId: message.accountId, groupId: message.threadId,
      userId: message.senderId, sourceMessageId: message.id, serverId: message.serverId ?? null,
      text: image ? '[群友发送图片]' : voice ? '[群友发送语音]' : pat ? '拍了拍肥鱼' : message.body,
      interaction: image ? 'image' : voice ? 'voice' : pat ? 'pat' : 'text',
      ...(image || voice || shared ? { media: Array.isArray(message.media) ? message.media : [] } : {}),
      ...(voice ? { voiceState: 'pending' } : {}),
      ...(shared ?? {}),
      eventTime: message.createdAt, recordedAt: new Date().toISOString(),
      quote,
      mentions: mentions ? { state: mentions.state, self: pat || mentions.self,
        userIds: mentions.userIds } : { state: pat ? 'known' : 'unknown', self: pat, userIds: [] },
    } };
  }
  ingest(event, signal) {
    const work = this.ingestion.then(() => this.ingestSerial(event, signal));
    this.ingestion = work.catch(() => {});
    return work;
  }
  async ingestSerial(event, signal) {
    const next = cursor(event.cursor);
    if (!id(event.kind)) throw new Error('Invalid event kind');
    if (BigInt(next) <= BigInt(this.store.cursor())) return false;
    let normalized = { reason: 'non_message_event' };
    if (event.kind === 'message.committed') {
      if (!id(event.data?.messageId) || !id(event.data?.threadId)) throw new Error('Event lacks message/group identity');
      if (!this.allowed.has(event.data.threadId)) normalized = { reason: 'group_not_allowed' };
      else if (event.data.origin === 'profile_import' || event.data.direction === 'outgoing') normalized = { reason: 'historical_or_outgoing' };
      else {
        const message = await this.client.message(event.data.messageId, signal);
        if (message.threadId !== event.data.threadId) throw new Error('Event/message group mismatch');
        normalized = this.normalize(message, event.data.messageId);
        if (['share', 'video'].includes(normalized.message?.interaction) && typeof this.enrichSharedMedia === 'function') {
          try {
            const original = normalized.message;
            const enriched = await this.enrichSharedMedia(original, signal);
            if (!enriched || ['accountId', 'groupId', 'userId', 'sourceMessageId', 'interaction']
              .some(key => enriched[key] !== original[key])) throw new Error('Shared media enrichment scope mismatch');
            normalized = { reason: original.interaction, message: enriched };
          } catch (error) {
            normalized = { reason: 'shared_media_unavailable', message: { ...normalized.message,
              text: normalized.message.interaction === 'video' ? '[群友发送视频；暂时无法识别内容]' : normalized.message.text,
              sharedMediaState: 'failed', sharedMediaError: error.name } };
          }
        }
        if (normalized.message?.interaction === 'image' && typeof this.enrichImage === 'function') {
          try {
            const enriched = await this.enrichImage(normalized.message, signal);
            normalized = enriched ? { reason: 'image', message: enriched }
              : { reason: 'image_unavailable' };
          } catch (error) {
            normalized = { reason: 'image_unavailable', message: { ...normalized.message,
              text: '[群友发送图片；暂时无法识别内容]', imageError: error.name,
              imageErrorMessage: String(error.message ?? '').slice(0, 300) } };
          }
        }
        if (normalized.message?.interaction === 'voice' && typeof this.enrichVoice === 'function') {
          try {
            const enriched = await this.enrichVoice(normalized.message, signal);
            normalized = enriched ? { reason: 'voice', message: enriched }
              : { reason: 'voice_unavailable', message: { ...normalized.message,
                text: '[群友发送语音；暂时无法识别]', voiceState: 'failed' } };
          } catch (error) {
            normalized = { reason: 'voice_unavailable', message: { ...normalized.message,
              text: '[群友发送语音；暂时无法识别]', voiceState: 'failed',
              voiceAttempts: (normalized.message.voiceAttempts ?? 0) + 1,
              voiceError: error.name, voiceErrorMessage: error.message.slice(0, 300) } };
          }
        }
      }
    }
    const inserted = this.store.commitEvent(next, normalized.message, normalized.reason);
    // Local durable commit is authoritative even if the remote ack fails.
    await this.client.ack(this.consumer, next, signal);
    return inserted;
  }
  async syncOnce(signal) {
    if (this.store.cursor() !== '0') await this.client.ack(this.consumer, this.store.cursor(), signal);
    for await (const event of this.client.events(this.store.cursor(), signal)) await this.ingest(event, signal);
  }
  async watch(signal, { reconnectMs = 500, maxReconnects = Infinity } = {}) {
    for (let attempt = 0; !signal?.aborted; attempt++) {
      try { await this.syncOnce(signal); }
      catch (error) {
        if (signal?.aborted) return;
        if (error instanceof ApiError && (['event_cursor_expired', 'invalid_cursor'].includes(error.code) || [401, 403].includes(error.status))) {
          this.store.trace('stream.blocked', { code: error.code });
          throw error; // Requires explicit reconciliation; never reset to zero silently.
        }
        this.store.trace('stream.retry', { attempt, errorType: error.name });
      }
      if (attempt >= maxReconnects) return;
      await delay(Math.min(reconnectMs * 2 ** Math.min(attempt, 6), 30000), undefined, { signal });
    }
  }
  drain(handler) {
    const work = this.delivery.then(() => this.drainSerial(handler));
    this.delivery = work.catch(() => {});
    return work;
  }
  async drainSerial(handler) {
    for (const row of this.store.pending()) {
      // Handler must be idempotent by accountId + sourceMessageId. Crash can replay it.
      await handler(row.message);
      this.store.delivered(row.id);
    }
  }
  propose({ key, groupId, text, mentionUserIds = [], quote = null }) {
    if (!id(key) || key.length > 200 || /[\u0000-\u001f]/.test(key)) throw new Error('Invalid idempotency key');
    if (!this.allowed.has(groupId)) throw new Error('Group is not authorized');
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 16 * 1024) throw new Error('Invalid text proposal');
    return this.store.draft(key, groupId, text, mentionUserIds, quote);
  }
  async reconcile(key, signal) {
    const prior = this.store.sendRecord(key);
    if (!prior || prior.state === 'draft') throw new Error('No previous send attempt to reconcile');
    if (['voice', 'image_recall', 'pat'].includes(JSON.parse(prior.receipt ?? 'null')?.channel)) return prior; // Dedicated native job reconcilers own these channels.
    if (['accepted', 'failed', 'cancelled'].includes(prior.state)) return prior;
    try {
      const receipt = prior.receipt ? JSON.parse(prior.receipt) : null;
      const remote = receipt?.id ? await this.client.sendStatus(receipt.id, signal) : await this.client.sendByKey(key, signal);
      return this.acceptReceipt(key, remote);
    } catch (error) {
      if (signal?.aborted) throw error;
      return this.store.receipt(key, 'needs_review', prior.receipt ? JSON.parse(prior.receipt) : null);
    }
  }
  acceptReceipt(key, receipt) {
    const row = this.store.sendRecord(key);
    if (!id(receipt?.id) || receipt.accountId !== this.client.accountId || receipt.destination !== row.group_id ||
        !['queued', 'submitting', 'accepted', 'failed', 'needs_review', 'cancelled'].includes(receipt.state)) throw new Error('Send receipt identity/state mismatch');
    return this.store.receipt(key, receipt.state, receipt);
  }
  async sendApproved(key, signal, { authorize = () => true } = {}) {
    if (!this.sendingEnabled) throw new Error('Real sending is disabled by host policy');
    const row = this.store.sendRecord(key);
    if (!row || !this.allowed.has(row.group_id)) throw new Error('Unknown or unauthorized send');
    if (row.state !== 'draft') return this.reconcile(key, signal); // Never POST again automatically.
    const quote = JSON.parse(row.quote_json ?? 'null');
    if (quote) {
      try { await verifyQuoteReference({ client: this.client, accountId: this.client.accountId, groupId: row.group_id, quote, signal }); }
      catch { return this.store.receipt(key, 'failed', { reason: 'quote_source_unavailable' }); }
    }
    if (!await authorize(row)) return this.store.receipt(key, 'cancelled', { reason: 'interaction_preference_changed' });
    const claim = this.store.claim(key, this.cooldownMs);
    try { return this.acceptReceipt(key, await this.client.send(claim.group_id, claim.text, key, signal,
      JSON.parse(claim.mentions_json), quote)); }
    catch {
      this.store.receipt(key, 'needs_review');
      return this.reconcile(key, signal);
    }
  }
}
