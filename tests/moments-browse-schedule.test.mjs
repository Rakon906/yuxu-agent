import test from 'node:test';
import assert from 'node:assert/strict';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { planRuns, nextRunAt, claimScheduledRun } from '../packages/moments/browse-schedule.mjs';

const at = value => Date.parse(`${value}+08:00`);
const params = { rng: () => 0.5 };
const ledgerFor = t => { const db = new MomentsLedger(':memory:'); t.after(() => db.close()); return db; };

test('a late start plans one remaining run rather than rejecting the whole day', () => {
  const times = planRuns({ now: at('2026-11-11T23:46:00'), ...params });
  assert.equal(times.length, 1);
  assert.ok(times[0] > at('2026-11-11T23:46:00') && times[0] < at('2026-11-12T00:00:00'));
});

test('an exhausted evening schedules tomorrow from its day boundary, not at the same late time', t => {
  const ledger = ledgerFor(t);
  const now = at('2026-11-11T23:46:00');
  ledger.setMeta('moments_browse_attempts:2026-11-11', JSON.stringify([now - 6 * 3600000, now - 3 * 3600000, now]));
  ledger.setMeta('moments_browse_last_attempt', String(now));
  const next = nextRunAt(ledger, { now, ...params });
  assert.equal(ledger.dayKey(next), '2026-11-12');
  const plan = JSON.parse(ledger.getMeta('moments_plan'));
  assert.equal(plan.times.length, 3);
  assert.ok(next < at('2026-11-12T20:00:00'));
});

test('legacy empty or wrong-day plan is repaired during today and is stable across restart', t => {
  const ledger = ledgerFor(t), now = at('2026-11-12T13:06:00');
  for (const day of ['2026-11-12', '2026-11-13']) {
    ledger.setMeta('moments_plan', JSON.stringify({ day, times: [] }));
    const next = nextRunAt(ledger, { now, ...params });
    assert.equal(ledger.dayKey(next), '2026-11-12');
    assert.equal(nextRunAt(ledger, { now: now + 1000, rng: () => 0.9 }), next);
  }
});

test('claims persist before execution; repeat claims and over-quota runs cannot execute', t => {
  const ledger = ledgerFor(t);
  let now = at('2026-11-12T12:00:00');
  for (let i = 0; i < 3; i++) {
    const next = nextRunAt(ledger, { now, rng: () => 0 });
    assert.equal(ledger.dayKey(next), '2026-11-12');
    assert.equal(claimScheduledRun(ledger, { scheduledAt: next, now: next }), true);
    assert.equal(claimScheduledRun(ledger, { scheduledAt: next, now: next }), false);
    const old = now; now = next;
    if (i) assert.ok(now - old >= 2 * 3600000);
  }
  assert.equal(ledger.dayKey(nextRunAt(ledger, { now, ...params })), '2026-11-13');
});

test('sleeping through a slot creates a spaced catch-up; a deferred run cannot cross midnight', t => {
  const ledger = ledgerFor(t);
  const original = nextRunAt(ledger, { now: at('2026-11-12T12:00:00'), rng: () => 0 });
  const repaired = nextRunAt(ledger, { now: at('2026-11-12T18:00:00'), rng: () => 0 });
  assert.ok(repaired > original && repaired > at('2026-11-12T18:00:00'));
  assert.equal(claimScheduledRun(ledger, { scheduledAt: repaired, now: at('2026-11-13T00:01:00') }), false);
});
