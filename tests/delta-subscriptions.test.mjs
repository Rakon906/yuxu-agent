import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OFFICIAL_SOURCES, parseDeltaAnnouncements } from '../packages/subscriptions/sources.mjs';
import { SubscriptionStore, defaultSubscriptions, refreshSubscriptions, validateOfficialReply } from '../packages/subscriptions/index.mjs';

const now = Date.parse('2026-11-13T11:00:00Z'), HOUR = 3600000;
const scope = { accountId: 'test-account', groupId: 'test-group@chatroom' };
const config = { subscriptions: [{ ...scope, sourceId: 'delta-announcements', teams: [], enabled: true }] };
// Same field types/shape as the public 2026-11-13 official CMS response. No user data.
const article = (extra = {}) => ({ iDocID: '4378192476826891595', iInfoType: 1, iBiz: 423,
  sChannel: [6895, 6896, 6914], sTitle: '11月12日更新公告', sIdxTime: '2026-11-11 22:29:30', sDesc: '',
  sRedirectURL: 'https://df.qq.com/cp/a20240906main/newsdetail.html?id=4378192476826891595', ...extra });
const payload = (...items) => JSON.stringify({ ret: 0, iRet: 0, sMsg: 'ok',
  jData: { iRet: '0', sMsg: 'ok', data: { total: items.length, cache: 0, items } } });
const response = items => async () => new Response(payload(...items), { headers: { etag: 'official-list-v1' } });

test('Delta parser keeps uint64 identity and converts the displayed Beijing publication time without inventing rollout time', () => {
  const [item] = parseDeltaAnnouncements(payload(article()));
  assert.equal(item.externalId, '4378192476826891595');
  assert.equal(item.publishedAt, '2026-11-11T14:29:30.000Z');
  assert.equal(item.title, '11月12日更新公告');
  assert.equal(item.startTime, null); assert.equal(item.rolloutTime, null);
  assert.equal(item.summary, ''); assert.equal(item.contentScope, 'official_list_title_and_summary');
  assert.equal(item.sourceUrl, article().sRedirectURL);
  const [latest] = parseDeltaAnnouncements(payload(article(), article({ iDocID: '14024839296739610758',
    sRedirectURL: '', sTitle: '新赛季更新公告', sIdxTime: '2026-11-13 18:30:00' })));
  assert.equal(latest.externalId, '14024839296739610758');
});

test('Delta parser rejects another game/channel, rounded IDs, redirected articles and impossible dates', () => {
  for (const bad of [
    { iBiz: 999 }, { sChannel: [6895] }, { iInfoType: 2 }, { iDocID: 4378192476826891595 },
    { sRedirectURL: 'https://evil.example/news' }, { sIdxTime: '2026-02-30 12:00:00' },
    { sIdxTime: '2026-11-13 25:00:00' }, { sIdxTime: '2026-11-13T12:00:00Z' },
  ]) assert.throws(() => parseDeltaAnnouncements(payload(article(bad))), /No validated/);
  assert.throws(() => parseDeltaAnnouncements('{"iRet":-1,"sMsg":"ERROR_PARAMS"}'), /format/);
  assert.throws(() => parseDeltaAnnouncements('<script>throw 1</script>'), SyntaxError);
  assert.throws(() => parseDeltaAnnouncements(' '.repeat(2 * 1024 * 1024 + 1)), /Invalid/);
  assert.throws(() => parseDeltaAnnouncements(payload(article(), article({ sTitle: '更新维护新版本' }))), /Conflicting/);
  assert.deepEqual(parseDeltaAnnouncements(payload(article({ sTitle: '违规处罚名单更新' }))), []);
});

test('new default source remains scoped and uses the same published read-only request without cookies or arbitrary URL', async () => {
  const defaults = defaultSubscriptions({ accountId: scope.accountId, groupIds: [scope.groupId] });
  assert.deepEqual(defaults.subscriptions.map(x => x.sourceId), ['lol-patches', 'lol-esports', 'delta-announcements']);
  assert.deepEqual(defaults.subscriptions.map(x => x.groupId), Array(3).fill(scope.groupId));
  const store = new SubscriptionStore(':memory:');
  try {
    const result = await refreshSubscriptions({ store, config, now, fetchImpl: async (url, options) => {
      assert.equal(url, OFFICIAL_SOURCES['delta-announcements'].url);
      assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
      assert.equal(options.headers.Cookie, undefined);
      assert.equal(options.headers.Referer, 'https://df.qq.com/cp/a20240906main/newslist.html');
      const form = new URLSearchParams(options.body);
      assert.equal(form.get('iChartId'), '329849'); assert.equal(form.get('chanid'), '6896');
      assert.equal(form.get('limit'), '30'); assert.equal(form.get('typeids'), '1');
      return new Response(payload(article()), { headers: { etag: 'list-v1' } });
    } });
    assert.equal(result[0].status, 'ok'); assert.deepEqual(store.candidates({ ...scope, now }), []);
    assert.deepEqual(store.candidates({ ...scope, accountId: 'other', now }), []);
  } finally { store.close(); }
});

test('Delta first scan baselines old news; later changes, 304, unchanged content and persistent claims never duplicate topics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'delta-subscription-')), path = join(dir, 'feeds.sqlite');
  let store = new SubscriptionStore(path);
  try {
    await refreshSubscriptions({ store, config, now, fetchImpl: response([article()]) });
    assert.deepEqual(store.candidates({ ...scope, now }), []);
    const waiting = await refreshSubscriptions({ store, config, now: now + 1000,
      fetchImpl: () => { throw new Error('No network request before due'); } });
    assert.equal(waiting[0].status, 'waiting');
    const at = now + 6 * HOUR;
    const updated = article({ sTitle: '11月12日更新公告（修订）' });
    const changes = await refreshSubscriptions({ store, config, now: at, fetchImpl: response([updated]) });
    assert.equal(changes[0].updated, 1);
    const candidate = store.candidates({ ...scope, now: at })[0];
    assert.equal(candidate.kind, 'announcement'); assert.equal(candidate.sourceId, 'delta-announcements');
    assert.equal(candidate.phase, 'update'); assert.equal(candidate.officialEvidence, true);
    assert.equal(store.claim(candidate, { ...scope, ownerKey: 'only-owner', now: at }), true);
    assert.equal(store.validateClaim(candidate, { ...scope, ownerKey: 'only-owner', now: at }), true);
    store.settle(candidate.deliveryKey, { ...scope, ownerKey: 'only-owner', state: 'unknown', now: at });
    store.close(); store = new SubscriptionStore(path);
    assert.deepEqual(store.candidates({ ...scope, now: at + 1 }), []);
    const same = await refreshSubscriptions({ store, config, force: true, now: at + 1000, fetchImpl: response([updated]) });
    assert.equal(same[0].updated, 0);
    const unchanged = await refreshSubscriptions({ store, config, force: true, now: at + 2000, fetchImpl: async (url, options) => {
      assert.equal(options.headers['If-None-Match'], 'official-list-v1'); return new Response(null, { status: 304 });
    } });
    assert.equal(unchanged[0].status, 'unchanged');
    assert.deepEqual(store.candidates({ ...scope, now: at + 2001 }), []);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('Delta transport errors, oversized data and stale evidence cannot manufacture current updates', async () => {
  const store = new SubscriptionStore(':memory:');
  try {
    for (const fetchImpl of [
      async () => new Response('denied', { status: 403 }),
      async () => new Response('{"iRet":-1}'),
      async () => new Response('{}', { headers: { 'content-length': String(3 * 1024 * 1024) } }),
    ]) {
      const result = await refreshSubscriptions({ store, config, now, force: true, fetchImpl });
      assert.equal(result[0].status, 'error'); assert.deepEqual(store.candidates({ ...scope, now }), []);
    }
    await refreshSubscriptions({ store, config, now, force: true, fetchImpl: response([article()]) });
    await refreshSubscriptions({ store, config, now: now + 1000, force: true,
      fetchImpl: response([article({ sTitle: '更新公告修订说明' })]) });
    assert.equal(store.candidates({ ...scope, now: now + 1000 }).length, 1);
    assert.deepEqual(store.candidates({ ...scope, now: now + 13 * HOUR }), []);
  } finally { store.close(); }
});

test('announcement reply guards distinguish official publication from deployment or match claims', () => {
  const candidate = { ...parseDeltaAnnouncements(payload(article()))[0], officialEvidence: true };
  assert.equal(validateOfficialReply('三角洲又发更新公告了，有空瞅瞅', candidate, { now }), true);
  for (const reply of ['三角洲新赛季已经上线了', '服务器更新完成了', '维护结束了', '明晚八点开服',
    '今天更新', '烽火世界杯已经开赛了', '他们赢了', '国服已经更新了']) {
    assert.equal(validateOfficialReply(reply, candidate, { now }), false, reply);
  }
});
