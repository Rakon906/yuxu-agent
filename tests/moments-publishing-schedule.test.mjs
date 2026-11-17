import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MomentsPublishingSchedule, momentsPublishingWeek, momentsPublishingWindow } from '../packages/moments/publishing-schedule.mjs';

const HOUR = 3_600_000;
const DAY = HOUR * 24;
const at = value => Date.parse(`${value}+08:00`);
const hash = value => createHash('sha256').update(value).digest('hex');
const asset = { kind: 'image', path: resolve('.runtime/moments/schedule-fixture.jpg'), sha256: 'a'.repeat(64),
  md5: 'b'.repeat(32), bytes: 1234, width: 100, height: 100, mimeType: 'image/jpeg' };
function fixture({ initial = at('2026-11-09T12:00:00'), random = () => 0, minDecisionGapMs = 0 } = {}) {
  mkdirSync(resolve('.runtime/runs'), { recursive: true });
  const dir = mkdtempSync(resolve('.runtime/runs/moments-schedule-'));
  const filename = join(dir, 'schedule.sqlite');
  let current = initial;
  const options = { now: () => current, random, minDecisionGapMs };
  const store = new MomentsPublishingSchedule(filename, options);
  const set = value => { current = typeof value === 'number' ? value : at(value); };
  const opportunity = (name, extra = {}) => ({ accountId: 'account-1', opportunityKey: name,
    sourceFingerprint: hash(name), topicKey: name, expiresAt: current + DAY * 2,
    source: { kind: 'group', evidenceIds: [`msg-${name}`] }, ...extra });
  return { dir, filename, options, store, set, opportunity, now: () => current };
}
function prepare(f, name, { accountId = 'account-1', ...extra } = {}) {
  const considered = f.store.consider(f.opportunity(name, { accountId, ...extra }));
  assert.equal(considered.claimed, true, considered.reason);
  let job = f.store.select(accountId, considered.job.id, { text: '今天继续摸鱼。', imagePrompt: '小肥鱼躺着看比赛的插画' });
  assert.equal(job.state, 'selected');
  assert.equal(f.store.claimGeneration(accountId, job.id).claimed, true);
  job = f.store.saveAsset(accountId, job.id, asset);
  return f.store.bindPublication(accountId, job.id, { key: `publication-${name}-${accountId}`, digest: hash(`draft-${name}`) });
}
function attempt(f, name, outcome = 'verified', extra = {}) {
  const job = prepare(f, name, extra);
  f.set(job.dueAt);
  assert.equal(f.store.beginDispatch(job.accountId, job.id).claimed, true);
  return f.store.settle(job.accountId, job.id, { state: outcome,
    ...(outcome === 'verified' || outcome === 'accepted' ? { momentId: `sns-${name}` } : {}) });
}

test('calendar boundaries use Shanghai Monday and 12:00–24:00 regardless of UTC date', () => {
  const before = momentsPublishingWeek(at('2026-11-08T23:59:59'));
  const after = momentsPublishingWeek(at('2026-11-09T00:00:00'));
  assert.equal(before.weekKey, '2026-11-02');
  assert.equal(after.weekKey, '2026-11-09');
  assert.equal(after.startsAt, at('2026-11-09T00:00:00'));
  assert.equal(momentsPublishingWindow(at('2026-11-09T11:59:59')).open, false);
  assert.equal(momentsPublishingWindow(at('2026-11-09T12:00:00')).open, true);
  assert.equal(momentsPublishingWindow(at('2026-11-09T23:59:59')).open, true);
  assert.equal(momentsPublishingWindow(at('2026-11-10T00:00:00')).open, false);
});

test('weekly target is persisted once across independent connections and restart', () => {
  let draws = 0;
  const f = fixture({ random: () => { draws++; return 0.9; } });
  assert.equal(f.store.assess('account-1').week.target, 3);
  const other = new MomentsPublishingSchedule(f.filename, { ...f.options, random: () => { throw new Error('must not redraw'); } });
  try {
    assert.equal(other.assess('account-1').week.target, 3);
    assert.equal(f.store.assess('account-1').week.target, 3);
    assert.equal(draws, 1);
  } finally { other.close(); f.store.close(); }
  const reopened = new MomentsPublishingSchedule(f.filename, { ...f.options, random: () => 0 });
  try {
    assert.equal(reopened.assess('account-1').week.target, 3);
    f.set('2026-11-16T12:00:00');
    assert.equal(reopened.assess('account-1').week.target, 2);
  } finally { reopened.close(); }
});

test('unchanged semantic opportunity is judged once; changed content and accounts are independent', () => {
  const f = fixture();
  try {
    const value = f.opportunity('op-1');
    const claimed = f.store.consider(value);
    assert.equal(claimed.claimed, true);
    f.store.decline('account-1', claimed.job.id);
    assert.equal(f.store.consider({ ...value, source: { ...value.source, heat: 100, lastSeenAt: f.now() + 1000 } }).reason, 'already_considered');
    const changed = f.store.consider({ ...value, sourceFingerprint: hash('corrected source') });
    assert.equal(changed.claimed, true);
    assert.equal(f.store.consider(f.opportunity('another-op')).reason, 'active_job');
    const other = f.store.consider({ ...value, accountId: 'account-2' });
    assert.equal(other.claimed, true);
    assert.equal(f.store.get('account-2', claimed.job.id), null);
    assert.throws(() => f.store.select('account-2', changed.job.id, { text: 'a', imagePrompt: 'b' }), /account/u);
  } finally { f.store.close(); }
});

test('concurrent workers cannot both claim selection or image generation', () => {
  const f = fixture();
  const other = new MomentsPublishingSchedule(f.filename, f.options);
  try {
    const value = f.opportunity('one');
    const first = f.store.consider(value);
    assert.equal(first.claimed, true);
    assert.equal(other.consider(value).reason, 'already_considered');
    f.store.select('account-1', first.job.id, { text: '摸鱼', imagePrompt: 'a fish' });
    assert.equal(f.store.claimGeneration('account-1', first.job.id).claimed, true);
    assert.equal(other.claimGeneration('account-1', first.job.id).claimed, false);
  } finally { other.close(); f.store.close(); }
});

test('selected due time, cached asset, and draft binding survive restart without redrawing', () => {
  const f = fixture();
  const job = prepare(f, 'cache');
  assert.equal(job.dueAt, f.now() + HOUR / 2);
  assert.equal(job.visibility, 'friends');
  assert.equal(f.store.beginDispatch('account-1', job.id).reason, 'not_due');
  f.store.close();
  const reopened = new MomentsPublishingSchedule(f.filename, { ...f.options, random: () => { throw new Error('no redraw'); } });
  try {
    reopened.recoverInterrupted('account-1');
    const persisted = reopened.get('account-1', job.id);
    assert.equal(persisted.state, 'prepared');
    assert.equal(persisted.dueAt, job.dueAt);
    assert.equal(persisted.imageKind, 'picture');
    assert.deepEqual(persisted.asset, asset);
    assert.equal(reopened.claimGeneration('account-1', job.id).claimed, false);
    f.set(job.dueAt);
    assert.equal(reopened.beginDispatch('account-1', job.id).claimed, true);
    assert.equal(reopened.beginDispatch('account-1', job.id).claimed, false);
  } finally { reopened.close(); }
});

test('generation interrupted by restart is recorded unknown and never paid for automatically again', () => {
  const f = fixture();
  try {
    const value = f.opportunity('image-crash');
    const { job } = f.store.consider(value);
    f.store.select('account-1', job.id, { text: 'a', imagePrompt: 'b' });
    f.store.claimGeneration('account-1', job.id);
    f.store.recoverInterrupted('account-1');
    assert.equal(f.store.get('account-1', job.id).reason, 'generating_result_unknown');
    assert.equal(f.store.get('account-1', job.id).state, 'failed');
    assert.equal(f.store.claimGeneration('account-1', job.id).claimed, false);
    assert.equal(f.store.consider(value).reason, 'already_considered');
    assert.throws(() => f.store.saveAsset('account-1', job.id, asset), /state/u);
    assert.equal(f.store.assess('account-1').rollingCount, 0);
    assert.equal(f.store.consider(f.opportunity('new-event')).claimed, true);
  } finally { f.store.close(); }
});

test('attempt is durable before send; unknown outcomes count quota and block duplicates until reconciled', () => {
  const f = fixture();
  try {
    const job = prepare(f, 'unknown');
    f.set(job.dueAt);
    assert.equal(f.store.beginDispatch('account-1', job.id).claimed, true);
    f.store.recoverInterrupted('account-1');
    assert.equal(f.store.get('account-1', job.id).state, 'needs_review');
    assert.equal(f.store.assess('account-1').rollingCount, 1);
    f.set(f.now() + DAY * 2);
    assert.equal(f.store.consider(f.opportunity('no-retry')).reason, 'active_job');
    assert.equal(f.store.beginDispatch('account-1', job.id).claimed, false);
    f.store.settle('account-1', job.id, { state: 'verified', momentId: 'server-confirmed-id' });
    assert.equal(f.store.assess('account-1').eligible, true);
    assert.throws(() => f.store.settle('account-1', job.id, { state: 'verified', momentId: 'different-id' }), /conflict/u);
    assert.throws(() => f.store.settle('account-1', job.id, { state: 'rejected' }), /Terminal/u);
  } finally { f.store.close(); }
});

test('36-hour separation and weekly target include rejected sends', () => {
  const f = fixture();
  try {
    const first = attempt(f, 'monday', 'rejected');
    f.set(first.attemptedAt + HOUR);
    assert.equal(f.store.consider(f.opportunity('too-soon')).reason, 'minimum_gap');
    f.set('2026-11-11T12:00:00');
    attempt(f, 'wednesday');
    f.set('2026-11-13T12:00:00');
    const policy = f.store.assess('account-1');
    assert.equal(policy.weekCount, 2);
    assert.equal(policy.reason, 'weekly_target_reached');
    assert.equal(f.store.consider(f.opportunity('friday')).claimed, false);
  } finally { f.store.close(); }
});

test('rolling seven-day cap applies across Monday week resets', () => {
  // Target3 and shortest delay, making event times predictable.
  let draws = 0;
  const f = fixture({ initial: at('2026-11-10T12:00:00'), random: () => (++draws === 1 || draws === 5) ? 0.9 : 0 });
  try {
    attempt(f, 'tue');
    f.set('2026-11-12T12:00:00'); attempt(f, 'thu');
    f.set('2026-11-14T12:00:00'); attempt(f, 'sat');
    f.set('2026-11-16T12:00:00');
    const policy = f.store.assess('account-1');
    assert.equal(policy.weekCount, 0);
    assert.equal(policy.rollingCount, 3);
    assert.equal(policy.reason, 'rolling_limit');
    f.set('2026-11-17T12:30:00');
    assert.equal(f.store.assess('account-1').rollingCount, 2);
    assert.equal(f.store.assess('account-1').eligible, true);
  } finally { f.store.close(); }
});

test('late-night selection moves into next noon window only if source remains valid', () => {
  const f = fixture({ initial: at('2026-11-09T23:50:00') });
  try {
    const { job } = f.store.consider(f.opportunity('fresh-tomorrow'));
    const selected = f.store.select('account-1', job.id, { text: 'a', imagePrompt: 'b' });
    assert.equal(selected.dueAt, at('2026-11-10T12:00:00'));
    f.store.failBeforeDispatch('account-1', job.id, 'test_complete');
    const expiring = f.store.consider(f.opportunity('late-match', { expiresAt: at('2026-11-10T01:00:00') }));
    const dropped = f.store.select('account-1', expiring.job.id, { text: 'a', imagePrompt: 'b' });
    assert.equal(dropped.state, 'expired');
    assert.equal(dropped.reason, 'no_suitable_window');
  } finally { f.store.close(); }
});

test('no activity and expired opportunities never create catch-up posts or spend quota', () => {
  const f = fixture();
  try {
    for (let day = 0; day < 14; day++) {
      f.set(at('2026-11-09T12:00:00') + day * DAY);
      assert.equal(f.store.assess('account-1').rollingCount, 0);
    }
    assert.deepEqual(f.store.list('account-1'), []);
    assert.equal(f.store.consider(f.opportunity('stale', { expiresAt: f.now() - 1 })).reason, 'opportunity_expired');
    const prepared = prepare(f, 'about-to-expire', { expiresAt: f.now() + HOUR });
    f.set(prepared.expiresAt);
    assert.equal(f.store.beginDispatch('account-1', prepared.id).reason, 'opportunity_expired');
    assert.equal(f.store.get('account-1', prepared.id).state, 'expired');
    assert.equal(f.store.assess('account-1').rollingCount, 0);
  } finally { f.store.close(); }
});

test('dispatch rechecks waking window, account, and immutable asset/publication binding', () => {
  const f = fixture();
  try {
    const initial = f.store.consider(f.opportunity('guarded')).job;
    assert.equal(f.store.beginDispatch('account-1', initial.id).reason, 'not_prepared');
    f.store.select('account-1', initial.id, { text: 'a', imagePrompt: 'b' });
    assert.throws(() => f.store.bindPublication('account-1', initial.id, { key: 'x', digest: hash('x') }), /state/u);
    f.store.claimGeneration('account-1', initial.id);
    f.store.saveAsset('account-1', initial.id, { ...asset, unexpected: true });
    assert.deepEqual(f.store.get('account-1', initial.id).asset, asset);
    assert.throws(() => f.store.saveAsset('account-1', initial.id, { ...asset, sha256: 'c'.repeat(64) }), /conflict/u);
    f.store.bindPublication('account-1', initial.id, { key: 'bound', digest: hash('bound') });
    assert.throws(() => f.store.bindPublication('account-1', initial.id, { key: 'changed', digest: hash('bound') }), /conflict/u);
    f.set('2026-11-10T01:00:00');
    assert.equal(f.store.beginDispatch('account-1', initial.id).reason, 'outside_window');
    assert.throws(() => f.store.beginDispatch('account-2', initial.id), /account/u);
    f.set('2026-11-10T12:00:00');
    assert.equal(f.store.beginDispatch('account-1', initial.id).claimed, true);
  } finally { f.store.close(); }
});

test('recent event dedup does not permit changed wording to repost the same event', () => {
  const f = fixture({ random: () => 0.9 });
  try {
    attempt(f, 'blg-match', 'verified', { topicKey: 'match:2026-11-09:blg-x' });
    f.set('2026-11-11T18:00:00');
    assert.equal(f.store.consider(f.opportunity('changed-title', { topicKey: 'match:2026-11-09:blg-x' })).reason, 'recent_topic');
    assert.equal(f.store.consider(f.opportunity('different-match', { topicKey: 'match:2026-11-12:blg-y' })).claimed, true);
  } finally { f.store.close(); }
});

test('invalid source fingerprints, metadata, clock and RNG fail before durable work', () => {
  const f = fixture();
  try {
    assert.throws(() => f.store.consider(f.opportunity('x', { sourceFingerprint: 'not-a-digest' })), /fingerprint/u);
    assert.throws(() => f.store.consider(f.opportunity('x', { source: { huge: 'a'.repeat(33_000) } })), /too large/u);
    assert.equal(f.store.list('account-1').length, 0);
    assert.throws(() => momentsPublishingWeek(NaN), /time/u);
    assert.throws(() => f.store.list('account-1', { limit: 1000 }), /limit/u);
  } finally { f.store.close(); }
  const broken = fixture({ random: () => 1 });
  try { assert.throws(() => broken.store.assess('account-1'), /Random/u); }
  finally { broken.store.close(); }
});

test('default six-hour decision cooldown counts declines and failures without delaying a selected send', () => {
  const f = fixture({ minDecisionGapMs: 6 * HOUR });
  try {
    const first = f.store.consider(f.opportunity('first')).job;
    f.store.decline('account-1', first.id);
    assert.equal(f.store.consider(f.opportunity('new-every-poll')).reason, 'decision_cooldown');
    assert.equal(f.store.assess('account-1').nextAllowedAt, at('2026-11-09T18:00:00'));
    f.set('2026-11-09T18:00:00');
    const second = f.store.consider(f.opportunity('second')).job;
    f.store.failBeforeDispatch('account-1', second.id, 'model_failed');
    f.set('2026-11-09T23:59:00');
    assert.equal(f.store.consider(f.opportunity('next')).reason, 'decision_cooldown');
    assert.equal(f.store.assess('account-1').nextAllowedAt, at('2026-11-10T12:00:00'));
    f.set('2026-11-10T12:00:00');
    const prepared = prepare(f, 'eligible');
    f.set(prepared.dueAt);
    assert.equal(f.store.beginDispatch('account-1', prepared.id).claimed, true);
  } finally { f.store.close(); }
});

test('selected selfie kind is explicit and durable', () => {
  const f = fixture();
  try {
    const first = f.store.consider(f.opportunity('selfie')).job;
    assert.throws(() => f.store.select('account-1', first.id, { text: 'a', imagePrompt: 'b', imageKind: 'video' }), /image kind/u);
    const selected = f.store.select('account-1', first.id, { text: 'a', imagePrompt: 'b', imageKind: 'selfie' });
    assert.equal(selected.imageKind, 'selfie');
    const reopened = new MomentsPublishingSchedule(f.filename, f.options);
    try { assert.equal(reopened.get('account-1', first.id).imageKind, 'selfie'); }
    finally { reopened.close(); }
  } finally { f.store.close(); }
});
