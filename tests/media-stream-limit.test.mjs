import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';

test('daemon media limit also bounds chunked responses without Content-Length', async t => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'video/mp4');
    if (req.url.endsWith('/small')) { res.write('abc'); res.end('def'); return; }
    res.write(Buffer.alloc(1024));
    const interval = setInterval(() => res.write(Buffer.alloc(1024)), 2);
    res.once('close', () => clearInterval(interval));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new WeChatClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, accountId: 'a', token: 'fixture-token' });
  assert.equal((await client.requestBytes('/small', { limit: 6 })).bytes.toString(), 'abcdef');
  await assert.rejects(client.requestBytes('/large', { limit: 1500 }), /too large/);
  await assert.rejects(client.requestBytes('/large', { limit: 0 }), /Invalid media byte limit/);
});
