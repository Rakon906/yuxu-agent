export class ApiError extends Error {
  constructor(status, code) {
    super(`Yuxu WeChat HTTP ${status}: ${code}`);
    this.status = status;
    this.code = code;
  }
}

const encode = value => encodeURIComponent(value);
export function cursor(value) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) throw new Error('Invalid string event cursor');
  return BigInt(value).toString();
}

export class WeChatClient {
  constructor({ baseUrl, token, accountId, timeoutMs = 10000 }) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a bare daemon origin');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote daemon requires HTTPS');
    }
    if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw new Error('Missing or invalid local API token');
    if (typeof accountId !== 'string' || !accountId) throw new Error('Missing account ID');
    this.origin = url.origin;
    this.token = token;
    this.accountId = accountId;
    this.timeoutMs = timeoutMs;
  }

  async request(path, { method = 'GET', body, key, signal, stream = false } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const headerController = new AbortController();
    const headerTimer = setTimeout(() => headerController.abort(new Error('Daemon header timeout')), this.timeoutMs);
    let response;
    try { response = await fetch(`${this.origin}/v1/accounts/${encode(this.accountId)}${path}`, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, Accept: stream ? 'text/event-stream' : 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(key === undefined ? {} : { 'Idempotency-Key': key }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: stream ? AbortSignal.any([headerController.signal, ...(signal ? [signal] : [])]) : signal ? AbortSignal.any([signal, timeout]) : timeout,
    }); } finally { clearTimeout(headerTimer); }
    if (!response.ok) {
      // Never include daemon bodies, URLs with secrets, or credentials in diagnostics.
      let code = 'request_failed';
      try { const error = await response.json(); if (/^[a-z0-9_]+$/i.test(error.error?.code)) code = error.error.code; } catch {}
      throw new ApiError(response.status, code);
    }
    if (stream) return response;
    const text = await response.text();
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error('Daemon response too large');
    return JSON.parse(text);
  }

  message(id, signal) { return this.request(`/messages/${encode(id)}`, { signal }); }
  messageMedia(id, signal) { return this.request(`/messages/${encode(id)}/media`, { signal }); }
  mediaContent(id, signal) {
    return this.requestBytes(`/media/${encode(id)}/content`,
      { signal, accept: 'audio/wav,application/octet-stream' });
  }
  async requestBytes(path, { signal, limit = 16 * 1024 * 1024,
    accept = 'application/octet-stream' } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 128 * 1024 * 1024) throw new Error('Invalid media byte limit');
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.origin}/v1/accounts/${encode(this.accountId)}${path}`, {
      method: 'GET', redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, Accept: accept },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) {
      let code = 'request_failed';
      try { const error = await response.json(); if (/^[a-z0-9_]+$/i.test(error.error?.code)) code = error.error.code; } catch {}
      throw new ApiError(response.status, code);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isSafeInteger(length) && length > limit) {
      await response.body?.cancel();
      throw new Error('Daemon media response too large');
    }
    if (!response.body) throw new Error('Daemon media response is empty');
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      while (true) {
        signal?.throwIfAborted();
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > limit) throw new Error('Daemon media response too large');
        chunks.push(Buffer.from(part.value));
      }
      return { bytes: Buffer.concat(chunks, size), contentType: response.headers.get('content-type') };
    } catch (error) { try { await reader.cancel(); } catch {} throw error; }
    finally { reader.releaseLock(); }
  }
  ack(consumer, value, signal) { return this.request(`/consumers/${encode(consumer)}/ack`, { method: 'POST', body: { cursor: cursor(value) }, signal }); }
  send(threadId, text, key, signal, mentionUserIds = [], quote = null) { return this.request('/sends', {
    method: 'POST', body: { threadId, text,
      ...(quote ? { quote } : {}),
      ...(mentionUserIds.length ? { mentions: { userIds: mentionUserIds } } : {}) }, key, signal }); }
  sendSticker(threadId, sticker, key, signal) { return this.request('/sends', {
    method: 'POST', body: { kind: 'sticker', threadId, md5: sticker.md5,
      length: sticker.length, xml: sticker.xml }, key, signal }); }
  sendByKey(key, signal) { return this.request(`/sends/by-idempotency-key?key=${encode(key)}`, { signal }); }
  sendStatus(id, signal) { return this.request(`/sends/${encode(id)}`, { signal }); }

  async *events(after, signal) {
    const response = await this.request(`/events/stream?after=${cursor(after)}`, { signal, stream: true });
    if (!response.headers.get('content-type')?.startsWith('text/event-stream')) throw new Error('Expected SSE response');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', data = [], id = '', eventType = '';
    try {
      while (true) {
        signal?.throwIfAborted();
        let timer;
        const part = await Promise.race([
          reader.read(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('SSE idle timeout')), 45000); }),
        ]).finally(() => clearTimeout(timer));
        if (part.done) break;
        buffer += decoder.decode(part.value, { stream: true });
        if (Buffer.byteLength(buffer) > 2 * 1024 * 1024) throw new Error('SSE frame too large');
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
          if (line === '') {
            if (data.length) {
              const value = JSON.parse(data.join('\n'));
              if (eventType === 'error') throw new ApiError(409, value.error?.code ?? 'stream_error');
              if (id && value.cursor !== id) throw new Error('SSE cursor identity mismatch');
              yield value;
            }
            data = []; id = ''; eventType = '';
          } else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
          else if (line.startsWith('id:')) id = line.slice(3).trim();
          else if (line.startsWith('event:')) eventType = line.slice(6).trim();
          if (Buffer.byteLength(data.join('\n')) > 2 * 1024 * 1024) throw new Error('SSE event too large');
        }
      }
      // An unfinished frame is replayed from the last durable cursor on reconnect.
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
