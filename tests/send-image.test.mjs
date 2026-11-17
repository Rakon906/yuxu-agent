import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { projectRoot } from '../scripts/runtime.mjs';
import { sendImageWithStandard } from '../packages/wechat-adapter/send-image.mjs';

test('a large original is uploaded once and the native sender owns preview preparation', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'hd-image-http-'));
  const original = Buffer.alloc(700000, 0x41);
  const imagePath = join(root, 'synthetic.jpg');
  await writeFile(imagePath, original);
  const uploads = [], sends = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    res.setHeader('Content-Type', 'application/json');
    if (req.url.endsWith('/uploads')) {
      uploads.push(body);
      res.end(JSON.stringify({ id: 'source-original' }));
    } else if (req.url.endsWith('/sends')) {
      sends.push(JSON.parse(body));
      assert.equal(req.headers['idempotency-key'], 'synthetic-hd-image');
      res.end(JSON.stringify({ id: 'job-test', state: 'accepted', phase: 'completed' }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const client = { origin: `http://127.0.0.1:${server.address().port}`, accountId: 'synthetic', token: 'synthetic' };
  const result = await sendImageWithStandard(client, { threadId: 'filehelper', imagePath, key: 'synthetic-hd-image' });
  assert.equal(result.phase, 'completed');
  assert.equal(uploads.length, 1);
  assert.ok(uploads[0].includes(original), 'multipart upload must retain every original byte');
  assert.deepEqual(sends, [{ threadId: 'filehelper', kind: 'image', sourceId: 'source-original',
    standardSourceId: null, thumbnailSourceId: null }]);
});
