import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SubscriptionStore, defaultSubscriptions, refreshSubscriptions, validateOfficialReply } from '../packages/subscriptions/index.mjs';
import { parseRiotSchedule, parseRiotPatches, OFFICIAL_SOURCES } from '../packages/subscriptions/sources.mjs';

const now = Date.parse('2026-11-13T06:00:00Z'), DAY = 86400000;
const scope = { accountId: 'test-account', groupId: 'test-group@chatroom' };
const config = defaultSubscriptions({ accountId: scope.accountId, groupIds: [scope.groupId] });
// These existing scenarios exercise Riot feeds; Delta has its own transport/fixtures.
config.subscriptions = config.subscriptions.filter(item => item.sourceId.startsWith('lol-'));
function matchEvent({ id = '1234567890', at = now + 86400000, state = 'unstarted', score = [0, 0], teams = ['BLG', 'GEN'] } = {}) {
  return { __typename: 'EventMatch', id, startTime: new Date(at).toISOString(), state, type: 'match',
    league: { name: 'Worlds' }, blockName: 'Finals', match: { strategy: { count: 5 } },
    matchTeams: teams.map((code, index) => ({ code, name: code, result: { gameWins: score[index] } })) };
}
const schedule = (...events) => `<script>(window[Symbol.for("ApolloSSRDataTransport")]??=[]).push({"events":${JSON.stringify(events)}})</script>`;
const patchItem = (version = '26-22', at = now - 86400000, description = 'Official patch highlights.') => ({
  title: `League of Legends Patch ${version.replace('-', '.')} Notes`, publishedAt: new Date(at).toISOString(),
  action: { payload: { url: `/en-us/news/game-updates/league-of-legends-patch-${version}-notes` } }, description: { body: description } });
const patches = (...items) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { page: { blades: [{ items }] } } } })}</script>`;
function responses({ scheduleBody = schedule(matchEvent()), patchBody = patches(patchItem()), status = 200, etag = 'v1', seen = [] } = {}) {
  return async (url, options) => {
    seen.push({ url, options });
    return new Response(status === 304 ? null : url === OFFICIAL_SOURCES['lol-esports'].url ? scheduleBody : patchBody,
      { status, headers: { etag } });
  };
}

test('official parsers retain precise UTC schedule and restrict patch URLs without executing scripts', () => {
  const [event] = parseRiotSchedule(schedule(matchEvent()));
  assert.equal(event.startTime, '2026-11-14T06:00:00.000Z');
  assert.equal(event.status, 'scheduled');
  assert.equal(event.teams[0].code, 'BLG');
  assert.equal(event.bestOf, 5);
  const [patch] = parseRiotPatches(patches(patchItem()));
  assert.match(patch.sourceUrl, /^https:\/\/www\.leagueoflegends\.com\//u);
  const injected = patchItem(); injected.action.payload.url = 'https://evil.example/patch-26-22';
  assert.throws(() => parseRiotPatches(patches(injected)), /No validated/u);
  assert.throws(() => parseRiotSchedule(schedule({ ...matchEvent(), startTime: '2026-11-14 14:00:00' })), /No validated/u);
  assert.throws(() => parseRiotSchedule('<script>throw new Error("do not execute")</script>'), /format/u);
  assert.throws(() => parseRiotSchedule(schedule(matchEvent(), matchEvent({ state: 'inProgress' }))), /Conflicting/u);
  const archive = Array.from({ length: 177 }, (_, i) => patchItem(`25-${i + 1}`, now - i * 86400000));
  assert.equal(parseRiotPatches(patches(...archive)).length, 100);
});

test('first scan baselines old patches, offers only subscribed upcoming matches and never assumes disappearance is cancellation', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    const scheduleBody = schedule(matchEvent(), matchEvent({ id: '9999999999', teams: ['T1', 'DK'] }),
      matchEvent({ id: '8888888888', at: now - 7 * 86400000, state: 'completed' }));
    const results = await refreshSubscriptions({ store, config, now, fetchImpl: responses({ scheduleBody }) });
    assert.equal(results.every(r => r.status === 'ok'), true);
    const candidates = store.candidates({ ...scope, now });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].phase, 'upcoming');
    assert.equal(candidates[0].officialEvidence, true);
    assert.match(candidates[0].localStart, /14:00/u);
    assert.deepEqual(store.candidates({ accountId: 'other-account', groupId: scope.groupId, now }), []);
    assert.deepEqual(store.candidates({ accountId: scope.accountId, groupId: 'other-group@chatroom', now }), []);
    await refreshSubscriptions({ store, config, now: now + 1800000, fetchImpl: responses({ scheduleBody: schedule(matchEvent({ id: '9999999999', teams: ['T1', 'DK'] })) }) });
    assert.deepEqual(store.candidates({ ...scope, now: now + 1800000 }), []);
  } finally { store.close(); }
});

test('conditional HTTP cache and content revisions avoid repeated work; new patch is offered without any model call', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    const seen = [];
    await refreshSubscriptions({ store, config, now, fetchImpl: responses({ seen }) });
    const waiting = await refreshSubscriptions({ store, config, now: now + 1000, fetchImpl: () => { throw new Error('must not fetch'); } });
    assert.equal(waiting.every(r => r.status === 'waiting'), true);
    const second = await refreshSubscriptions({ store, config, now: now + 1800000, fetchImpl: responses({ status: 304, seen }) });
    assert.equal(second.find(r => r.sourceId === 'lol-esports').status, 'unchanged');
    assert.equal(seen.at(-1).options.headers['If-None-Match'], 'v1');
    assert.equal(store.candidates({ ...scope, now: now + 1800000 }).length, 1);
    const updatedAt = now + 6 * 3600000;
    await refreshSubscriptions({ store, config, now: updatedAt,
      fetchImpl: responses({ patchBody: patches(patchItem('26-23', updatedAt - 60000), patchItem()) }) });
    const offered = store.candidates({ ...scope, now: updatedAt });
    assert.equal(offered.filter(c => c.kind === 'patch').length, 1);
    const patch = offered.find(c => c.kind === 'patch');
    assert.match(patch.title, /26\.23/u);
    const again = await refreshSubscriptions({ store, config, force: true, now: updatedAt + 1000,
      fetchImpl: responses({ patchBody: patches(patchItem('26-23', updatedAt - 60000), patchItem()) }) });
    assert.equal(again.reduce((n, r) => n + r.updated, 0), 0);
  } finally { store.close(); }
});

test('claim and settlement survive restart, scope cannot borrow delivery keys, unknown outcomes never re-send', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'subscriptions-'));
  const filename = join(dir, 'subscriptions.sqlite');
  let store = new SubscriptionStore(filename);
  try {
    await refreshSubscriptions({ store, config, now, fetchImpl: responses() });
    const candidate = store.candidates({ ...scope, now })[0];
    assert.equal(store.claim(candidate, { ...scope, ownerKey: 'slot-1', now }), true);
    assert.equal(store.validateClaim(candidate, { ...scope, ownerKey: 'slot-1', now }), true);
    assert.equal(store.claim(candidate, { ...scope, ownerKey: 'slot-2', now }), false);
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'unknown', ownerKey: 'wrong-owner', now }), false);
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'unknown', ownerKey: 'slot-1', now }), true);
    store.close(); store = new SubscriptionStore(filename);
    assert.deepEqual(store.candidates({ ...scope, now: now + 1000 }), []);
    assert.equal(store.claim(candidate, { accountId: 'other-account', groupId: scope.groupId, ownerKey: 'slot-3', now }), false);
    // A real official reschedule has a new revision, independently eligible once.
    await refreshSubscriptions({ store, config, now: now + 1800000,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now + 30 * 3600000 })) }) });
    const changed = store.candidates({ ...scope, now: now + 1800000 })[0];
    assert.notEqual(changed.deliveryKey, candidate.deliveryKey);
    assert.equal(store.claim(candidate, { ...scope, ownerKey: 'stale-revision', now: now + 1800000 }), false);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('pre-send revalidation rejects an official revision or disabled subscription and pending receipts reconcile without another claim', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    await refreshSubscriptions({ store, config, now, fetchImpl: responses() });
    const candidate = store.candidates({ ...scope, now })[0];
    store.claim(candidate, { ...scope, ownerKey: 'pending-slot', now });
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'pending_receipt', ownerKey: 'pending-slot', outboxKey: 'outbox-1', now }), true);
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 60000 }).map(x => x.outboxKey), ['outbox-1']);
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'sent', ownerKey: 'pending-slot', outboxKey: 'outbox-1', now: now + 60001 }), true);
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 60000 }), []);
    assert.deepEqual(store.candidates({ ...scope, now }), []);
    await refreshSubscriptions({ store, config, now: now + 1800000,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now + 30 * 3600000 })) }) });
    const revised = store.candidates({ ...scope, now: now + 1800000 })[0];
    store.claim(revised, { ...scope, ownerKey: 'new-slot', now: now + 1800000 });
    store.configure({ subscriptions: [] }, now + 1800001);
    assert.equal(store.validateClaim(revised, { ...scope, ownerKey: 'new-slot', now: now + 1800001 }), false);
    store.configure(config, now + 1800002);
    assert.equal(store.validateClaim(revised, { ...scope, ownerKey: 'new-slot', now: now + 1800002 }), true);
    await refreshSubscriptions({ store, config, force: true, now: now + 1800003,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now + 31 * 3600000 })) }) });
    assert.equal(store.validateClaim(revised, { ...scope, ownerKey: 'new-slot', now: now + 1800003 }), false);
  } finally { store.close(); }
});

test('unknown and needs-review sends only reconcile with durable bounded backoff, then settle once', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    await refreshSubscriptions({ store, config, now, fetchImpl: responses() });
    const candidate = store.candidates({ ...scope, now })[0];
    store.claim(candidate, { ...scope, ownerKey: 'uncertain-slot', now });
    store.settle(candidate.deliveryKey, { ...scope, state: 'needs_review', ownerKey: 'uncertain-slot', outboxKey: 'uncertain-send', now });
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 59000 }), []);
    const first = store.pendingReceipts({ ...scope, now: now + 60000 });
    assert.equal(first.length, 1);
    // Even if the RPC throws and settle is never called, another immediate read is throttled.
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 60001 }), []);
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 179999 }), []);
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'unknown', ownerKey: 'uncertain-slot', now: now + 60001 }), true);
    const second = store.pendingReceipts({ ...scope, now: now + 180000 });
    assert.equal(second.length, 1); assert.equal(second[0].outboxKey, 'uncertain-send');
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'sent', ownerKey: 'uncertain-slot', now: now + 180001 }), true);
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + DAY }), []);
    assert.equal(store.claim(candidate, { ...scope, ownerKey: 'never-resend', now }), false);
    assert.equal(store.settle(candidate.deliveryKey, { ...scope, state: 'unknown', ownerKey: 'uncertain-slot', now: now + 180002 }), false);
  } finally { store.close(); }
});

test('receipt checks stop after eight attempts or seven days without erasing uncertain deliveries', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    await refreshSubscriptions({ store, config, now, fetchImpl: responses() });
    const candidate = store.candidates({ ...scope, now })[0];
    store.claim(candidate, { ...scope, ownerKey: 'bounded-slot', now });
    store.settle(candidate.deliveryKey, { ...scope, state: 'unknown', ownerKey: 'bounded-slot', outboxKey: 'pending-forever', now });
    for (let i = 0; i < 8; i++) assert.equal(store.pendingReceipts({ ...scope, now: now + (i + 1) * 6 * 3600000 }).length, 1);
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 3 * DAY }), []);
    const row = store.db.prepare('SELECT state,receipt_checks,last_receipt_check_at FROM interest_deliveries WHERE delivery_key=?').get(candidate.deliveryKey);
    assert.equal(row.state, 'unknown'); assert.equal(row.receipt_checks, 8);
    store.db.prepare('UPDATE interest_deliveries SET receipt_checks=0,last_receipt_check_at=NULL').run();
    assert.deepEqual(store.pendingReceipts({ ...scope, now: now + 8 * DAY }), []);
  } finally { store.close(); }
});

test('failed, stale, far-future, historical and disabled subscriptions cannot create spurious topics', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    const invalid = { subscriptions: [{ ...config.subscriptions[1], sourceId: 'custom', url: 'http://localhost' }] };
    assert.throws(() => store.configure(invalid, now), /Unknown/u);
    const error = await refreshSubscriptions({ store, config, now, fetchImpl: async () => new Response('blocked', { status: 403 }) });
    assert.equal(error.every(r => r.status === 'error'), true);
    assert.deepEqual(store.candidates({ ...scope, now }), []);
    await refreshSubscriptions({ store, config, force: true, now,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now + 7 * 86400000 })) }) });
    assert.deepEqual(store.candidates({ ...scope, now }), []);
    await refreshSubscriptions({ store, config, force: true, now, fetchImpl: responses() });
    assert.equal(store.candidates({ ...scope, now }).length, 1);
    assert.deepEqual(store.candidates({ ...scope, now: now + 3600001 }), []);
    store.configure({ subscriptions: [] }, now);
    assert.deepEqual(store.candidates({ ...scope, now }), []);
  } finally { store.close(); }
});

test('a live match and a completed result require official status instead of inferring status from the clock', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    await refreshSubscriptions({ store, config, now,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now - 3600000, state: 'unstarted' })) }) });
    assert.deepEqual(store.candidates({ ...scope, now }), []);
    await refreshSubscriptions({ store, config, force: true, now: now + 1000,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now - 3600000, state: 'inProgress', score: [1, 0] })) }) });
    assert.equal(store.candidates({ ...scope, now: now + 1000 })[0].phase, 'live');
    await refreshSubscriptions({ store, config, force: true, now: now + 2000,
      fetchImpl: responses({ scheduleBody: schedule(matchEvent({ at: now - 3600000, state: 'completed', score: [3, 1] })) }) });
    const result = store.candidates({ ...scope, now: now + 2000 })[0];
    assert.equal(result.phase, 'result');
    assert.deepEqual(result.teams.map(t => t.wins), [3, 1]);
  } finally { store.close(); }
});

test('final official reply guard checks Beijing dates, clock, state, scores and regional release claims', () => {
  const base = { ...parseRiotSchedule(schedule(matchEvent({ at: Date.parse('2026-11-14T11:00:00Z') })))[0], officialEvidence: true };
  assert.equal(validateOfficialReply('BLG 明晚七点比赛，想看', base, { now }), true);
  assert.equal(validateOfficialReply('BLG 今晚七点比赛', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 明天上午七点比赛', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 周六19:00比赛', base, { now }), true);
  assert.equal(validateOfficialReply('BLG 周日19:00比赛', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 11月14号比赛', base, { now }), true);
  assert.equal(validateOfficialReply('BLG 11月15日比赛', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 正在比赛', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 赢了', base, { now }), false);
  assert.equal(validateOfficialReply('BLG 比赛延期了', base, { now }), false);
  assert.equal(validateOfficialReply('BLG这场想看', { ...base, startTime: null }, { now }), false);
  const live = { ...base, status: 'live', teams: base.teams.map((team, index) => ({ ...team, wins: index ? 0 : 1 })) };
  assert.equal(validateOfficialReply('BLG 正在比赛，1:0', live, { now }), true);
  assert.equal(validateOfficialReply('BLG 已经赢了', live, { now }), false);
  const complete = { ...live, status: 'completed', teams: base.teams.map((team, index) => ({ ...team, wins: index ? 1 : 3 })) };
  assert.equal(validateOfficialReply('BLG 3:1赢了', complete, { now }), true);
  assert.equal(validateOfficialReply('BLG 3:0赢了', complete, { now }), false);
  assert.equal(validateOfficialReply('GEN 赢了', complete, { now }), false);
  assert.equal(validateOfficialReply('GEN 战胜 BLG', complete, { now }), false);
  const patch = { ...parseRiotPatches(patches(patchItem()))[0], officialEvidence: true };
  assert.equal(validateOfficialReply('国际服又有新版本公告了', patch, { now }), true);
  assert.equal(validateOfficialReply('国服已经更新了', patch, { now }), false);
  assert.equal(validateOfficialReply('今晚国服更新', patch, { now }), false);
  assert.equal(validateOfficialReply('已经开赛了', patch, { now }), false);
});
