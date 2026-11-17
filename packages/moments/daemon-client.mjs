/**
 * Daemon client for the read-only Moments probe surface.
 *
 * Only read cgis are accepted by the daemon; this client mirrors that bound so a
 * caller cannot accidentally address a publishing endpoint.
 */
import { downloadNativeMomentImage } from './native-image.mjs';

export const READ_CGIS = new Map([
  [210, '/cgi-bin/micromsg-bin/mmsnsobjectdetail'],
  [211, '/cgi-bin/micromsg-bin/mmsnstimeline'],
  [214, '/cgi-bin/micromsg-bin/mmsnssync'],
]);

const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class MomentsDaemonClient {
  constructor({ baseUrl, token, accountId, timeoutMs = 20000 }) {
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

  async downloadImage(momentId, media) {
    return downloadNativeMomentImage({ client: this, momentId, media });
  }

  async probe(cgi, bodyHex = '', { withBaseRequest = false, write = false } = {}) {
    if (!READ_CGIS.has(cgi)) {
      if (!write || ![218, 213].includes(cgi)) {
        throw new Error(`Only read-only Moments cgis are allowed: ${[...READ_CGIS.keys()].join(', ')}`);
      }
    }
    if (typeof bodyHex !== 'string' || bodyHex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(bodyHex)) throw new Error('Request body must be hex');
    const payload = { cgi, bodyHex };
    if (withBaseRequest) payload.withBaseRequest = true;
    if (write) payload.write = true;
    const response = await fetch(`${this.origin}/v1/accounts/${encodeURIComponent(this.accountId)}/moments/probe`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      let code = 'request_failed';
      try { const error = await response.json(); if (typeof error.error?.code === 'string') code = error.error.code; } catch {}
      if (response.status === 404) throw new Error('daemon_route_missing: 当前运行的 Yuxu 微信引擎还是旧进程，重启后才会加载新版本的 /moments/probe');
      throw new Error(`Moments probe failed: HTTP ${response.status} ${code}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) throw new Error('Moments probe response too large');
    return JSON.parse(text);
  }
}
