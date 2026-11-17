import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { SocialContextStore, collectSocialContext } from '../packages/social-context/index.mjs';

const now = Date.parse('2026-11-13T13:00:00+08:00');
const scope = { accountId: 'social-a', groupId: 'social@chatroom' };
const knownMembers = [{ userId: 'alice', displayName: '小艾' }, { userId: 'bob', displayName: '示例成员19', preferredNames: ['陈陈'] },
  { userId: 'carol', displayName: '小王' }];
const key = id => `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}`;
function fixture(t) {
  const root = mkdtempSync(resolve('.runtime/test-tmp/social-context-'));
  const inboxPath = join(root, 'inbox.sqlite'), filename = join(root, 'social.sqlite');
  const inbox = new AdapterStore(inboxPath, scope.accountId); let store = new SocialContextStore(filename), seq = 0;
  const insert = (text, senderId = 'alice', extra = {}) => {
    const id = `m${++seq}`, at = new Date(now + seq * 1000).toISOString();
    const raw = { ...scope, sourceMessageId: id, userId: senderId, text, eventTime: at, ...extra };
    inbox.commitEvent(String(seq), raw, 'text');
    return { id, text, senderId, at, ...scope, ...extra };
  };
  const ingest = (messages, extra = {}) => store.ingest({ ...scope, knownMembers, messages: Array.isArray(messages) ? messages : [messages], now, ...extra });
  const context = extra => store.context({ ...scope, knownMembers, now, inboxPath, ...extra });
  const mutate = (id, patch) => {
    const raw = JSON.parse(inbox.db.prepare('SELECT message FROM inbox WHERE id=?').get(id).message);
    inbox.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify({ ...raw, ...patch }), id);
  };
  t.after(() => { store.close(); inbox.close(); rmSync(root, { recursive: true, force: true }); });
  return { inbox, inboxPath, insert, ingest, context, mutate, get store() { return store; },
    restart() { store.close(); store = new SocialContextStore(filename); } };
}

test('shared activity joins and leaves preserve actors, host changes time, restart and duplicates retain state', t => {
  const f = fixture(t), created = f.insert('周六下午三点一起打球');
  assert.equal(f.ingest(created).inserted, 1);
  f.ingest(f.insert('我也去打球', 'bob'));
  f.ingest(f.insert('打球算我一个', 'carol'));
  const changed = f.insert('打球改到周六下午四点');
  f.ingest(changed);
  f.ingest(f.insert('我不去打球了', 'bob'));
  const activity = f.context().activities[0];
  assert.equal(activity.organizerId, 'alice'); assert.equal(activity.eventAt, '2026-11-14T08:00:00.000Z');
  assert.equal(activity.participants.find(p => p.userId === 'bob').state, 'left');
  assert.equal(activity.participants.find(p => p.userId === 'carol').state, 'joined');
  assert.equal(f.ingest(changed).duplicate, 1);
  f.restart(); assert.deepEqual(f.context().activities[0], activity);
});

test('non-organizers cannot reschedule or cancel and model ID cannot force ambiguous activity membership', t => {
  const f = fixture(t);
  f.ingest(f.insert('周六下午三点一起打球'));
  assert.equal(f.ingest(f.insert('打球改到周日下午三点', 'bob')).inserted, 0);
  assert.equal(f.ingest(f.insert('打球取消了', 'bob')).inserted, 0);
  f.ingest(f.insert('周日下午三点一起打球', 'carol'));
  assert.equal(f.context().activities.length, 2);
  const source = f.insert('我也去打球', 'bob');
  assert.equal(f.ingest(source).inserted, 0);
  const p = { type: 'activity', action: 'join', sourceMessageId: source.id, evidenceQuote: source.text,
    activityId: f.context().activities[0].id };
  assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [source], proposals: [p], now }).inserted, 0);
  assert.equal(f.ingest(f.insert('我周六去打球', 'bob')).inserted, 1);
  assert.equal(f.context().activities.find(a => a.day === '2026-11-14').participants.find(p => p.userId === 'bob').state, 'joined');
});

test('withdrawn creation removes dependent activity; withdrawn change restores valid prior time without deleting audit', t => {
  const f = fixture(t), created = f.insert('明晚八点一起打三角洲'); f.ingest(created);
  const changed = f.insert('三角洲改到明天晚上九点'); f.ingest(changed);
  assert.equal(f.context().activities[0].eventAt, '2026-11-14T13:00:00.000Z');
  const revision = f.context().revision;
  f.mutate(changed.id, { recall: true });
  assert.equal(f.context().activities[0].eventAt, '2026-11-14T12:00:00.000Z');
  assert.ok(f.context().revision > revision);
  f.mutate(created.id, { text: '取消这条原始约局' });
  assert.equal(f.context().activities.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM social_operations').get().n, 2);
});

test('relationships bind unique names to two known IDs and distinguish self report, mutual confirmation and disagreement', t => {
  const f = fixture(t);
  f.ingest(f.insert('我和陈陈是大学同学')); let r = f.context({ userIds: ['alice'] }).relationships[0];
  assert.deepEqual(r.userIds, ['alice', 'bob']); assert.equal(r.status, 'self_reported');
  f.ingest(f.insert('我跟小艾是同学', 'bob')); assert.equal(f.context().relationships[0].status, 'mutually_confirmed');
  f.ingest(f.insert('更正一下，我和示例成员19不是同学')); r = f.context().relationships[0];
  assert.equal(r.status, 'disputed'); assert.deepEqual(r.deniedBy, ['alice']);
  f.ingest(f.insert('我和小艾不是同学', 'bob')); assert.equal(f.context().relationships[0].status, 'denied');
  assert.equal(f.context({ userIds: ['carol'] }).relationships.length, 0);
  assert.equal(f.context({ query: '陈陈' }).relationships.length, 1);
});

test('model evidence, identity and scope cannot invent relationships or authorize another participant', t => {
  const f = fixture(t), source = f.insert('我和示例成员19是同事');
  const base = { type: 'relationship', action: 'assert', sourceMessageId: source.id, evidenceQuote: source.text,
    relationType: 'colleague', otherSpeakerKey: key('bob') };
  for (const patch of [{ otherSpeakerKey: key('carol') }, { senderId: 'carol' }, { groupId: 'other@chatroom' },
    { evidenceQuote: '我和示例成员19是同学' }, { relationType: 'classmate' }]) {
    assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [source], proposals: [{ ...base, ...patch }], now }).inserted, 0);
  }
  assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [source], proposals: [base], now }).inserted, 1);
  assert.equal(f.context({ groupId: 'other@chatroom' }).relationships.length, 0);
  assert.throws(() => f.store.context({ accountId: 'wrong', groupId: scope.groupId, inboxPath: f.inboxPath }), /account mismatch/);
});

test('quotes, hypotheticals, third parties, unknown or ambiguous names and non-text sources do not form facts', t => {
  const f = fixture(t);
  for (const text of ['他说我和示例成员19是同学', '我和示例成员19可能是同学', '我和示例成员19是同学吗？', '小艾和示例成员19是同学',
    '我和陌生人是同事', '我和示例成员19是恋人', '我和示例成员19是同学，不对，不是',
    '如果周六一起打球就好了']) assert.equal(f.ingest(f.insert(text)).inserted, 0, text);
  assert.equal(f.ingest(f.insert('我和示例成员19是同学', 'alice', { interaction: 'voice' })).inserted, 0);
  assert.equal(f.ingest(f.insert('我和示例成员19是同学', 'alice', { quote: { text: 'hello' } })).inserted, 0);
  assert.equal(f.ingest(f.insert('我和示例成员19是同学', 'unknown')).inserted, 0);
  assert.equal(f.ingest(f.insert('我和示例成员19是同学'), { knownMembers: [...knownMembers, { userId: 'double', displayName: '示例成员19' }] }).inserted, 0);
  assert.equal(f.ingest(f.insert('我和示例成员19是同学', 'alice', { groupId: 'else@chatroom' })).inserted, 0);
  f.ingest(f.insert('明晚八点一起打三角洲'));
  assert.equal(f.ingest(f.insert('示例成员19说算我一个', 'carol')).inserted, 0);
  assert.equal(f.ingest(f.insert('我朋友不来打三角洲', 'bob')).inserted, 0);
});

test('incremental collection waits for roster, starts at current end, handles new chat idempotently and invalidates recalls', t => {
  const f = fixture(t); f.insert('我和示例成员19是同学');
  const collect = extra => collectSocialContext({ store: f.store, inboxPath: f.inboxPath, ...scope, knownMembers, now, ...extra });
  assert.equal(collect({ knownMembers: [] }).reason, 'roster_unavailable');
  assert.equal(f.store.db.prepare('SELECT cursor FROM social_scopes').get().cursor, null);
  assert.equal(collect().initialized, true); assert.equal(f.context().relationships.length, 0);
  const latest = f.insert('我和示例成员19是队友');
  assert.equal(collect().processed, 1); assert.equal(collect().processed, 0);
  assert.equal(f.context().relationships.length, 1);
  f.mutate(latest.id, { recalled: true }); collect(); assert.equal(f.context().relationships.length, 0);
  f.restart(); assert.equal(collect().processed, 0);
});

test('natural-language lookups select topic, person or date and neutral questions keep active context', t => {
  const f = fixture(t);
  f.ingest(f.insert('周六下午三点一起打球'));
  f.ingest(f.insert('我也去打球', 'bob'));
  f.ingest(f.insert('周日下午四点一起打三角洲', 'carol'));
  f.ingest(f.insert('我和示例成员19是同学'));
  assert.equal(f.context({ query: '这次都有谁参加？', userIds: ['alice'] }).activities.length, 2);
  assert.equal(f.context({ query: '打球现在都有哪些人？' }).activities[0].topic, '打球');
  assert.equal(f.context({ query: '示例成员19参加了哪个活动？' }).activities.length, 1);
  assert.equal(f.context({ query: '周日那个活动呢？' }).activities[0].topic, '三角洲');
  assert.equal(f.context({ query: '我和陈陈是同学吗', userIds: ['carol'] }).relationships[0].relationType, 'classmate');
  assert.equal(f.context({ query: '随便聊聊', userIds: ['carol'] }).relationships.length, 0);
  f.ingest(f.insert('打球取消了'));
  assert.equal(f.context({ query: '这次都有谁参加？' }).activities.length, 1);
  assert.equal(f.context({ query: '打球取消了吗？' }).activities[0].state, 'cancelled');
});

test('short continuous model quote is accepted but full-source semantics prevent slicing away a denial', t => {
  const f = fixture(t), message = f.insert('我和示例成员19是同事，今天还一起吃饭了');
  const p = { type: 'relationship', action: 'assert', sourceMessageId: message.id,
    evidenceQuote: '我和示例成员19是同事', relationType: 'colleague', otherSpeakerKey: key('bob') };
  assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [message], proposals: [p], now }).inserted, 1);
  const denied = f.insert('我和示例成员19不是同学');
  assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [denied], proposals: [{
    ...p, relationType: 'classmate', sourceMessageId: denied.id, evidenceQuote: '同学' }], now }).inserted, 0);
});

test('unsettled intention never confirms attendance, while explicit decisions do', t => {
  const f = fixture(t);
  f.ingest(f.insert('周六下午三点一起打球'));
  const activityId = f.context().activities[0].id;
  for (const text of ['我还没决定去打球', '我不一定参加', '我想去打球', '我考虑参加',
    '我没有决定参加', '我没想好去不去', '我准备考虑参加', '我打算参加打球',
    '我参加的话再说吧', '我看情况参加', '我待定，打球再看看', '我参加吗']) {
    const source = f.insert(text, 'bob');
    assert.equal(f.ingest(source).inserted, 0, text);
    assert.equal(f.store.applyProposals({ ...scope, knownMembers, messages: [source], proposals: [{
      type: 'activity', action: 'join', sourceMessageId: source.id, evidenceQuote: source.text, activityId }], now }).inserted, 0, text);
  }
  assert.equal(f.context().activities[0].participants.some(p => p.userId === 'bob'), false);
  assert.equal(f.ingest(f.insert('我决定参加打球', 'bob')).inserted, 1);
  assert.equal(f.ingest(f.insert('我确定去打球', 'carol')).inserted, 1);
  assert.equal(f.context().activities[0].participants.filter(p => p.state === 'joined').length, 2);
  // Uncertain cancellation must not discard a prior firm registration.
  assert.equal(f.ingest(f.insert('我考虑不去打球了', 'bob')).inserted, 0);
  assert.equal(f.context().activities[0].participants.find(p => p.userId === 'bob').state, 'joined');
});
