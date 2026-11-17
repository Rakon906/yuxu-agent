const nonEmpty = value => typeof value === 'string' && value.length > 0;

function encode(value) {
  return encodeURIComponent(value);
}

function replacePath(template, values) {
  if (typeof template !== 'string' || !template.startsWith('/')) throw new Error('Moment endpoint must be an absolute path');
  return template.replace(/\{(accountId|momentId|operationId)\}/gu, (_, key) => encode(values[key]));
}

function queryString(query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length) params.set(key, value.join(','));
    } else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export class MomentsApiError extends Error {
  constructor(status, code) {
    super(`Moments provider HTTP ${status}: ${code}`);
    this.name = 'MomentsApiError';
    this.status = status;
    this.code = code;
  }
}

export const DEFAULT_MOMENTS_ENDPOINTS = Object.freeze({
  capabilities: '/v1/accounts/{accountId}/moments/capabilities',
  timeline: '/v1/accounts/{accountId}/moments',
  detail: '/v1/accounts/{accountId}/moments/{momentId}',
  publish: '/v1/accounts/{accountId}/moments',
  publishStatus: '/v1/accounts/{accountId}/moments/{operationId}/publish',
});

export class MomentsHttpClient {
  constructor({ baseUrl, token, accountId, timeoutMs = 15000, endpoints = {} }) {
    const url = new URL(baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
      throw new Error('Use a bare moments provider origin');
    }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) {
      throw new Error('Remote moments provider requires HTTPS');
    }
    if (!nonEmpty(token) || /[\r\n]/u.test(token)) throw new Error('Missing or invalid moments provider token');
    if (!nonEmpty(accountId)) throw new Error('Missing moments account ID');
    if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 300000) throw new Error('Invalid moments timeout');
    this.origin = url.origin;
    this.token = token;
    this.accountId = accountId;
    this.timeoutMs = timeoutMs;
    this.endpoints = { ...DEFAULT_MOMENTS_ENDPOINTS, ...endpoints };
  }

  async request(path, { method = 'GET', query, body, idempotencyKey, signal } = {}) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response;
    try {
      response = await fetch(`${this.origin}${path}${queryString(query)}`, {
        method,
        redirect: 'error',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(idempotencyKey === undefined ? {} : { 'Idempotency-Key': idempotencyKey }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new MomentsApiError(599, error.name === 'TimeoutError' ? 'timeout' : 'transport_error');
    }
    if (!response.ok) {
      let code = 'request_failed';
      try {
        const error = await response.json();
        if (/^[a-z0-9_]+$/iu.test(error.error?.code)) code = error.error.code;
      } catch {}
      throw new MomentsApiError(response.status, code);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Moments response too large');
    if (!text.trim()) return {};
    try { return JSON.parse(text); }
    catch { throw new Error('Moments provider returned invalid JSON'); }
  }

  capabilities(signal) {
    return this.request(replacePath(this.endpoints.capabilities, { accountId: this.accountId }), { signal });
  }

  timeline(query, signal) {
    return this.request(replacePath(this.endpoints.timeline, { accountId: this.accountId }), { query, signal });
  }

  detail(momentId, signal) {
    if (!nonEmpty(momentId)) throw new Error('Missing moment ID');
    return this.request(replacePath(this.endpoints.detail, { accountId: this.accountId, momentId }), { signal });
  }

  publish(payload, idempotencyKey, signal) {
    return this.request(replacePath(this.endpoints.publish, { accountId: this.accountId }), {
      method: 'POST', body: payload, idempotencyKey, signal,
    });
  }

  publishStatus(operationId, signal) {
    if (!nonEmpty(operationId)) throw new Error('Missing publish operation ID');
    return this.request(replacePath(this.endpoints.publishStatus, { accountId: this.accountId, operationId }), { signal });
  }
}
