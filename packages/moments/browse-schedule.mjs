const HOUR = 3600000;
const DAY = 24 * HOUR;
const LEAD = 5 * 60000;
const dayStart = now => Math.floor((now + 8 * HOUR) / DAY) * DAY - 8 * HOUR;
const parse = text => { try { return JSON.parse(text); } catch { return null; } };

function settings({ runsPerDay, startHour, endHour, minGapMs }) {
  if (!Number.isInteger(runsPerDay) || runsPerDay < 1 || runsPerDay > 6 ||
      !Number.isFinite(startHour) || !Number.isFinite(endHour) || startHour < 0 ||
      endHour > 24 || startHour >= endHour || !Number.isFinite(minGapMs) || minGapMs <= 0 || minGapMs > DAY) {
    throw new Error('Invalid Moments browse schedule');
  }
}

/** A late start plans only the runs that fit today, rather than an empty full-day plan. */
export function planRuns({ now = Date.now(), runsPerDay = 3, startHour = 12, endHour = 24,
  rng = Math.random, minGapMs = 2 * HOUR, leadMs = LEAD } = {}) {
  settings({ runsPerDay, startHour, endHour, minGapMs });
  const start = dayStart(now), end = start + endHour * HOUR;
  let cursor = Math.max(now + leadMs, start + startHour * HOUR);
  const count = Math.min(runsPerDay, Math.max(0, Math.floor((end - leadMs - cursor) / minGapMs) + 1));
  const times = [];
  for (let i = 0; i < count; i++) {
    const latest = end - leadMs - (count - i - 1) * minGapMs;
    const value = rng();
    if (!Number.isFinite(value) || value < 0 || value >= 1) throw new Error('Invalid schedule randomness');
    const at = cursor + Math.floor(value * Math.max(1, latest - cursor));
    times.push(at);
    cursor = at + minGapMs;
  }
  return times;
}

function attempts(ledger, day) {
  const list = parse(ledger.getMeta(`moments_browse_attempts:${day}`));
  return Array.isArray(list) ? list.filter(Number.isSafeInteger) : [];
}

export function nextRunAt(ledger, { now = Date.now(), runsPerDay = 3, startHour = 12,
  endHour = 24, rng = Math.random, minGapMs = 2 * HOUR } = {}) {
  settings({ runsPerDay, startHour, endHour, minGapMs });
  const saved = parse(ledger.getMeta('moments_plan'));
  const today = ledger.dayKey(now);
  // Legacy elapsed slots may have executed. Count them conservatively once;
  // empty/wrong-day plans can be repaired without replaying old social actions.
  if (saved && saved.version !== 2 && saved.day === today && Array.isArray(saved.times) &&
      ledger.getMeta(`moments_browse_attempts:${today}`) === null) {
    ledger.setMeta(`moments_browse_attempts:${today}`, JSON.stringify(saved.times
      .filter(at => Number.isSafeInteger(at) && at <= now && ledger.dayKey(at) === today)));
  }
  const last = Number(ledger.getMeta('moments_browse_last_attempt') ?? 0);
  for (let offset = 0; offset < 3; offset++) {
    const start = dayStart(now) + offset * DAY;
    const day = ledger.dayKey(start);
    const remaining = Math.max(0, runsPerDay - attempts(ledger, day).length);
    if (!remaining) continue;
    const earliest = Math.max(offset === 0 ? now : start, last + minGapMs - LEAD);
    const end = start + endHour * HOUR;
    const preserved = saved?.day === day && Array.isArray(saved.times) ? saved.times
      .filter(at => Number.isSafeInteger(at) && at > earliest && at >= last + minGapMs && at >= start + startHour * HOUR && at < end)
      .sort((a, b) => a - b).slice(0, remaining) : [];
    const spaced = preserved.every((at, i) => i === 0 || at - preserved[i - 1] >= minGapMs);
    const times = preserved.length && spaced ? preserved : planRuns({ now: earliest,
      runsPerDay: remaining, startHour, endHour, rng, minGapMs });
    if (!times.length || ledger.dayKey(times[0]) !== day) continue;
    const plan = { version: 2, day, times };
    ledger.setMeta('moments_plan', JSON.stringify(plan));
    ledger.scheduleNext(times[0]);
    return times[0];
  }
  throw new Error('Unable to schedule a Moments browse within its window');
}

/** Persist an attempt before network/model work; restart never replays a claimed slot. */
export function claimScheduledRun(ledger, { scheduledAt, now = Date.now(), runsPerDay = 3,
  startHour = 12, endHour = 24, minGapMs = 2 * HOUR } = {}) {
  settings({ runsPerDay, startHour, endHour, minGapMs });
  return ledger.transaction(() => {
    const plan = parse(ledger.getMeta('moments_plan'));
    const day = ledger.dayKey(now), start = dayStart(now);
    const list = attempts(ledger, day);
    const last = Number(ledger.getMeta('moments_browse_last_attempt') ?? 0);
    if (plan?.version !== 2 || plan.day !== day || !plan.times?.includes(scheduledAt) ||
        now < scheduledAt || now < start + startHour * HOUR || now >= start + endHour * HOUR ||
        list.length >= runsPerDay || now - last < minGapMs) return false;
    ledger.setMeta(`moments_browse_attempts:${day}`, JSON.stringify([...list, now]));
    ledger.setMeta('moments_browse_last_attempt', String(now));
    ledger.setMeta('moments_plan', JSON.stringify({ ...plan, times: plan.times.filter(at => at > scheduledAt) }));
    return true;
  });
}
