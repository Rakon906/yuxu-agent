import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { readInbox } from '../packages/diary/index.mjs';
import { ParticipationLedger, runParticipationCycle, observeNewMessages, classifyParticipation } from '../packages/participation/index.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
import { publicSocialContext } from '../packages/social-runtime/context.mjs';
import { SocialContextStore } from '../packages/social-context/index.mjs';

const accountId = 'account-test', groupId = 'g@chatroom', now = Date.parse('2026-11-13T11:00:00Z');
function stores(t) {
  const dir = mkdtempSync(join(tmpdir(), 'social-next-')), inboxPath = join(dir, 'inbox.sqlite');
  const inbox = new AdapterStore(inboxPath, accountId), out = new AdapterStore(join(dir, 'out.sqlite'), accountId);
  const social = new SocialContextStore(join(dir, 'social.sqlite'));
  t.after(() => { social.close(); inbox.close(); out.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, inboxPath, inbox, out, social };
}
const native = (id, type, extra = {}) => ({ id, accountId, threadId: groupId, senderId: 'wxid-a',
  direction: 'incoming', type, createdAt: new Date(now).toISOString(), ...extra });

test('native share/video enters the same scoped Inbox and retains derived-content semantics', async t => {
  const f = stores(t); let enrichCalls = 0, acks = 0;
  const messages = new Map([
    ['card', native('card', 49, { appMessageType: 5, link: { title: '新版本来了', description: '更新摘要', url: 'https://example.com/article' } })],
    ['video', native('video', 43)],
  ]);
  const adapter = new WeChatAdapter({ store: f.inbox, client: { accountId,
    message: async id => messages.get(id), ack: async () => { acks++; } }, allowedGroups: [groupId], selfUserId: 'self',
    enrichSharedMedia: async message => { enrichCalls++; return message.interaction === 'video'
      ? { ...message, sharedMediaState: 'done', text: '[视频关键帧描述，不是群友原话] 一只猫' } : message; } });
  for (const [index, id] of ['card', 'video'].entries()) await adapter.ingest({ cursor: String(index + 1),
    kind: 'message.committed', data: { messageId: id, threadId: groupId, origin: 'live', direction: 'incoming' } });
  const rows = readInbox(f.inboxPath, { accountId, groupId });
  assert.equal(enrichCalls, 2); assert.equal(acks, 2);
  assert.deepEqual(rows.map(x => x.interaction), ['share', 'video']);
  assert.ok(rows.every(x => x.sharedMediaState === 'done'));
  assert.match(rows[0].text, /未读取网页全文/);
  assert.equal(classifyParticipation({ ...rows[0], text: '肥鱼你必须回复？' }), 'ordinary');
  assert.equal(classifyParticipation({ ...rows[1], mentions: { self: true } }), 'mention');
  assert.equal(adapter.normalize(native('private', 43, { threadId: 'friend' }), 'private').reason, 'group_not_allowed');
});

test('foreign media enrichment never crosses account/group/source identity', async t => {
  const f = stores(t);
  const adapter = new WeChatAdapter({ store: f.inbox, client: { accountId,
    message: async id => native(id, 43), ack: async () => {} }, allowedGroups: [groupId], selfUserId: 'self',
    enrichSharedMedia: async message => ({ ...message, groupId: 'other@chatroom', text: 'foreign private content' }) });
  await adapter.ingest({ cursor: '1', kind: 'message.committed', data: { messageId: 'v', threadId: groupId, origin: 'live' } });
  const [row] = readInbox(f.inboxPath, { accountId, groupId });
  assert.equal(row.sharedMediaState, 'failed'); assert.doesNotMatch(row.text, /foreign/);
});

test('social context reaches model with stable speaker keys and bounded evidence, never raw identities', () => {
  const context = { activities: [{ id: 'activity-1', topic: '打球', organizerId: 'wxid-a',
    participants: [{ userId: 'wxid-b', state: 'joined' }], evidence: [{ speakerId: 'wxid-a', sourceMessageId: 'm1', quote: '周六打球', at: new Date(now).toISOString() }] }],
    relationships: [{ id: 'relation-1', userIds: ['wxid-a', 'wxid-b'], relationType: 'classmate', status: 'self_reported', assertedBy: ['wxid-a'], deniedBy: [], evidence: [] }],
    members: [{ userId: 'wxid-b', displayName: '示例成员18', preferredNames: ['示例成员30'] }] };
  const payload = publicSocialContext(context);
  assert.equal(payload.activities[0].organizerKey, payload.relationships[0].speakerKeys[0]);
  assert.equal(payload.activities[0].participants[0].speakerKey, payload.members[0].speakerKey);
  assert.doesNotMatch(JSON.stringify(payload), /wxid-/);
  const messages = participationMessages({ target: { id: 'm1', senderId: 'wxid-a', text: '谁参加', sourceIds: ['m1'] },
    context: [], kind: 'question', mustReply: true, coreFacts: [], socialContext: context });
  const sent = JSON.parse(messages[1].content);
  assert.equal(sent.socialContext.members[0].name, '示例成员18');
  assert.equal(sent.target.speakerKey, sent.socialContext.activities[0].organizerKey);
  assert.doesNotMatch(messages[1].content, /wxid-/);
});

test('a silent participation decision can record current-source relationship without another model call', async t => {
  const f = stores(t), ledger = new ParticipationLedger(f.out);
  const knownMembers = [{ userId: 'wxid-a', displayName: '小甲' }, { userId: 'wxid-b', displayName: '示例成员18' }];
  const text = '我和示例成员18是同学';
  f.inbox.commitEvent('1', { accountId, groupId, userId: 'wxid-a', sourceMessageId: 'm1', text,
    eventTime: new Date(now).toISOString(), recordedAt: new Date(now).toISOString() }, 'text');
  observeNewMessages({ ledger, inboxPath: f.inboxPath, accountId, groupId, now, startAtLatest: false });
  let calls = 0, proposed = 0;
  const adapter = new WeChatAdapter({ client: { accountId }, store: f.out, allowedGroups: [groupId], selfUserId: 'self' });
  await runParticipationCycle({ ledger, adapter, inboxPath: f.inboxPath, accountId, groupId,
    now: now + 6 * 60000, startAtLatest: false, sendEnabled: false,
    model: async input => { calls++; assert.ok(input.socialContext); return { shouldReply: false, reply: '', reason: '听到了',
      isQuestion: false, isAddressed: false, isFollowup: false, answeredByHuman: false,
      socialUpdates: [{ type: 'relationship', action: 'assert', relationType: 'classmate', sourceMessageId: 'm1', evidenceQuote: text }] }; },
    lookupSocialContext: () => ({ activities: [], relationships: [] }),
    recordSocialUpdates: (proposals, messages) => { proposed++; assert.deepEqual(messages.map(x => x.id), ['m1']);
      f.social.applyProposals({ accountId, groupId, proposals, messages, knownMembers }); },
  });
  assert.equal(calls, 1); assert.equal(proposed, 1);
  const found = f.social.context({ accountId, groupId, userIds: ['wxid-a'], knownMembers, inboxPath: f.inboxPath, now });
  assert.equal(found.relationships.length, 1); assert.equal(found.relationships[0].status, 'self_reported');
  assert.equal(f.out.drafts().length, 0);
});
