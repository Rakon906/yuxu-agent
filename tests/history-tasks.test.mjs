import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { createParticipationTools, searchHistory, validateToolRequest } from '../packages/participation/tools.mjs';
import { participationMessages } from '../packages/participation/model.mjs';

const ACCOUNT = 'history-account', GROUP = 'history@chatroom';
const now = Date.parse('2026-11-12T16:00:00+08:00');
const speakerKey = id => `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}`;
function fixture(t) {
  const root = mkdtempSync(resolve('.runtime/test-tmp/history-tasks-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const source = new AdapterStore(inboxPath, ACCOUNT);
  const outbox = new AdapterStore(join(root, 'participation.sqlite'), ACCOUNT);
  const ledger = new ParticipationLedger(outbox);
  let seq = 0;
  const insert = (id, text, fields = {}) => {
    const message = { platform: 'wechat', accountId: ACCOUNT, groupId: GROUP, userId: 'alice',
      sourceMessageId: id, text, eventTime: new Date(now).toISOString(), ...fields };
    source.commitEvent(String(++seq), message, 'fixture');
    const rowid = source.db.prepare('SELECT rowid FROM inbox WHERE id=?').get(id).rowid;
    return { id, rowid, senderId: message.userId, groupId: message.groupId,
      text: message.text, at: message.eventTime };
  };
  const open = (id, at = now, text = '周六几点集合？') => {
    const message = insert(id, text, { eventTime: new Date(at).toISOString() });
    ledger.observe(message, 'question', at);
    ledger.transition(id, 'skipped', 'unknown_answer');
    ledger.keepQuestionOpen(ledger.task(id), message.rowid, at);
    return message;
  };
  t.after(() => { source.close(); outbox.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, inboxPath, source, outbox, ledger, insert, open };
}

test('history search binds host scope, calendar dates, stable speaker keys and known recalls', async t => {
  const f = fixture(t);
  f.insert('early', '集合在九点', { eventTime: '2026-11-01T23:59:00+08:00' });
  f.insert('match', '集合在十点', { eventTime: '2026-11-02T00:00:00+08:00' });
  f.insert('last', '集合在十一点', { eventTime: '2026-11-02T23:59:00+08:00' });
  f.insert('late', '集合在十二点', { eventTime: '2026-11-03T00:00:00+08:00' });
  f.insert('other-sender', '集合在十三点', { userId: 'bob', eventTime: '2026-11-02T03:00:00Z' });
  f.insert('foreign-group', '集合的私密内容', { groupId: 'other@chatroom', eventTime: '2026-11-02T03:00:00Z' });
  f.insert('foreign-account', '集合的另一个账号内容', { accountId: 'other', eventTime: '2026-11-02T03:00:00Z' });
  f.insert('recalled', '集合的撤回内容', { recall: { at: '2026-11-02' }, eventTime: '2026-11-02T03:00:00Z' });
  const useTool = createParticipationTools({ accountId: ACCOUNT, groupId: GROUP, inboxPath: f.inboxPath,
    openMemory: () => assert.fail('history must not call vector/model service') });
  const result = await useTool({ name: 'history_search', query: '集合', senderId: speakerKey('alice'),
    from: '2026-11-02', to: '2026-11-02' });
  assert.deepEqual(result.messages.map(x => x.id), ['match', 'last']);
  assert.equal(result.coverage.toExclusive, '2026-11-02T16:00:00.000Z');
  assert.equal(result.coverage.truncated, false);
  assert.throws(() => searchHistory(f.inboxPath, { accountId: 'other', groupId: GROUP,
    request: { name: 'history_search', query: '集合' } }), /account mismatch/);
});

test('history cursor pages without duplicates, does not interpret query as SQL, and caps text', t => {
  const f = fixture(t);
  for (let i = 0; i < 7; i++) f.insert(`source-${i}`, '约饭 ' + '长'.repeat(1500));
  const read = request => searchHistory(f.inboxPath, { accountId: ACCOUNT, groupId: GROUP, request });
  const request = { name: 'history_search', query: '约饭', limit: 3 };
  const first = read(request), second = read({ ...request, beforeRowid: first.coverage.nextBeforeRowid });
  const third = read({ ...request, beforeRowid: second.coverage.nextBeforeRowid });
  assert.deepEqual(first.messages.map(x => x.id), ['source-4', 'source-5', 'source-6']);
  assert.equal(new Set([...first.messages, ...second.messages, ...third.messages].map(x => x.id)).size, 7);
  assert.equal(third.coverage.truncated, false);
  assert.equal(first.messages[0].text.length, 1200);
  assert.equal(first.messages[0].textTruncated, true);
  assert.equal(read({ name: 'history_search', query: "' OR 1=1 --" }).messages.length, 0);
});

test('history window reports unscanned history and validates every filter', t => {
  const f = fixture(t);
  f.source.transaction(() => {
    const insert = f.source.db.prepare('INSERT INTO inbox(id,message) VALUES (?,?)');
    for (let i = 0; i < 5002; i++) insert.run(`row-${i}`, JSON.stringify({ accountId: ACCOUNT,
      groupId: GROUP, userId: 'alice', sourceMessageId: `row-${i}`, text: i === 0 ? '老证据' : '别的话',
      eventTime: new Date(now).toISOString() }));
  });
  const request = { name: 'history_search', query: '老证据' };
  const first = searchHistory(f.inboxPath, { accountId: ACCOUNT, groupId: GROUP, request });
  assert.equal(first.messages.length, 0);
  assert.equal(first.coverage.scanned, 5000);
  assert.equal(first.coverage.truncated, true);
  const next = searchHistory(f.inboxPath, { accountId: ACCOUNT, groupId: GROUP,
    request: { ...request, beforeRowid: first.coverage.nextBeforeRowid } });
  assert.equal(next.messages[0].id, 'row-0');
  for (const input of [{ accountId: 'other' }, { groupId: 'other' }, { limit: 21 },
    { beforeRowid: -1 }, { from: '2026-02-30' }, { from: '2026-01-01T10:00:00' },
    { from: '2026-02-01', to: '2026-01-01' }, { senderId: "'; DROP TABLE inbox;--" }]) {
    assert.throws(() => validateToolRequest({ ...request, ...input }));
  }
  assert.throws(() => validateToolRequest({ name: 'history_search' }));
});

test('maintenance closes legacy stale questions, backfills literal evidence and remains idempotent', t => {
  const f = fixture(t);
  for (let i = 0; i < 6; i++) f.open(`old-${i}`, now - (i + 1) * 86400000);
  const current = f.open('current');
  const result = f.ledger.maintainTasks({ groupId: GROUP, inboxPath: f.inboxPath, now });
  assert.deepEqual(result, { inspected: 7, backfilled: 7, expired: 6, invalidated: 0, settled: 0 });
  const rows = f.ledger.db.prepare('SELECT * FROM agent_tasks ORDER BY id').all();
  assert.ok(rows.every(x => x.summary === '周六几点集合？' && x.evidence_quote === x.summary));
  assert.equal(rows.filter(x => x.closure_reason === 'question_window_elapsed').length, 6);
  assert.deepEqual(f.ledger.openTasks(GROUP).map(x => x.id), [current.id]);
  assert.equal(f.ledger.maintainTasks({ groupId: GROUP, inboxPath: f.inboxPath, now }).expired, 0);
  assert.equal(f.ledger.reopenQuestion(GROUP, 100, now), current.id);
  f.ledger.keepQuestionOpen(f.ledger.task('old-0'), 100, now, current);
  assert.equal(f.ledger.db.prepare('SELECT status FROM agent_tasks WHERE id=?').get('old-0').status, 'expired');
});

test('maintenance preserves real plans and uncertain sends, closes exhausted or invalidated questions', t => {
  const f = fixture(t);
  f.open('exhausted');
  f.ledger.db.prepare('UPDATE agent_tasks SET rechecks=2 WHERE id=?').run('exhausted');
  f.open('withdrawn');
  const msg = JSON.parse(f.source.db.prepare('SELECT message FROM inbox WHERE id=?').get('withdrawn').message);
  f.source.updateInbox('withdrawn', { ...msg, recalled: true });
  const plan = f.insert('plan', '下个月周六九点集合');
  f.ledger.notePlan({ sourceId: 'plan', groupId: GROUP, rowid: plan.rowid, summary: plan.text,
    evidenceId: plan.id, evidenceQuote: plan.text, status: 'open' }, now - 86400000);
  f.open('ambiguous', now - 86400000);
  f.ledger.db.prepare("UPDATE participation_tasks SET state='pending_receipt' WHERE source_id='ambiguous'").run();
  const r = f.ledger.maintainTasks({ groupId: GROUP, inboxPath: f.inboxPath, now });
  assert.equal(r.expired, 1);
  assert.equal(r.invalidated, 1);
  const rows = new Map(f.ledger.db.prepare('SELECT id,status FROM agent_tasks').all().map(x => [x.id, x.status]));
  assert.equal(rows.get('plan'), 'open');
  assert.equal(rows.get('ambiguous'), 'open');
  assert.equal(rows.get('withdrawn'), 'invalidated');
  assert.equal(rows.get('exhausted'), 'expired');
});

test('person observations retain provenance and consistently anonymize all speaker identities', () => {
  const profile = { userId: 'alice', observations: [{ subjectId: 'alice', topic: '游戏', kind: 'preference',
    state: 'candidate', uncertainty: 'observed', evidence: [{ id: 'e1', sourceMessageId: 'm1',
      speakerId: 'bob', quote: '喜欢玩游戏', at: new Date(now).toISOString() }] }] };
  const messages = participationMessages({ target: { id: 'm1', senderId: 'alice', text: '游戏', at: new Date(now).toISOString() },
    context: [], coreFacts: [], personProfile: profile, relatedProfiles: [profile] });
  const value = JSON.parse(messages[1].content);
  assert.equal(value.personProfile.observations[0].speakerKey, speakerKey('alice'));
  assert.equal(value.personProfile.observations[0].evidence[0].speakerKey, speakerKey('bob'));
  assert.equal(value.relatedProfiles[0].observations[0].speakerKey, speakerKey('alice'));
  assert.equal(value.personProfile.observations[0].subjectId, undefined);
  assert.equal(value.personProfile.observations[0].evidence[0].speakerId, undefined);
});

test('the real participation loop can search old history then answer with cited evidence within its tool budget', async t => {
  const f = fixture(t);
  const old = f.insert('old-source', '周六十点集合', { eventTime: '2026-11-01T10:00:00+08:00' });
  f.ledger.seed(GROUP, old.rowid);
  f.insert('new-question', '肥鱼 上次约了几点集合？');
  const adapter = new WeChatAdapter({ client: { accountId: ACCOUNT }, store: f.outbox,
    allowedGroups: [GROUP], selfUserId: 'agent-self', sendingEnabled: false });
  const useTool = createParticipationTools({ accountId: ACCOUNT, groupId: GROUP, inboxPath: f.inboxPath,
    openMemory: () => assert.fail('not a vector search') });
  let calls = 0;
  const model = async input => {
    calls++;
    const base = { isQuestion: true, isAddressed: true, isFollowup: false, answeredByHuman: false,
      shouldReply: false, reply: '', reason: 'history evidence check' };
    if (!input.toolResults.length) return { ...base, toolRequest: {
      name: 'history_search', query: '集合', from: '2026-11-01', to: '2026-11-01', senderId: speakerKey('alice') } };
    assert.equal(input.toolResults[0].messages[0].id, old.id);
    return { ...base, shouldReply: true, reply: '说好的是周六十点。', evidenceIds: [old.id] };
  };
  const args = { ledger: f.ledger, adapter, model, inboxPath: f.inboxPath,
    accountId: ACCOUNT, groupId: GROUP, useTool, sendEnabled: false };
  await runParticipationCycle({ ...args, now });
  const result = await runParticipationCycle({ ...args, now: now + 16000 });
  assert.equal(result.status, 'shadowed');
  assert.equal(calls, 2);
  assert.equal(f.outbox.drafts().length, 0);
});
