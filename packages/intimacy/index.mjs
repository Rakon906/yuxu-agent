import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { projectRoot } from '../../scripts/runtime.mjs';

export const DEFAULT_INTIMACY = 6;
export const MIN_INTIMACY = 0;
export const MAX_INTIMACY = 10;
export const MAX_INCREASE = 0.3;
export const MAX_DECREASE = 0.4;
export const MAX_DAILY_DELTA = 0.5;

const round1 = value => Math.round(value * 10) / 10;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function defaultIntimacyPath() {
  return process.env.SOCIOMEM_INTIMACY_DB ??
    join(projectRoot, '.runtime', 'people', 'intimacy.sqlite');
}

export function intimacyLevel(score) {
  if (score >= 10) return { key: 'best', label: '很熟' };
  if (score >= 8) return { key: 'close', label: '熟络' };
  if (score >= 6) return { key: 'friendly', label: '正常' };
  if (score >= 3) return { key: 'distant', label: '一般' };
  return { key: 'guarded', label: '生疏' };
}

function shanghaiDay(now) {
  return new Date(now + 8 * 3600000).toISOString().slice(0, 10);
}

export function openIntimacyStore(filename = defaultIntimacyPath()) {
  mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA busy_timeout=5000');
  db.exec(`CREATE TABLE IF NOT EXISTS intimacy (
    account_id TEXT NOT NULL, group_id TEXT NOT NULL, user_id TEXT NOT NULL,
    score REAL NOT NULL DEFAULT ${DEFAULT_INTIMACY},
    day TEXT NOT NULL, day_delta REAL NOT NULL DEFAULT 0,
    reason TEXT, updated_at INTEGER NOT NULL, locked INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, group_id, user_id))`);
  try { db.exec('ALTER TABLE intimacy ADD COLUMN locked INTEGER NOT NULL DEFAULT 0'); }
  catch { /* column already exists */ }
  db.exec(`CREATE TABLE IF NOT EXISTS intimacy_events (
    task_id TEXT NOT NULL, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
    user_id TEXT NOT NULL, delta REAL NOT NULL, reason TEXT, at INTEGER NOT NULL,
    PRIMARY KEY (task_id, user_id))`);
  db.exec(`CREATE TABLE IF NOT EXISTS intimacy_jobs (
    account_id TEXT NOT NULL, group_id TEXT NOT NULL, segment_id TEXT NOT NULL,
    payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER NOT NULL,
    last_error TEXT, result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, group_id, segment_id));
    CREATE TABLE IF NOT EXISTS intimacy_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  if (!db.prepare('PRAGMA table_info(intimacy_jobs)').all().some(column => column.name === 'result_json')) {
    db.exec('ALTER TABLE intimacy_jobs ADD COLUMN result_json TEXT');
  }

  const select = db.prepare(`SELECT score,day,day_delta,reason,updated_at,locked FROM intimacy
    WHERE account_id=? AND group_id=? AND user_id=?`);
  const insert = db.prepare(`INSERT OR IGNORE INTO intimacy
    (account_id,group_id,user_id,score,day,day_delta,reason,updated_at)
    VALUES (?,?,?,?,?,0,?,?)`);
  const update = db.prepare(`UPDATE intimacy SET score=?,day=?,day_delta=?,reason=?,updated_at=?
    WHERE account_id=? AND group_id=? AND user_id=?`);
  const event = db.prepare(`SELECT delta FROM intimacy_events WHERE task_id=? AND user_id=?`);
  const addEvent = db.prepare(`INSERT INTO intimacy_events
    (task_id,account_id,group_id,user_id,delta,reason,at) VALUES (?,?,?,?,?,?,?)`);

  function ensure(accountId, groupId, userId, now = Date.now()) {
    insert.run(accountId, groupId, userId, DEFAULT_INTIMACY, shanghaiDay(now), '初始亲密度', now);
    return select.get(accountId, groupId, userId);
  }

  function present(row) {
    const score = round1(row.score);
    const level = intimacyLevel(score);
    return { score, level: level.key, label: level.label,
      reason: row.reason ?? null, updatedAt: row.updated_at, locked: row.locked === 1 };
  }

  return {
    db,
    ensureMember(accountId, groupId, userId, now = Date.now()) {
      return present(ensure(accountId, groupId, userId, now));
    },
    ensureMembers(accountId, groupId, userIds, now = Date.now()) {
      db.exec('BEGIN');
      try {
        for (const userId of userIds) ensure(accountId, groupId, userId, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    get(accountId, groupId, userId, now = Date.now()) {
      return present(ensure(accountId, groupId, userId, now));
    },
    list(accountId, groupId) {
      return db.prepare(`SELECT user_id,score,day_delta,reason,updated_at,locked FROM intimacy
        WHERE account_id=? AND group_id=? ORDER BY score DESC, user_id`).all(accountId, groupId)
        .map(row => ({ userId: row.user_id, ...present(row) }));
    },
    apply({ accountId, groupId, userId, delta, reason = '', taskId = null, now = Date.now() }) {
      ensure(accountId, groupId, userId, now);
      const current = select.get(accountId, groupId, userId);
      if (current.locked) {
        return { ...present(current), applied: 0, locked: true, duplicate: false };
      }
      if (taskId && event.get(taskId, userId)) {
        return { ...present(select.get(accountId, groupId, userId)), applied: 0, duplicate: true };
      }
      const numeric = Number.isFinite(Number(delta)) ? Number(delta) : 0;
      const requested = round1(clamp(numeric, -MAX_DECREASE, MAX_INCREASE));
      const row = select.get(accountId, groupId, userId);
      let day = row.day;
      let dayDelta = row.day_delta;
      const today = shanghaiDay(now);
      if (day !== today) { day = today; dayDelta = 0; }
      const remaining = Math.max(0, MAX_DAILY_DELTA - Math.abs(dayDelta));
      let applied = 0;
      if (requested > 0) applied = Math.min(requested, remaining);
      else if (requested < 0) applied = -Math.min(-requested, remaining);
      const score = round1(clamp(row.score + applied, MIN_INTIMACY, MAX_INTIMACY));
      applied = round1(score - row.score);
      dayDelta = round1(dayDelta + applied);
      update.run(score, day, dayDelta, reason.slice(0, 120) || row.reason, now,
        accountId, groupId, userId);
      if (taskId) addEvent.run(taskId, accountId, groupId, userId, applied,
        reason.slice(0, 120), now);
      return { ...present(select.get(accountId, groupId, userId)), applied,
        capped: applied !== requested, duplicate: false };
    },
    setScore({ accountId, groupId, userId, score, reason = '手动调整', now = Date.now() }) {
      ensure(accountId, groupId, userId, now);
      const next = round1(clamp(Number(score), MIN_INTIMACY, MAX_INTIMACY));
      update.run(next, shanghaiDay(now), 0, reason.slice(0, 120), now,
        accountId, groupId, userId);
      return present(select.get(accountId, groupId, userId));
    },
    lock({ accountId, groupId, userId, locked = true, now = Date.now() }) {
      ensure(accountId, groupId, userId, now);
      db.prepare(`UPDATE intimacy SET locked=?, updated_at=?
        WHERE account_id=? AND group_id=? AND user_id=?`)
        .run(locked ? 1 : 0, now, accountId, groupId, userId);
      return present(select.get(accountId, groupId, userId));
    },
    close() { db.close(); },
  };
}

export function defaultIntimacyStore() {
  return openIntimacyStore();
}
