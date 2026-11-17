import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedOnlineCheck, onlineCheckInterval } from '../packages/supervisor/online-check.mjs';

test('idle online checks run once per half-hour while real work can recheck immediately', async () => {
  let now = 0, calls = 0;
  const online = cachedOnlineCheck(async () => { calls++; return true; }, { now: () => now });
  assert.equal(onlineCheckInterval(), 1800000);
  await online();
  for (now = 60000; now < 1800000; now += 60000) assert.equal(await online(), true);
  assert.equal(calls, 1);
  await online(); assert.equal(calls, 2);
  await online({ force: true }); assert.equal(calls, 3);
});

test('concurrent probes share one request; offline failures also obey the interval', async () => {
  let calls = 0, now = 0;
  const check = cachedOnlineCheck(async () => { calls++; throw new Error('offline'); }, { now: () => now });
  assert.deepEqual(await Promise.all([check(), check(), check()]), [false, false, false]);
  assert.equal(calls, 1);
  now = 1799999; assert.equal(await check(), false); assert.equal(calls, 1);
  now++; assert.equal(await check(), false); assert.equal(calls, 2);
  now = 100; assert.equal(await check(), false); assert.equal(calls, 3);
  assert.throws(() => onlineCheckInterval(10));
});
