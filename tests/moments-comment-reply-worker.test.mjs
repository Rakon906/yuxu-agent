import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isCommentReplyCandidate, runCommentReplyCycle, discoverReplyMomentIds,
  createCommentReplyModel, commentReplyMessages, startCommentReplyMonitor }
  from '../packages/moments/comment-reply-worker.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runs = join(root, '.runtime', 'runs');
mkdirSync(runs, { recursive: true });
const NOW = Date.UTC(2026, 10, 11, 9);
const SELF = 'wxid_self';
const ACCOUNT = 'account-test';
const c = (id, time, delta = {}) => ({ commentId: String(id), userId: 'wxid_friend', name: '朋友',
  text: '今天也在摸鱼呀', createTime: Math.floor(time / 1000), replyTo: null, replyCommentId: null, ...delta });

function fixture(t, { moment = null, model, send = false } = {}) {
  const dir = mkdtempSync(join(runs, 'comment-reply-worker-'));
  const dbPath = join(dir, 'reply.sqlite');
  let db = new DatabaseSync(dbPath);
  const jobs = new Map();
  const store = { get db() { return db; }, rows: () => [...jobs.values()], get: key => jobs.get(key) ?? null };
  const state = { moment: moment ?? { id: '101', author: { id: SELF, name: '肥鱼' }, text: '摸鱼', comments: [] },
    modelCalls: 0, sends: 0, reads: 0, statusCalls: 0, now: NOW, failure: null, statusResult: 'verified' };
  const service = {
    prepare({ moment, comment, text }) {
      const key = `${moment.id}-${comment.commentId}`;
      if (!jobs.has(key)) jobs.set(key, { key, digest: 'digest', moment, comment, text,
        state: 'draft', attemptedAt: null });
      return jobs.get(key);
    },
    async send(key) {
      const job = jobs.get(key);
      if (!job.attemptedAt) { state.sends++; job.attemptedAt = state.now; job.state = 'verified'; }
      return job;
    },
    async status(key) {
      state.statusCalls++;
      const job = jobs.get(key);
      job.state = state.statusResult;
      return job;
    },
  };
  const gateway = { async readMoment() { state.reads++; if (state.failure) throw state.failure; return state.moment; } };
  const options = { store, service, gateway, model: async input => {
    state.modelCalls++; return model ? await model(input) : { action: 'reply', text: '摸鱼也得认真一点', reason: '回应朋友' };
  }, selfId: SELF, accountId: ACCOUNT, momentIds: ['101'], send };
  t.after(() => db.close());
  return { ...state, state, dir, dbPath, jobs, store, options,
    reopen() { db.close(); db = new DatabaseSync(dbPath); },
    async cycle(now = state.now, more = {}) { state.now = now; return runCommentReplyCycle({ ...options, now, ...more }); } };
}

test('candidate selection follows explicit person-to-person relations and ignores third parties', () => {
  const own = { id: '101', author: { id: SELF }, comments: [] };
  const other = { id: '101', author: { id: 'wxid_other' }, comments: [c(2, NOW, { userId: SELF })] };
  assert.equal(isCommentReplyCandidate(own, c(1, NOW), SELF), true);
  assert.equal(isCommentReplyCandidate(own, c(1, NOW, { userId: SELF }), SELF), false);
  assert.equal(isCommentReplyCandidate(own, c(1, NOW, { replyTo: 'wxid_other', replyCommentId: '2' }), SELF), false);
  assert.equal(isCommentReplyCandidate(other, c(1, NOW), SELF), false);
  assert.equal(isCommentReplyCandidate(other, c(1, NOW, { replyTo: SELF }), SELF), true);
  assert.equal(isCommentReplyCandidate(other, c(1, NOW, { replyCommentId: '2' }), SELF), true);
  assert.equal(isCommentReplyCandidate(other, c(1, NOW, { replyTo: 'wxid_other', replyCommentId: '2' }), SELF), false);
  assert.equal(isCommentReplyCandidate(own, c(1, NOW, { commentId: '0' }), SELF), false);
  assert.equal(isCommentReplyCandidate(own, c(1, NOW, { replyReferenceSupported: false }), SELF), false);
});

test('first activation baselines historical comments and idle polls make zero model requests', async t => {
  const f = fixture(t, { send: true });
  f.state.moment.comments = [c(1, NOW - 10000)];
  assert.equal((await f.cycle()).modelCalls, 0);
  await f.cycle(NOW + 120000);
  f.reopen();
  await f.cycle(NOW + 240000);
  assert.equal(f.state.modelCalls, 0);
  assert.equal(f.state.sends, 0);
  assert.equal(f.store.db.prepare('SELECT state FROM reply_monitor_comments').get().state, 'baseline');
});

test('a game participation reply is terminal silence across polls and restart, without retry cost', async t => {
  const f = fixture(t, { send: true, model: async () => ({ action: 'reply', text: '我来', reason: '参加' }) });
  await f.cycle();
  f.state.moment.comments.push(c(1, NOW + 10000, { text: '有人打三角洲吗' }));
  await f.cycle(NOW + 120000);
  f.reopen();
  await f.cycle(NOW + 240000);
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.sends, 0);
  assert.equal(f.jobs.size, 0);
  const row = f.store.db.prepare('SELECT state,decision_json FROM reply_monitor_comments').get();
  assert.equal(row.state, 'silent');
  assert.equal(JSON.parse(row.decision_json).reason, 'cannot_play_games');
});

test('new own-post comment receives exactly one targeted reply across later polls and restart', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments.push(c(1, NOW + 10000));
  const result = await f.cycle(NOW + 120000);
  assert.equal(result.modelCalls, 1);
  assert.equal(result.actions[0].state, 'verified');
  assert.equal(f.jobs.get('101-1').comment.userId, 'wxid_friend');
  f.reopen();
  await f.cycle(NOW + 240000);
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.sends, 1);
});

test('other-post direct reply is eligible even if the older self comment is not returned', async t => {
  const f = fixture(t, { send: true });
  f.state.moment.author.id = 'wxid_other';
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000, { replyTo: SELF, replyCommentId: '55' })];
  await f.cycle(NOW + 120000);
  assert.equal(f.state.sends, 1);
});

test('new comment ID after baseline remains eligible with an inherited old timestamp', async t => {
  const f = fixture(t, { send: true });
  f.state.moment.author.id = 'wxid_other';
  f.state.moment.comments = [c(1, NOW - 10 * 86400000, { userId: SELF })];
  await f.cycle();
  f.state.moment.comments.push(c(2, NOW - 10 * 86400000, { replyTo: SELF, replyCommentId: '1' }));
  await f.cycle(NOW + 120000);
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.sends, 1);
});

test('third-party discussion under own post is never sent to model', async t => {
  const f = fixture(t);
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000, { replyTo: 'wxid_another', replyCommentId: '33' })];
  await f.cycle(NOW + 120000);
  assert.equal(f.state.modelCalls, 0);
});

test('silent decisions and shadow previews are persisted without sending or re-evaluating', async t => {
  for (const action of ['none', 'reply']) {
    const f = fixture(t, { model: () => ({ action, text: action === 'none' ? '' : '今天也想躺着', reason: '测试' }) });
    await f.cycle();
    f.state.moment.comments = [c(1, NOW + 10000)];
    await f.cycle(NOW + 120000);
    await f.cycle(NOW + 240000, { send: true });
    assert.equal(f.state.modelCalls, 1);
    assert.equal(f.state.sends, 0);
    assert.equal(f.store.db.prepare('SELECT state FROM reply_monitor_comments').get().state,
      action === 'none' ? 'silent' : 'shadow');
  }
});

test('daily budget and cooldown are checked before any new model call', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000), c(2, NOW + 11000)];
  await f.cycle(NOW + 120000, { limits: { maxRepliesPerDay: 1 } });
  assert.equal(f.state.modelCalls, 1);
  await f.cycle(NOW + 240000, { limits: { maxRepliesPerDay: 1 } });
  assert.equal(f.state.modelCalls, 1);
  await f.cycle(NOW + 241000, { limits: { maxRepliesPerDay: 2, cooldownMs: 3600000 } });
  assert.equal(f.state.modelCalls, 1);
});

test('concurrent pollers atomically claim a source comment before generating', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { send: true, model: async () => { await gate; return { action: 'reply', text: '给我也留点摸鱼时间' }; } });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  const first = f.cycle(NOW + 120000);
  await new Promise(resolve => setImmediate(resolve));
  const second = await f.cycle(NOW + 120000);
  assert.equal(second.modelCalls, 0);
  release();
  await first;
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.sends, 1);
});

test('model errors retry with backoff and stop after the bounded attempts', async t => {
  const f = fixture(t, { send: true, model: () => { throw new Error('unavailable'); } });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  const limits = { retryBackoffMs: 1000, maxModelAttempts: 2 };
  await f.cycle(NOW + 120000, { limits });
  await f.cycle(NOW + 120100, { limits });
  assert.equal(f.state.modelCalls, 1);
  await f.cycle(NOW + 122000, { limits });
  await f.cycle(NOW + 240000, { limits });
  assert.equal(f.state.modelCalls, 2);
  assert.equal(f.store.db.prepare('SELECT state,reserved_at FROM reply_monitor_comments').get().state, 'manual_review');
  assert.equal(f.state.sends, 0);
});

test('failed detail reads back off without invoking model, and account mismatch is rejected', async t => {
  const f = fixture(t);
  f.state.failure = new Error('unavailable');
  await f.cycle();
  await f.cycle(NOW + 119999);
  assert.equal(f.state.reads, 1);
  assert.equal(f.state.modelCalls, 0);
  await f.cycle(NOW + 120000);
  assert.equal(f.state.reads, 2);
  assert.equal(f.state.modelCalls, 0);
  await assert.rejects(() => f.cycle(NOW + 240000, { accountId: 'another-account' }), /account mismatch/u);
});

test('discovery is bounded, account-filters publication rows and only reads existing ledgers', t => {
  const f = fixture(t);
  const publication = join(f.dir, 'publish.sqlite');
  const db = new DatabaseSync(publication);
  db.exec('CREATE TABLE publications (moment_id TEXT,account_id TEXT,state TEXT,updated_at INTEGER,draft_json TEXT)');
  const insert = db.prepare('INSERT INTO publications VALUES (?,?,?,?,?)');
  insert.run('101', ACCOUNT, 'verified', NOW, JSON.stringify({ selfUserId: SELF }));
  insert.run('102', 'other', 'verified', NOW, JSON.stringify({ selfUserId: SELF }));
  insert.run('103', ACCOUNT, 'verified', NOW, JSON.stringify({ selfUserId: 'wxid_other' }));
  insert.run('104', ACCOUNT, 'draft', NOW, JSON.stringify({ selfUserId: SELF }));
  db.close();
  const before = readFileSync(publication);
  assert.deepEqual(discoverReplyMomentIds({ publishLedgerPath: publication, accountId: ACCOUNT,
    selfId: SELF, now: NOW }), ['101']);
  assert.deepEqual(readFileSync(publication), before);
});

test('reply prompt preserves IDs and relations and uses its own output schema', async () => {
  const input = { moment: { id: '101', author: { id: 'wxid_author', name: '同名' }, text: '原动态',
    comments: [c(1, NOW, { userId: SELF })] }, comment: c(2, NOW, { replyTo: SELF, name: '同名', replyCommentId: '1' }), selfId: SELF };
  const messages = commentReplyMessages(input);
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.target.userId, 'wxid_friend');
  assert.equal(payload.target.replyTo, SELF);
  assert.equal(payload.conversation[0].userId, SELF);
  assert.ok(messages[0].content.includes('"action":"reply"'));
  let call;
  const model = createCommentReplyModel({ provider: 'ollama', ollama: async args => { call = args; return { action: 'none' }; } });
  await model(input);
  assert.equal(call.component, 'moments_reply');
  assert.equal(call.maxTokens, 500);
});

test('monitor stop cancels its idle timer and awaits the active cycle', async t => {
  const f = fixture(t);
  const monitor = startCommentReplyMonitor({ ...f.options, intervalMs: 3600000 });
  await monitor.stop();
  await monitor.done;
  assert.equal(f.state.sends, 0);
});

test('unsupported reference shapes never trigger model or sending', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000, { replyReferenceSupported: false })];
  await f.cycle(NOW + 120000);
  assert.equal(f.state.modelCalls, 0);
  assert.equal(f.state.sends, 0);
});

test('expired decision lease is reclaimed with bounded retry and stale owner cannot finish it', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const f = fixture(t, { send: true, model: async () => {
    if (first) { first = false; await gate; }
    return { action: 'reply', text: '这次我接住了' };
  } });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  const original = f.cycle(NOW + 120000, { limits: { retryBackoffMs: 1000 } });
  await new Promise(resolve => setImmediate(resolve));
  await f.cycle(NOW + 120001, { limits: { retryBackoffMs: 1000 } });
  assert.equal(f.state.modelCalls, 1);
  await f.cycle(NOW + 421000, { limits: { retryBackoffMs: 1000 } });
  assert.equal(f.store.db.prepare('SELECT state,reserved_at FROM reply_monitor_comments').get().state, 'retry');
  await f.cycle(NOW + 423000, { limits: { retryBackoffMs: 1000 } });
  release();
  await original;
  assert.equal(f.state.modelCalls, 2);
  assert.equal(f.state.sends, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM reply_monitor_comments').get().state, 'verified');
});

test('exhausted abandoned decisions release reservations without another model request', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  await f.cycle(NOW + 120000, { limits: { maxDecisionsPerCycle: 0 } });
  f.store.db.prepare(`UPDATE reply_monitor_comments SET state='deciding',attempts=3,
    lease_token='crashed',lease_until=?,reserved_at=?`).run(NOW + 121000, NOW + 120000);
  await f.cycle(NOW + 240000);
  const row = f.store.db.prepare('SELECT state,reserved_at,lease_token FROM reply_monitor_comments').get();
  assert.equal(row.state, 'manual_review');
  assert.equal(row.reserved_at, null);
  assert.equal(row.lease_token, null);
  assert.equal(f.state.modelCalls, 0);
});

test('prepared unattempted job resumes its original send after lease expiry without regenerating', async t => {
  const f = fixture(t);
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  await f.cycle(NOW + 120000);
  f.store.db.prepare(`UPDATE reply_monitor_comments SET state='prepared',lease_token='crashed',
    lease_until=?,reserved_at=?`).run(NOW + 121000, NOW + 120000);
  await f.cycle(NOW + 120500, { send: true });
  assert.equal(f.state.sends, 0);
  f.reopen();
  await f.cycle(NOW + 122000, { send: true });
  await f.cycle(NOW + 240000, { send: true });
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.state.sends, 1);
});

test('attempted unknown jobs recover only with status, and unresolved reads stop at a bound', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  await f.cycle(NOW + 120000);
  const job = f.jobs.get('101-1');
  job.state = 'needs_review';
  f.state.statusResult = 'needs_review';
  f.store.db.prepare("UPDATE reply_monitor_comments SET state='needs_review',next_at=0").run();
  const limits = { retryBackoffMs: 1000, maxReconcileAttempts: 2 };
  await f.cycle(NOW + 122000, { limits });
  await f.cycle(NOW + 122001, { limits });
  assert.equal(f.state.statusCalls, 1);
  await f.cycle(NOW + 124000, { limits });
  await f.cycle(NOW + 130000, { limits });
  await f.cycle(NOW + 240000, { limits });
  assert.equal(f.state.statusCalls, 2);
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.store.db.prepare('SELECT state,reserved_at FROM reply_monitor_comments').get().state, 'manual_review');
  assert.equal(f.store.db.prepare('SELECT reserved_at FROM reply_monitor_comments').get().reserved_at, null);
});

test('prepared job whose send already happened is verified, never resent', async t => {
  const f = fixture(t, { send: true });
  await f.cycle();
  f.state.moment.comments = [c(1, NOW + 10000)];
  await f.cycle(NOW + 120000);
  f.jobs.get('101-1').state = 'dispatching';
  f.store.db.prepare("UPDATE reply_monitor_comments SET state='prepared',lease_until=0,next_at=0").run();
  f.reopen();
  await f.cycle(NOW + 240000);
  assert.equal(f.state.statusCalls, 1);
  assert.equal(f.state.sends, 1);
  assert.equal(f.state.modelCalls, 1);
  assert.equal(f.store.db.prepare('SELECT state FROM reply_monitor_comments').get().state, 'verified');
});
