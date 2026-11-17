import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export const ACCOUNT = 'synthetic-account';
export const GROUP = 'synthetic-group@chatroom';
export const SELF = 'wxid_synthetic_self';
export const TOKEN = 'synthetic-test-token';
export function message(id, overrides = {}) {
  return { id, accountId: ACCOUNT, threadId: GROUP, serverId: '18446744073709551615',
    senderId: 'wxid_synthetic_alice', direction: 'incoming', type: 1, body: '这是一条合成测试消息。',
    createdAt: '2026-10-30T10:00:00+08:00', mentions: { state: 'known', userIds: [], self: false, all: false, source: null },
    version: '1', media: [], ...overrides };
}
export function event(value, messageId, extra = {}) {
  return { cursor: String(value), kind: 'message.committed',
    data: { messageId, threadId: GROUP, direction: 'incoming', origin: 'sync', ...extra }, createdAt: '2026-10-30T10:00:00Z' };
}

export async function startWeChatFixture() {
  const state = { messages: new Map(), events: [], receipts: new Map(), posts: 0, gets: [], acks: [], connections: [],
    ackFailures: 0, streamError: null, firstStreamLimit: null, sendMode: 'accepted', bodyMismatch: false,
    lastSendInput: null };
  const server = createServer(async (req, res) => {
    try {
      const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: { code: 'unauthorized' } });
      const url = new URL(req.url, 'http://fixture');
      const base = `/v1/accounts/${ACCOUNT}`;
      const path = url.pathname.slice(base.length);
      if (!url.pathname.startsWith(`${base}/`)) return json(404, { error: { code: 'not_found' } });
      if (path === '/events/stream') {
        const after = url.searchParams.get('after'); state.connections.push(after);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(': connected\r\n\r\n');
        if (state.streamError) { res.end(`event: error\ndata: ${JSON.stringify({ error: { code: state.streamError } })}\n\n`); return; }
        let events = state.events.filter(item => BigInt(item.cursor) > BigInt(after));
        if (state.connections.length === 1 && state.firstStreamLimit !== null) events = events.slice(0, state.firstStreamLimit);
        for (const item of events) {
          const frame = `id: ${item.cursor}\r\ndata: ${JSON.stringify(item)}\r\n\r\n`;
          // Fragment at arbitrary UTF-8 byte positions; exercise streaming decoding.
          const bytes = Buffer.from(frame); for (let i = 0; i < bytes.length; i += 7) res.write(bytes.subarray(i, i + 7));
        }
        res.end(); return;
      }
      if (path.startsWith('/messages/')) {
        const id = decodeURIComponent(path.slice('/messages/'.length)); state.gets.push(id);
        return state.messages.has(id) ? json(200, state.messages.get(id)) : json(404, { error: { code: 'not_found' } });
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      if (path.includes('/consumers/') && path.endsWith('/ack')) {
        if (state.ackFailures > 0) { state.ackFailures--; return json(503, { error: { code: 'temporarily_unavailable' } }); }
        state.acks.push(JSON.parse(body).cursor); return json(200, { ok: true });
      }
      if (path === '/sends' && req.method === 'POST') {
        state.posts++;
        const key = req.headers['idempotency-key'];
        const input = JSON.parse(body);
        state.lastSendInput = input;
        const receipt = { id: randomUUID(), accountId: ACCOUNT, destination: input.threadId,
          state: ['needs_review', 'queued'].includes(state.sendMode) ? state.sendMode : 'accepted', clientId: null,
          serverId: '18446744073709551615', errorCode: null, createdAt: new Date().toISOString() };
        if (state.sendMode !== 'unknown-missing') state.receipts.set(key, receipt);
        if (['drop-after-accept', 'unknown-missing'].includes(state.sendMode)) { res.destroy(); return; }
        return json(202, receipt);
      }
      if (path === '/sends/by-idempotency-key') {
        const value = state.receipts.get(url.searchParams.get('key'));
        return value ? json(200, value) : json(404, { error: { code: 'not_found' } });
      }
      if (path.startsWith('/sends/')) {
        const value = [...state.receipts.values()].find(item => item.id === path.slice('/sends/'.length));
        return value ? json(200, value) : json(404, { error: { code: 'not_found' } });
      }
      json(404, { error: { code: 'not_found' } });
    } catch { if (!res.destroyed) { res.writeHead(500); res.end(); } }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { state, origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}
