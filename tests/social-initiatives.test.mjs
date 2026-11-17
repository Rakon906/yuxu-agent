import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { initProactiveLedger } from '../packages/participation/proactive.mjs';
import { LifeEventStore } from '../packages/life-events/index.mjs';
import { SubscriptionStore, defaultSubscriptions, refreshSubscriptions } from '../packages/subscriptions/index.mjs';
import { collectLifeEvents, runSocialInitiative } from '../packages/social-runtime/initiatives.mjs';
const accountId = 'a', groupId = 'g@chatroom';
const now = Date.parse('2026-11-13T11:00:00Z');
const at = new Date(now - 86400000).toISOString();
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'social-initiative-'));
  const inboxPath = join(dir, 'inbox.sqlite'), inbox = new AdapterStore(inboxPath, accountId);
  const store = new AdapterStore(join(dir, 'ledger.sqlite'), accountId), ledger = new ParticipationLedger(store);
  const events = new LifeEventStore(join(dir, 'events.sqlite'));
  let calls = 0, sends = 0;
  const adapter = { client: { accountId }, allowed: new Set([groupId]), store,
    propose: ({ key, groupId, text }) => store.draft(key, groupId, text),
    sendApproved: async key => { sends++; store.db.prepare('UPDATE outbox SET attempted_at=? WHERE key=?').run(now, key); return store.receipt(key, 'accepted'); },
    reconcile: async key => store.sendRecord(key) };
  const source = { id: 's1', senderId: 'friend', at, text: '我明天面试' };
  const add = (id, text, time = at) => inbox.commitEvent(String(inbox.db.prepare('SELECT COUNT(*) n FROM inbox').get().n + 1),
    { accountId, groupId, sourceMessageId: id, userId: 'friend', text, eventTime: time, recordedAt: time }, 'text');
  const model = async () => { calls++; return { shouldReply: true, reply: '今天面试怎么样呀' }; };
  const options = { events, ledger, adapter, model, inboxPath, accountId, groupId, now, sendEnabled: true };
  t.after(() => { events.close(); inbox.close(); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { events, ledger, inbox, add, source, options, run: extra => runSocialInitiative({ ...options, ...extra }),
    get calls() { return calls; }, get sends() { return sends; } };
}
test('cross-day event produces one natural followup using the common proactive ledger', async t => {
  const f = fixture(t); f.add('s1', f.source.text);
  assert.equal(f.events.ingest({ accountId, groupId, messages: [f.source], now: now - 86400000 }).created, 1);
  assert.equal((await f.run()).status, 'sent'); assert.equal(f.sends, 1);
  assert.equal((await f.run()).status, 'waiting'); assert.equal(f.calls, 1);
  assert.equal(f.events.list({ accountId, groupId, states: ['sent'] }).length, 1);
});
test('recent conversation and existing daily quota suppress calls without discarding the due event', async t => {
  const f = fixture(t); f.add('s1', f.source.text);
  f.events.ingest({ accountId, groupId, messages: [f.source], now: now - 86400000 });
  f.add('s2', '继续聊天', new Date(now - 60000).toISOString());
  assert.equal((await f.run()).status, 'waiting'); assert.equal(f.calls, 0);
  f.inbox.db.prepare('DELETE FROM inbox WHERE id=?').run('s2'); initProactiveLedger(f.ledger);
  for (let i = 0; i < 4; i++) f.ledger.db.prepare('INSERT INTO proactive_slots(group_id,local_date,slot,state,checked_at,baseline_rowid) VALUES (?,?,?,?,?,?)')
    .run(groupId, '2026-11-13', `used-${i}`, 'sent', now, 1);
  assert.equal((await f.run()).status, 'waiting'); assert.equal(f.calls, 0);
});
test('a reply arriving during model work prevents stale followup and a changed source is never sent', async t => {
  const f = fixture(t); f.add('s1', f.source.text); f.events.ingest({ accountId, groupId, messages: [f.source], now: now - 86400000 });
  const result = await f.run({ model: async () => { f.add('s2', '我已经面试完了', new Date(now).toISOString()); return { shouldReply: true, reply: '面试咋样' }; } });
  assert.equal(result.status, 'skipped'); assert.equal(f.sends, 0);
});
test('initial local extractor ignores backlog and processes each new original once', t => {
  const f = fixture(t); f.add('s1', f.source.text);
  const options = { events: f.events, ledger: f.ledger, inboxPath: f.options.inboxPath, accountId, groupId, now };
  assert.equal(collectLifeEvents(options).initialized, true);
  assert.equal(f.events.list({ accountId, groupId }).length, 0);
  f.add('s2', '我明天考试', new Date(now).toISOString());
  assert.equal(collectLifeEvents(options).processed, 1);
  assert.equal(collectLifeEvents(options).processed, 0);
  assert.equal(f.events.list({ accountId, groupId }).length, 1);
});

test('official interest updates use the same initiative path and deliver once', async t => {
  const f = fixture(t), subscriptions = new SubscriptionStore(':memory:');
  t.after(() => subscriptions.close());
  const match = { __typename: 'EventMatch', id: '1234567890', startTime: new Date(now + 86400000).toISOString(),
    state: 'unstarted', type: 'match', league: { name: 'Worlds' }, match: { strategy: { count: 5 } },
    matchTeams: ['BLG', 'GEN'].map(code => ({ code, name: code, result: { gameWins: 0 } })) };
  await refreshSubscriptions({ store: subscriptions, config: defaultSubscriptions({ accountId, groupIds: [groupId] }), now,
    fetchImpl: async url => new Response(url.includes('lolesports')
      ? `<script>(window[Symbol.for("ApolloSSRDataTransport")]??=[]).push(${JSON.stringify({ events: [match] })})</script>`
      : `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { page: { blades: [{ items: [
        { title: 'League of Legends Patch 26.22 Notes', publishedAt: new Date(now - 86400000).toISOString(),
          action: { payload: { url: '/en-us/news/game-updates/league-of-legends-patch-26-22-notes' } } } ] }] } } } })}</script>`) });
  let modelCalls = 0;
  const model = async request => {
    modelCalls++; assert.equal(request.kind, 'interest_update');
    assert.equal(request.initiative.officialUpdate.status, 'scheduled');
    return { shouldReply: true, reply: '明晚BLG打GEN，有人看嘛' };
  };
  assert.equal((await f.run({ subscriptions, model })).status, 'sent');
  assert.equal((await f.run({ subscriptions, model })).status, 'waiting');
  assert.equal(modelCalls, 1); assert.equal(f.sends, 1);
  assert.equal(subscriptions.candidates({ accountId, groupId, now }).length, 0);
});
