import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAnthropicJsonModel } from '../model/anthropic.mjs';
import { createOllamaJsonModel } from '../model/ollama.mjs';
import { gameParticipationViolation } from '../participation/game-boundary.mjs';

const DAY = 86400000;
const skillUrl = new URL('../../skills/moments-reply/SKILL.md', import.meta.url);
const positiveId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value) &&
  BigInt(value) <= 0xffffffffffffffffn;
const validUser = value => typeof value === 'string' && /^[\w.-]{1,200}$/u.test(value);
const dayStart = now => Math.floor((now + 8 * 3600000) / DAY) * DAY - 8 * 3600000;

export const defaultCommentReplyLimits = Object.freeze({
  maxMoments: 20, watchAgeMs: 30 * DAY, maxDecisionsPerCycle: 3,
  maxRepliesPerDay: 6, cooldownMs: 60000, retryBackoffMs: 10 * 60000,
  readRetryBackoffMs: 120000,
  maxModelAttempts: 3, maxSourceAgeMs: 2 * DAY, leaseMs: 5 * 60000,
  maxReconciliationsPerCycle: 3, maxReconcileAttempts: 6,
});

/** Only direct conversations involving this account, never a third-party thread. */
export function isCommentReplyCandidate(moment, comment, selfId) {
  if (comment?.replyReferenceSupported === false || !validUser(selfId) || !positiveId(String(moment?.id ?? '')) ||
      !positiveId(String(comment?.commentId ?? '')) || !validUser(comment?.userId) ||
      comment.userId === selfId || typeof comment.text !== 'string' || !comment.text.trim()) return false;
  const replyTo = comment.replyTo || null;
  const replyId = comment.replyCommentId && String(comment.replyCommentId) !== '0'
    ? String(comment.replyCommentId) : null;
  if (replyTo) return replyTo === selfId;
  if (replyId) {
    return (moment.comments ?? []).some(item => String(item.commentId) === replyId && item.userId === selfId);
  }
  return moment.author?.id === selfId;
}

function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

function initialize(store, { accountId, selfId, now }) {
  if (!store?.db || !validUser(accountId) || !validUser(selfId)) throw new Error('Reply monitor needs a bound account and store');
  if ((store.accountId !== undefined && store.accountId !== accountId) ||
      (store.selfId !== undefined && store.selfId !== selfId)) throw new Error('Reply monitor account mismatch');
  store.db.exec(`CREATE TABLE IF NOT EXISTS reply_monitor_identity (
    id INTEGER PRIMARY KEY CHECK(id=1), account_id TEXT NOT NULL, self_id TEXT NOT NULL, activated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS reply_monitor_watches (
    moment_id TEXT PRIMARY KEY, first_seen_at INTEGER NOT NULL, last_polled_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS reply_monitor_comments (
    moment_id TEXT NOT NULL, comment_id TEXT NOT NULL, source_json TEXT NOT NULL,
    state TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0,
    job_key TEXT, decision_json TEXT, reserved_at INTEGER, first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    lease_token TEXT, lease_until INTEGER NOT NULL DEFAULT 0, reconcile_attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(moment_id,comment_id));`);
  const columns = store.db.prepare('PRAGMA table_info(reply_monitor_comments)').all();
  if (!columns.some(column => column.name === 'first_seen_at')) {
    store.db.exec('ALTER TABLE reply_monitor_comments ADD COLUMN first_seen_at INTEGER');
    store.db.exec('UPDATE reply_monitor_comments SET first_seen_at=updated_at WHERE first_seen_at IS NULL');
  }
  for (const [name, sql] of [['lease_token', 'TEXT'], ['lease_until', 'INTEGER NOT NULL DEFAULT 0'],
    ['reconcile_attempts', 'INTEGER NOT NULL DEFAULT 0']]) {
    if (!columns.some(column => column.name === name)) {
      store.db.exec(`ALTER TABLE reply_monitor_comments ADD COLUMN ${name} ${sql}`);
    }
  }
  store.db.exec(`UPDATE reply_monitor_comments SET reserved_at=NULL,lease_token=NULL,lease_until=0
    WHERE state IN ('baseline','ignored','silent','shadow','stopped','verified','rejected','stale','skipped','manual_review')
    AND (reserved_at IS NOT NULL OR lease_token IS NOT NULL OR lease_until<>0)`);
  return transaction(store.db, () => {
    const current = store.db.prepare('SELECT * FROM reply_monitor_identity WHERE id=1').get();
    if (current && (current.account_id !== accountId || current.self_id !== selfId)) {
      throw new Error('Reply monitor account mismatch');
    }
    if (current) return { ...current, bootstrap: false };
    store.db.prepare('INSERT INTO reply_monitor_identity VALUES (1,?,?,?)').run(accountId, selfId, now);
    return { account_id: accountId, self_id: selfId, activated_at: now, bootstrap: true };
  });
}

function sourceView(comment) {
  return { commentId: String(comment.commentId), userId: comment.userId, text: comment.text,
    replyTo: comment.replyTo || null, replyCommentId: comment.replyCommentId ? String(comment.replyCommentId) : null,
    createTime: comment.createTime ?? null };
}

/** Read only the existing participation/publication ledgers; no schema changes there. */
export function discoverReplyMomentIds({ legacyLedgerPath, publishLedgerPath, accountId, selfId,
  now = Date.now(), limits = defaultCommentReplyLimits, momentIds = [] } = {}) {
  const entries = new Map();
  const add = (id, at) => { if (positiveId(String(id))) entries.set(String(id), Math.max(entries.get(String(id)) ?? 0, at)); };
  for (const id of momentIds) add(id, now);
  if (legacyLedgerPath && existsSync(legacyLedgerPath)) {
    const db = new DatabaseSync(legacyLedgerPath, { readOnly: true });
    try {
      // The legacy ledger is not account-bound. Treat its IDs only as discovery hints;
      // the active account must be present as an author/commenter on a fresh detail read.
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='moment_actions' AND type='table'").get()) {
        for (const row of db.prepare(`SELECT moment_id,MAX(created_at) AS at FROM moment_actions
          WHERE kind IN ('comment','reply') AND state IN ('sent','needs_review','dispatching')
          AND created_at>=? GROUP BY moment_id ORDER BY at DESC LIMIT ?`)
          .all(now - limits.watchAgeMs, limits.maxMoments)) add(row.moment_id, row.at);
      }
    } finally { db.close(); }
  }
  if (publishLedgerPath && existsSync(publishLedgerPath)) {
    const db = new DatabaseSync(publishLedgerPath, { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='publications' AND type='table'").get()) {
        for (const row of db.prepare(`SELECT moment_id,updated_at,draft_json FROM publications
          WHERE account_id=? AND state='verified' AND updated_at>=? ORDER BY updated_at DESC LIMIT ?`)
          .all(accountId, now - limits.watchAgeMs, limits.maxMoments)) {
          try { if (JSON.parse(row.draft_json).selfUserId === selfId) add(row.moment_id, row.updated_at); } catch {}
        }
      }
    } finally { db.close(); }
  }
  return [...entries].sort((a, b) => b[1] - a[1]).slice(0, limits.maxMoments).map(([id]) => id);
}

export function commentReplyMessages({ moment, comment, selfId, recentReplies = [], now = Date.now(), socialContext = null }) {
  const view = item => ({ commentId: String(item.commentId), userId: item.userId, name: item.name ?? '',
    text: String(item.text ?? '').slice(0, 1200), replyTo: item.replyTo ?? null,
    replyCommentId: item.replyCommentId ?? null, createTime: item.createTime ?? null });
  return [
    { role: 'system', content: readFileSync(skillUrl, 'utf8') },
    { role: 'user', content: JSON.stringify({ self: { id: selfId, name: '肥鱼不肥' },
      currentTime: { utc: new Date(now).toISOString(), timezone: 'Asia/Shanghai' },
      socialContext,
      moment: { id: String(moment.id), author: moment.author, text: String(moment.text ?? '').slice(0, 3000),
        mediaAvailable: Boolean(moment.media?.length) },
      target: view(comment), conversation: (moment.comments ?? []).slice(-30).map(view),
      recentReplies: recentReplies.slice(0, 8).map(item => ({ text: item.text, momentId: item.moment?.id })) }) },
  ];
}

export function createCommentReplyModel({ provider = process.env.SOCIOMEM_MOMENTS_PROVIDER ?? 'ollama',
  anthropic = null, ollama = null, lookupSocialContext = null } = {}) {
  let model;
  if (provider === 'ollama') model = ollama ?? createOllamaJsonModel();
  else if (provider === 'anthropic') model = anthropic ?? createAnthropicJsonModel();
  else throw new Error('Invalid comment reply provider');
  return async input => model({ component: 'moments_reply', messages: commentReplyMessages({ ...input,
    socialContext: lookupSocialContext ? await lookupSocialContext(input) : null }),
    maxTokens: 500, temperature: 0.5, timeoutMs: 120000 });
}

function decisionOf(value, { contextText = '' } = {}) {
  if (!value || !['reply', 'none'].includes(value.action)) throw new Error('Invalid reply decision');
  const text = typeof value.text === 'string' ? value.text.trim() : '';
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 120) : '';
  if (value.action === 'none') return { action: 'none', text: '', reason };
  if (gameParticipationViolation(text, { contextText })) {
    return { action: 'none', text: '', reason: 'cannot_play_games' };
  }
  if (!text || text.length > 120 || !text.isWellFormed() || /[\u0000-\u001f\u007f]|😂|【SocioMem/iu.test(text)) {
    throw new Error('Invalid reply text');
  }
  return { action: 'reply', text, reason };
}

function limitsOf(input = {}) {
  const value = { ...defaultCommentReplyLimits, ...input };
  for (const [key, n] of Object.entries(value)) {
    if (!Number.isSafeInteger(n) || n < 0 || (['maxMoments', 'maxModelAttempts'].includes(key) && n === 0)) {
      throw new Error(`Invalid comment reply limit ${key}`);
    }
  }
  if (value.maxMoments > 100 || value.maxDecisionsPerCycle > 20 || value.maxRepliesPerDay > 100 ||
      value.maxReconciliationsPerCycle > 20 || value.leaseMs < 3 * 60000) {
    throw new Error('Comment reply limits exceed bounded worker limits');
  }
  return value;
}

function canReserve(store, limits, now, exclude = null) {
  const attempted = store.rows().filter(row => row.attemptedAt !== null && row.attemptedAt !== undefined);
  const attemptedKeys = new Set(attempted.map(row => row.key));
  const reservations = store.db.prepare('SELECT moment_id,comment_id,job_key,reserved_at FROM reply_monitor_comments WHERE reserved_at IS NOT NULL').all()
    .filter(row => (!exclude || row.moment_id !== exclude.moment_id || row.comment_id !== exclude.comment_id) &&
      (!row.job_key || !attemptedKeys.has(row.job_key)));
  const times = [...attempted.map(row => row.attemptedAt), ...reservations.map(row => row.reserved_at)];
  return times.filter(at => at >= dayStart(now)).length < limits.maxRepliesPerDay &&
    (!times.length || now - Math.max(...times) >= limits.cooldownMs);
}

const jobAttempted = job => job?.attemptedAt !== null && job?.attemptedAt !== undefined;
const completedJobs = new Set(['verified', 'rejected', 'stale', 'skipped']);
const ownLease = (db, id, cid, token) => db.prepare(`SELECT 1 FROM reply_monitor_comments
  WHERE moment_id=? AND comment_id=? AND lease_token=?`).get(id, cid, token);

function finishLease(db, row, token, { state, now, nextAt = 0, decision, jobKey = row.job_key } = {}) {
  return db.prepare(`UPDATE reply_monitor_comments SET state=?,next_at=?,reserved_at=NULL,
    job_key=?,decision_json=COALESCE(?,decision_json),updated_at=?,lease_token=NULL,lease_until=0
    WHERE moment_id=? AND comment_id=? AND lease_token=?`)
    .run(state, nextAt, jobKey, decision ? JSON.stringify(decision) : null, now, row.moment_id, row.comment_id, token).changes === 1;
}

/** Recover local leases without ever resubmitting an attempted publication. */
async function recoverPending({ store, service, now, send, limits, result, signal }) {
  const rows = store.db.prepare(`SELECT * FROM reply_monitor_comments
    WHERE state IN ('deciding','prepared','reconciling','dispatching','accepted','needs_review')
      AND lease_until<=? AND next_at<=? ORDER BY updated_at,moment_id,comment_id`).all(now, now);
  let count = 0;
  for (const row of rows) {
    if (signal?.aborted || count >= limits.maxReconciliationsPerCycle) break;
    let job = row.job_key ? store.get(row.job_key) : null;
    if (!job) {
      // Covers a crash between prepare() and recording its stable job key.
      let decision;
      try { decision = JSON.parse(row.decision_json); } catch {}
      if (decision?.action === 'reply') job = store.rows().find(item =>
        String(item.moment.id) === row.moment_id && String(item.comment.commentId) === row.comment_id &&
        item.text === decision.text) ?? null;
    }
    if (!job) {
      const state = row.state === 'deciding' && row.attempts < limits.maxModelAttempts &&
        row.first_seen_at >= now - limits.maxSourceAgeMs ? 'retry' : 'manual_review';
      store.db.prepare(`UPDATE reply_monitor_comments SET state=?,reserved_at=NULL,lease_token=NULL,
        lease_until=0,next_at=?,updated_at=? WHERE moment_id=? AND comment_id=? AND lease_until<=?
        AND state IN ('deciding','prepared','reconciling','dispatching','accepted','needs_review')`)
        .run(state, state === 'retry' ? now + limits.retryBackoffMs : 0, now, row.moment_id, row.comment_id, now);
      continue;
    }
    if (job.accountId && (job.accountId !== store.accountId || job.selfId !== store.selfId)) {
      throw new Error('Recovered reply job account mismatch');
    }
    if (String(job.moment.id) !== row.moment_id || String(job.comment.commentId) !== row.comment_id) {
      throw new Error('Recovered reply job source mismatch');
    }
    const token = randomUUID();
    const claimed = transaction(store.db, () => {
      if (job.state === 'draft' && send && !canReserve(store, limits, now, row)) return false;
      return store.db.prepare(`UPDATE reply_monitor_comments SET state='reconciling',job_key=?,lease_token=?,
        lease_until=?,updated_at=? WHERE moment_id=? AND comment_id=? AND lease_until<=? AND next_at<=?
        AND state IN ('deciding','prepared','reconciling','dispatching','accepted','needs_review')`)
        .run(job.key, token, now + limits.leaseMs, now, row.moment_id, row.comment_id, now, now).changes === 1;
    });
    if (!claimed) continue;
    if (completedJobs.has(job.state)) {
      finishLease(store.db, row, token, { state: job.state, jobKey: job.key, now });
      continue;
    }
    if (row.reconcile_attempts >= limits.maxReconcileAttempts) {
      finishLease(store.db, row, token, { state: 'manual_review', jobKey: job.key, now });
      continue;
    }
    if (job.state === 'draft' && !send) {
      finishLease(store.db, row, token, { state: 'shadow', jobKey: job.key, now });
      continue;
    }
    count++;
    store.db.prepare(`UPDATE reply_monitor_comments SET reconcile_attempts=reconcile_attempts+1,
      reserved_at=? WHERE moment_id=? AND comment_id=? AND lease_token=?`)
      .run(jobAttempted(job) ? null : now, row.moment_id, row.comment_id, token);
    try {
      // Even a dispatching/unknown job is status-only. Only an unequivocal local
      // draft may perform its original send, whose service rechecks and claims it.
      if (jobAttempted(job)) job = await service.status(job.key);
      else if (job.state === 'draft') job = await service.send(job.key, job.digest);
      else throw new Error('Unattempted reply job is not a draft');
      const terminal = completedJobs.has(job.state);
      finishLease(store.db, row, token, { state: terminal ? job.state : 'needs_review', jobKey: job.key,
        now, nextAt: terminal ? 0 : now + limits.retryBackoffMs * (row.reconcile_attempts + 1) });
      result.actions.push({ momentId: row.moment_id, sourceCommentId: row.comment_id,
        key: job.key, state: job.state, recovered: true });
    } catch (error) {
      finishLease(store.db, row, token, { state: 'needs_review', jobKey: job.key,
        now, nextAt: now + limits.retryBackoffMs * (row.reconcile_attempts + 1) });
      result.errors.push({ momentId: row.moment_id, commentId: row.comment_id, error: error.name, recovered: true });
    }
  }
}

export async function runCommentReplyCycle({ store, service, gateway, model, selfId, accountId,
  legacyLedgerPath, publishLedgerPath, momentIds = [], now = Date.now(), send = false,
  limits: inputLimits = {}, log = () => {}, signal } = {}) {
  if (typeof model !== 'function' || typeof gateway?.readMoment !== 'function' ||
      typeof service?.prepare !== 'function' || !Number.isSafeInteger(now)) throw new Error('Invalid comment reply worker dependencies');
  const limits = limitsOf(inputLimits);
  const identity = initialize(store, { accountId, selfId, now });
  const ids = discoverReplyMomentIds({ legacyLedgerPath, publishLedgerPath, accountId, selfId, now, limits, momentIds });
  const result = { watched: ids.length, read: 0, candidates: 0, modelCalls: 0, actions: [], errors: [] };
  await recoverPending({ store, service, now, send, limits, result, signal });
  for (const id of ids) {
    if (signal?.aborted) break;
    store.db.prepare('INSERT OR IGNORE INTO reply_monitor_watches (moment_id,first_seen_at) VALUES (?,?)').run(id, now);
    const watch = store.db.prepare('SELECT * FROM reply_monitor_watches WHERE moment_id=?').get(id);
    if (watch.next_poll_at > now) continue;
    let moment;
    try {
      moment = await gateway.readMoment(id);
      if (String(moment?.id) !== id) throw new Error('Reply watch identity mismatch');
      result.read++;
      store.db.prepare('UPDATE reply_monitor_watches SET last_polled_at=?,failures=0,next_poll_at=0 WHERE moment_id=?').run(now, id);
    } catch (error) {
      const next = now + Math.min(6 * 3600000, limits.readRetryBackoffMs * 2 ** Math.min(watch.failures, 7));
      store.db.prepare('UPDATE reply_monitor_watches SET failures=failures+1,next_poll_at=? WHERE moment_id=?').run(next, id);
      result.errors.push({ momentId: id, error: error.name, reason: String(error.message ?? '').slice(0, 180) });
      continue;
    }
    // No trust is placed in an account-less legacy discovery row.
    if (moment.author?.id !== selfId && !(moment.comments ?? []).some(item =>
      item.userId === selfId || item.replyTo === selfId)) continue;
    for (const comment of moment.comments ?? []) {
      if (signal?.aborted) break;
      if (!positiveId(String(comment.commentId ?? ''))) continue;
      const cid = String(comment.commentId);
      const source = JSON.stringify(sourceView(comment));
      const eligible = isCommentReplyCandidate(moment, comment, selfId);
      // SNS replies can inherit the source comment's old timestamp. Once a watch
      // has a baseline, newly observed comment IDs are the freshness evidence.
      const historical = identity.bootstrap || watch.last_polled_at === null;
      store.db.prepare(`INSERT OR IGNORE INTO reply_monitor_comments
        (moment_id,comment_id,source_json,state,first_seen_at,updated_at) VALUES (?,?,?,?,?,?)`)
        .run(id, cid, source, historical ? 'baseline' : eligible ? 'pending' : 'ignored', now, now);
      const seen = store.db.prepare('SELECT * FROM reply_monitor_comments WHERE moment_id=? AND comment_id=?').get(id, cid);
      if (!['pending', 'retry'].includes(seen.state)) continue;
      if (seen.source_json !== source || !eligible || seen.first_seen_at < now - limits.maxSourceAgeMs) {
        store.db.prepare("UPDATE reply_monitor_comments SET state='stale',reserved_at=NULL,updated_at=? WHERE moment_id=? AND comment_id=?").run(now, id, cid);
        continue;
      }
      result.candidates++;
      if (seen.next_at > now || result.modelCalls >= limits.maxDecisionsPerCycle) continue;
      const token = randomUUID();
      const claimed = transaction(store.db, () => {
        if (send && !canReserve(store, limits, now)) return false;
        return store.db.prepare(`UPDATE reply_monitor_comments SET state='deciding',attempts=attempts+1,
          reserved_at=?,updated_at=?,lease_token=?,lease_until=?
          WHERE moment_id=? AND comment_id=? AND state IN ('pending','retry') AND next_at<=? AND lease_until<=?`)
          .run(send ? now : null, now, token, now + limits.leaseMs, id, cid, now, now).changes === 1;
      });
      if (!claimed) continue;
      result.modelCalls++;
      let decision;
      try {
        const recentReplies = store.rows().filter(row => row.attemptedAt >= now - DAY).reverse();
        decision = decisionOf(await model({ moment, comment, selfId, recentReplies, now }),
          { contextText: `${comment.text}\n${moment.text ?? ''}` });
      } catch (error) {
        const attempts = seen.attempts + 1;
        finishLease(store.db, seen, token, { state: attempts >= limits.maxModelAttempts ? 'manual_review' : 'retry',
          nextAt: now + limits.retryBackoffMs * attempts, now });
        result.errors.push({ momentId: id, commentId: cid, error: error.name });
        continue;
      }
      if (!ownLease(store.db, id, cid, token)) continue;
      store.db.prepare('UPDATE reply_monitor_comments SET decision_json=?,updated_at=? WHERE moment_id=? AND comment_id=? AND lease_token=?')
        .run(JSON.stringify(decision), now, id, cid, token);
      if (decision.action === 'none' || signal?.aborted) {
        finishLease(store.db, seen, token, { state: signal?.aborted ? 'stopped' : 'silent', now });
        continue;
      }
      let job;
      try {
        job = await service.prepare({ moment, comment, text: decision.text });
        if (!ownLease(store.db, id, cid, token)) continue;
        store.db.prepare("UPDATE reply_monitor_comments SET job_key=?,state='prepared' WHERE moment_id=? AND comment_id=? AND lease_token=?")
          .run(job.key, id, cid, token);
        if (send) job = await service.send(job.key, job.digest);
        finishLease(store.db, seen, token, { state: send ? job.state : 'shadow', jobKey: job.key, now,
          nextAt: send && !completedJobs.has(job.state) ? now + limits.retryBackoffMs : 0 });
        result.actions.push({ momentId: id, sourceCommentId: cid, key: job.key, state: send ? job.state : 'shadow' });
      } catch (error) {
        finishLease(store.db, seen, token, { state: job ? 'needs_review' : 'manual_review', jobKey: job?.key,
          nextAt: now + limits.retryBackoffMs, now });
        result.errors.push({ momentId: id, commentId: cid, error: error.name });
      }
    }
  }
  log('moments.reply_cycle', result);
  return result;
}

/** Serial cancellable loop; caller owns the store and must close it after stop(). */
export function startCommentReplyMonitor(options = {}) {
  const intervalMs = options.intervalMs ?? 120000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3600000) throw new Error('Invalid reply monitor interval');
  const controller = new AbortController();
  const done = (async () => {
    while (!controller.signal.aborted) {
      try { await runCommentReplyCycle({ ...options, now: Date.now(), signal: controller.signal }); }
      catch (error) { options.log?.('moments.reply_cycle_error', { error: error.name }); }
      try { await delay(intervalMs, undefined, { signal: controller.signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  })();
  return { done, async stop() { controller.abort(); await done; } };
}
