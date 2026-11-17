import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { planDiary, runDiary, readDiaryState, DiaryStore } from '../packages/diary/index.mjs';
import { selectChatContext, CHAT_COMPACT_MESSAGES, CHAT_COMPACT_TOKENS } from '../packages/memory/context-policy.mjs';

const accountId = 'capacity-account', groupId = 'capacity@chatroom';
function fixture(t, count, text = '好') {
  const root = mkdtempSync(join(process.cwd(), '.runtime/context-capacity-'));
  const inboxPath = join(root, 'inbox.sqlite'), diaryPath = join(root, 'diary.sqlite');
  const adapter = new AdapterStore(inboxPath, accountId);
  t.after(() => adapter.close());
  for (let i = 1; i <= count; i++) adapter.commitEvent(String(i), {
    accountId, groupId, userId: 'member-a', sourceMessageId: `message-${i}`,
    eventTime: '2026-01-01T08:00:00.000Z', text, mentions: { state: 'none', self: false, userIds: [] },
  }, 'text');
  return { accountId, groupId, inboxPath, diaryPath, now: Date.parse('2026-11-16T08:00:00Z') };
}

test('quiet months do not trigger a diary or call any model by default', async t => {
  const f = fixture(t, 3), store = new DiaryStore(f.diaryPath);
  t.after(() => store.close());
  assert.equal(planDiary(f).reason, 'below_capacity');
  assert.equal(planDiary(f).timeTriggerEnabled, false);
  const result = await runDiary({ ...f, store,
    model: () => { throw new Error('must not call model'); },
    memory: { getAll: async () => ({ results: [] }) } });
  assert.equal(result.status, 'waiting');
  assert.equal(store.progress(accountId, groupId), 0);
});

test('message-count pressure consolidates before the 999-message context boundary', t => {
  const f = fixture(t, CHAT_COMPACT_MESSAGES + 400);
  const plan = planDiary(f);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.reason, 'message_capacity');
  assert.equal(plan.pendingAtLeast, CHAT_COMPACT_MESSAGES);
  assert.equal(plan.messageCountTrigger, 800);
});

test('failed or missing diary indexes do not let compaction skip an unindexed gap', t => {
  const f = fixture(t, 0), store = new DiaryStore(f.diaryPath);
  t.after(() => store.close());
  for (let i = 1; i <= 3; i++) store.save({ id: `segment-${i}`, accountId, groupId,
    previousRowid: (i - 1) * 10, startRowid: (i - 1) * 10 + 1, endRowid: i * 10,
    startAt: '2026-01-01T00:00:00Z', endAt: '2026-01-01T01:00:00Z',
    title: 'test', summary: 'test', events: [], sourceMessageIds: [] }, [], []);
  store.db.prepare('UPDATE segments SET indexed=1 WHERE id IN (?,?)').run('segment-1', 'segment-3');
  const before = readDiaryState(f.diaryPath, accountId, groupId);
  assert.equal(before.lastRowid, 30);
  assert.equal(before.consolidatedThroughRowid, 10);
  store.db.prepare('UPDATE segments SET indexed=1 WHERE id=?').run('segment-2');
  assert.equal(readDiaryState(f.diaryPath, accountId, groupId).consolidatedThroughRowid, 30);
  assert.equal(readDiaryState(f.diaryPath, accountId, 'different@chatroom').consolidatedThroughRowid, 0);
});

test('chat serialization pressure consolidates before the primary token ceiling', t => {
  const f = fixture(t, 50, '这是需要保留的人物对话'.repeat(120));
  const plan = planDiary(f);
  assert.equal(plan.status, 'ready');
  assert.equal(plan.reason, 'context_capacity');
  assert.ok(plan.pendingContextTokens >= CHAT_COMPACT_TOKENS);
  assert.ok(plan.pendingEstimatedTokens < 120000);
});

test('only successfully checkpointed history is compacted, with a continuity tail', () => {
  const items = Array.from({ length: 200 }, (_, index) => ({ rowid: index + 1,
    id: `m${index}`, text: '旧消息', at: '2026-01-01T00:00:00Z' }));
  assert.equal(selectChatContext(items).length, 200);
  const selected = selectChatContext(items, { consolidatedThroughRowid: 150 });
  assert.equal(selected.length, 80);
  assert.equal(selected[0].rowid, 121);
  assert.equal(selected.at(-1).rowid, 200);
  assert.equal(selectChatContext(items, { consolidatedThroughRowid: 50 }).length, 150);
  assert.equal(selectChatContext([{ text: 'no rowid' }], { consolidatedThroughRowid: 10 }).length, 1);
});
