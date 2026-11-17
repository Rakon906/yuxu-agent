import assert from 'node:assert/strict';
import { join } from 'node:path';
import { prepareRun, createRuntime } from './runtime.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { createHarnessDraftHandler } from '../packages/wechat-adapter/harness-bridge.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN, event, message } from '../tests/fixtures/wechat-server.mjs';

const run = await prepareRun('wechat-demo');
const server = await startWeChatFixture();
const store = new AdapterStore(join(run.runRoot, 'adapter.sqlite'), ACCOUNT);
const client = new WeChatClient({ baseUrl: server.origin, token: TOKEN, accountId: ACCOUNT });
const adapter = new WeChatAdapter({ client, store, allowedGroups: [GROUP], selfUserId: SELF });
const runtime = createRuntime(run, { groupId: GROUP });
try {
  server.state.messages.set('synthetic-message-1', message('synthetic-message-1'));
  server.state.events = [event(1, 'synthetic-message-1'), event(2, 'synthetic-message-1')];
  await adapter.syncOnce();
  console.log('OFFLINE ONLY: loopback simulated Yuxu WeChat API; no real account or daemon connection.');
  console.log('Events:', server.state.events.length, 'deduplicated inbox:', store.pending().length);
  assert.equal(store.pending().length, 1);
  await adapter.drain(createHarnessDraftHandler({ runtime, adapter, groupId: GROUP }));
  const drafts = store.db.prepare('SELECT key,state,approved,text FROM outbox').all();
  console.log('Harness draft:', drafts[0]);
  console.log('Network send requests:', server.state.posts);
  assert.equal(drafts[0].state, 'draft'); assert.equal(drafts[0].approved, 0); assert.equal(server.state.posts, 0);
} finally {
  await runtime.close(); store.close(); await server.close();
}
console.log('Artifacts:', run.runRoot);
