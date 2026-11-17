import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decodeMessage, encodeFields, hexToBytes } from '../packages/moments/protobuf.mjs';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { isBusy, nextRunAt, planRuns, readTimeline, runMomentsCycle, selectCandidateMoments,
  validateMomentDecision } from '../packages/moments/worker.mjs';

test('game invitations cannot turn optional Moments comments into a personal gaming promise', () => {
  const result = validateMomentDecision({ action: 'comment', comment: '算我一个', reason: '回应邀约',
    memory: [{ kind: 'preference', evidenceQuote: '喜欢三角洲' }] }, { contextText: '有人玩三角洲吗' });
  assert.equal(result.action, 'none');
  assert.equal(result.comment, '');
  assert.equal(result.reason, 'cannot_play_games');
  assert.equal(result.memory.length, 1);
  assert.equal(validateMomentDecision({ action: 'comment', comment: '我看你们打就行', reason: '围观' },
    { contextText: '有人打三角洲吗' }).action, 'comment');
});

function replyFor({ id = 15047588497357935372n, author = 'wxid_friend', name = '好友',
  text = '今天天气不错', createTime = Math.floor(Date.now() / 1000), comments = [] } = {}) {
  const xml = `<TimelineObject><id>${id}</id><username>${author}</username>` +
    `<createTime>${createTime}</createTime><contentDesc>${text}</contentDesc>` +
    `<private>0</private><ContentObject><contentStyle>1</contentStyle></ContentObject></TimelineObject>`;
  const fields = [
    { number: 1, varint: id },
    { number: 2, bytes: author },
    { number: 3, bytes: name },
    { number: 4, varint: createTime },
    { number: 5, bytes: encodeFields([{ number: 1, varint: Buffer.byteLength(xml) },
      { number: 2, bytes: xml }]) },
  ];
  for (const comment of comments) {
    fields.push({ number: 12, bytes: encodeFields([
      { number: 1, bytes: comment.userId }, { number: 2, bytes: comment.name ?? '我' },
      { number: 4, varint: 2 }, { number: 5, bytes: comment.text },
      { number: 6, varint: comment.createTime }, { number: 7, varint: BigInt(comment.commentId) },
    ]) });
  }
  const object = encodeFields(fields);
  return encodeFields([
    { number: 1, bytes: encodeFields([{ number: 1, varint: 0 }]) },
    { number: 2, bytes: '0123456789abcdef' },
    { number: 3, varint: 1 },
    { number: 4, bytes: object },
  ]).toString('hex');
}

function emptyReply() {
  return encodeFields([
    { number: 1, bytes: encodeFields([{ number: 1, varint: 0 }]) },
    { number: 2, bytes: '0123456789abcdef' },
    { number: 3, varint: 0 },
  ]).toString('hex');
}

function tempLedger(t) {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moments-worker-'));
  const ledger = new MomentsLedger(join(root, 'ledger.sqlite'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return ledger;
}

test('moment decisions are bounded to none/like/comment with safe comment text', () => {
  assert.deepEqual(validateMomentDecision({ action: 'like', comment: 'ignored', reason: 'ok' }),
    { action: 'like', comment: '', reason: 'ok' });
  assert.deepEqual(validateMomentDecision({ action: 'comment', comment: '太真实了', reason: 'specific' }),
    { action: 'comment', comment: '太真实了', reason: 'specific' });
  assert.equal(validateMomentDecision({ action: 'comment', comment: 'https://example.com', reason: '' }).action, 'none');
  assert.equal(validateMomentDecision({ action: 'comment', comment: '@肥鱼 你看', reason: '' }).action, 'none');
  assert.equal(validateMomentDecision({ action: 'comment', comment: '', reason: '' }).action, 'none');
  assert.throws(() => validateMomentDecision({ action: 'delete', comment: '', reason: '' }), /action/u);
});

test('candidate moments exclude self, private, ads, old and already seen posts', t => {
  const ledger = tempLedger(t);
  const now = Date.now();
  const base = { media: [], likes: [], comments: [] };
  const timeline = { objects: [
    { ...base, id: 'a', author: { id: 'wxid_friend', name: 'A' }, text: '新动态', createTime: Math.floor(now / 1000) },
    { ...base, id: 'b', author: { id: 'wxid_self', name: '我' }, text: '自己', createTime: Math.floor(now / 1000) },
    { ...base, id: 'c', author: { id: 'wxid_friend2', name: 'C' }, text: '私密', private: true, createTime: Math.floor(now / 1000) },
    { ...base, id: 'd', author: { id: 'wxid_friend3', name: 'D' }, text: '广告', advertisement: true, createTime: Math.floor(now / 1000) },
    { ...base, id: 'e', author: { id: 'wxid_friend4', name: 'E' }, text: '旧动态', createTime: Math.floor((now - 4 * 86400000) / 1000) },
  ] };
  ledger.markSeen({ momentId: 'a', text: '新动态' });
  const candidates = selectCandidateMoments(timeline, { selfId: 'wxid_self', ledger, now });
  assert.deepEqual(candidates, []);
});

test('three daily runs stay inside the 12:00-24:00 window with spacing', t => {
  const ledger = tempLedger(t);
  const noon = new Date('2026-11-06T12:00:00+08:00').getTime();
  const plan = planRuns({ now: noon, runsPerDay: 3, minGapMs: 2 * 3600000, rng: () => 0.5 });
  assert.equal(plan.length, 3);
  assert.ok(plan.every(at => at >= noon && at < new Date('2026-11-07T00:00:00+08:00').getTime()));
  assert.ok(plan[0] < plan[1] && plan[1] < plan[2]);
  assert.ok(plan[1] - plan[0] >= 2 * 3600000 && plan[2] - plan[1] >= 2 * 3600000);
  const next = nextRunAt(ledger, { now: noon, runsPerDay: 3, minGapMs: 2 * 3600000, rng: () => 0.5 });
  assert.ok(next > noon);
  assert.equal(ledger.nextScheduled(), next);
});

test('timeline pagination follows the oldest object id and stops on an empty page', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  const client = { async probe(cgi, bodyHex) {
    const maxId = decodeMessage(hexToBytes(bodyHex)).fields.find(field => field.number === 3)?.varint ?? '0';
    if (maxId === '0') return { replyHex: replyFor({ id: 100n, createTime: nowSec }) };
    if (maxId === '100') return { replyHex: replyFor({ id: 50n, createTime: nowSec - 3600 }) };
    return { replyHex: emptyReply() };
  } };
  const timeline = await readTimeline({ client, now: Date.now() });
  assert.deepEqual(timeline.objects.map(object => object.id), ['100', '50']);
  assert.equal(timeline.pages, 3);
});

test('shadow mode records decisions without sending', async t => {
  const ledger = tempLedger(t);
  const client = { async probe(cgi) { return cgi === 211 ? { replyHex: replyFor() } : { baseCode: 0 }; } };
  const summary = await runMomentsCycle({ ledger, client, self: { id: 'wxid_self', name: '肥鱼' },
    model: async () => ({ action: 'like', comment: '', reason: '日常分享' }), send: false });
  assert.equal(summary.candidates, 1);
  assert.deepEqual(summary.decisions[0].action, 'like');
  assert.equal(summary.actions.length, 0);
  assert.equal(ledger.seen('15047588497357935372').decision, 'like');
});

test('real like send records clientId and daily count', async t => {
  const ledger = tempLedger(t);
  const calls = [];
  const client = { async probe(cgi, bodyHex, options) {
    calls.push({ cgi, bodyHex, options });
    return cgi === 211 ? { replyHex: replyFor() } : { baseCode: 0, replyBytes: 12 };
  } };
  const summary = await runMomentsCycle({ ledger, client, self: { id: 'wxid_self', name: '肥鱼' },
    model: async () => ({ action: 'like', comment: '', reason: '日常分享' }),
    send: true, likeSend: true, limits: { maxAgeMs: 72 * 3600000, maxPosts: 10,
      maxLikesPerDay: 5, maxCommentsPerDay: 3, cooldownMs: 0, busyMs: 0 } });
  assert.equal(summary.actions.length, 1);
  assert.equal(summary.actions[0].state, 'sent');
  assert.equal(calls.filter(call => call.cgi === 213).length, 1);
  assert.equal(ledger.countToday('like'), 1);
  const action = ledger.action(summary.actions[0].actionKey);
  assert.equal(action.state, 'sent');
  assert.match(action.client_id, /^\d{15}$/u);
  assert.ok(action.client_id && calls.find(call => call.cgi === 213).bodyHex.includes(Buffer.from(action.client_id).toString('hex')));
});

test('real comment send carries text and stores the server comment id', async t => {
  const ledger = tempLedger(t);
  const nowSec = Math.floor(Date.now() / 1000);
  let sent = false;
  const calls = [];
  const client = { async probe(cgi, bodyHex) {
    calls.push({ cgi, bodyHex });
    if (cgi === 211) {
      return { replyHex: sent ? replyFor({ comments: [{ userId: 'wxid_self', name: '肥鱼',
        text: '示例成员47本丸', commentId: '7', createTime: nowSec }] }) : replyFor() };
    }
    sent = true;
    return { baseCode: 0, replyBytes: 12 };
  } };
  const summary = await runMomentsCycle({ ledger, client, self: { id: 'wxid_self', name: '肥鱼' },
    model: async () => ({ action: 'comment', comment: '示例成员47本丸', reason: 'specific' }),
    send: true, commentSend: true, limits: { maxAgeMs: 72 * 3600000, maxPosts: 10,
      maxLikesPerDay: Infinity, maxCommentsPerDay: 3, cooldownMs: 0, busyMs: 0 } });
  assert.equal(summary.actions[0].state, 'sent');
  assert.equal(summary.actions[0].commentId, '7');
  assert.equal(ledger.action(summary.actions[0].actionKey).comment_id, '7');
  const sendCall = calls.find(call => call.cgi === 213);
  assert.ok(sendCall.bodyHex.includes(Buffer.from('示例成员47本丸').toString('hex')));
});

test('busy inbox defers the activity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moments-busy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filename = join(root, 'inbox.sqlite');
  const db = new DatabaseSync(filename);
  db.exec('CREATE TABLE inbox (id TEXT PRIMARY KEY, message TEXT NOT NULL)');
  db.prepare('INSERT INTO inbox VALUES (?,?)').run('m1',
    JSON.stringify({ at: new Date(Date.now() - 60000).toISOString() }));
  db.close();
  assert.equal(isBusy({ inboxPath: filename, now: Date.now() }), true);
  assert.equal(isBusy({ inboxPath: filename, now: Date.now() + 3600000 }), false);
});
