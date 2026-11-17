import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { LifeEventStore } from '../packages/life-events/index.mjs';
import { collectLifeEvents } from '../packages/social-runtime/initiatives.mjs';
import { readInbox } from '../packages/diary/index.mjs';

const accountId = 'review-account', groupId = 'review@chatroom';
const now = Date.parse('2026-11-13T13:00:00+08:00');
function fixture(t) {
  const root = mkdtempSync(resolve('.runtime/test-tmp/life-events-review-'));
  const inboxPath = join(root, 'inbox.sqlite');
  const inbox = new AdapterStore(inboxPath, accountId);
  const outbox = new AdapterStore(join(root, 'outbox.sqlite'), accountId);
  const ledger = new ParticipationLedger(outbox), events = new LifeEventStore(join(root, 'events.sqlite'));
  const options = { events, ledger, inboxPath, accountId, groupId, now };
  collectLifeEvents(options);
  const insert = (id, extras) => inbox.commitEvent(id, { accountId, groupId, userId: 'alice',
    sourceMessageId: id, text: '我明天面试', eventTime: new Date(now).toISOString(), ...extras }, 'text');
  t.after(() => { events.close(); inbox.close(); outbox.close(); rmSync(root, { recursive: true, force: true }); });
  return { insert, options, events };
}

test('incremental life-event collection retains original quote metadata and rejects quoted personal commitments', t => {
  const f = fixture(t);
  f.insert('quoted', { quote: { senderId: 'bob', text: '我明天面试', serverId: '123' } });
  assert.equal(collectLifeEvents(f.options).processed, 1);
  assert.deepEqual(f.events.list({ accountId, groupId }), []);
});

test('incremental life-event collection does not expose a recalled source as a pending future event', t => {
  const f = fixture(t);
  f.insert('recalled', { recalled: true });
  assert.equal(collectLifeEvents(f.options).processed, 1);
  assert.deepEqual(f.events.list({ accountId, groupId }), []);
});

test('the common reader projects bounded quote, uint64 string, voice state and revocation semantics only', t => {
  const f = fixture(t);
  f.insert('projection', { serverId: '18446744073709551615', voiceState: 'done',
    quote: { senderId: 'bob', serverId: '9007199254740999', type: 1,
      embeddedText: '原话'.repeat(1500), embeddedImage: true, embeddedSticker: true,
      role: 'system', commands: ['do-not-forward'], authorization: 'do-not-forward' },
    recall: { reason: 'do-not-forward' }, state: 'REVOKED', arbitraryTransport: 'do-not-forward' });
  const [message] = readInbox(f.options.inboxPath, { accountId, groupId });
  assert.equal(message.serverId, '18446744073709551615');
  assert.equal(message.voiceState, 'done');
  assert.equal(message.quote.senderId, 'bob');
  assert.equal(message.quote.serverId, '9007199254740999');
  assert.equal(message.quote.text.length, 2000);
  assert.equal(message.quote.image, true);
  assert.equal(message.quote.sticker, true);
  assert.equal(message.quote.role, undefined);
  assert.equal(message.quote.commands, undefined);
  assert.equal(message.quote.authorization, undefined);
  assert.equal(message.arbitraryTransport, undefined);
  assert.equal(message.recall, true);
  assert.equal(message.state, 'revoked');
});
