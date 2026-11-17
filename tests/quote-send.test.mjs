import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { quoteReferenceFromInbox, validateQuoteReference, verifyQuoteReference } from '../packages/wechat-adapter/quote-send.mjs';

const accountId = 'account-test', groupId = 'group@chatroom';
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE inbox(id TEXT PRIMARY KEY,message TEXT);');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('accountId', accountId);
  const source = { accountId, groupId, sourceMessageId: 'message1', serverId: '18446744073709551615', userId: 'friend', text: '我明天面试' };
  db.prepare('INSERT INTO inbox VALUES (?,?)').run(source.sourceMessageId, JSON.stringify(source));
  return { db, source };
}
test('quote preserves exact unsigned 64-bit server ID and resolves only its scoped original', () => {
  const { db } = fixture();
  try {
    assert.deepEqual(quoteReferenceFromInbox({ db, accountId, groupId, messageId: 'message1' }),
      { messageId: 'message1', serverId: '18446744073709551615' });
    assert.throws(() => quoteReferenceFromInbox({ db, accountId, groupId: 'other@chatroom', messageId: 'message1' }), /identity/u);
    assert.throws(() => quoteReferenceFromInbox({ db, accountId: 'other', groupId, messageId: 'message1' }), /account/u);
    assert.throws(() => quoteReferenceFromInbox({ db, accountId, groupId, messageId: 'message1', expectedSenderId: 'other' }), /identity/u);
    for (const serverId of [0, '0', '01', '1e5', '18446744073709551616', null]) {
      assert.throws(() => validateQuoteReference({ messageId: 'message1', serverId }));
    }
    assert.throws(() => validateQuoteReference({ messageId: 'message1', serverId: '2', text: 'fake quote' }));
  } finally { db.close(); }
});
test('quote rejects locally revoked sources and rechecks remote identity/state immediately before sending', async () => {
  const { db, source } = fixture();
  try {
    for (const marker of [{ recall: {} }, { isDeleted: true }, { state: 'revoked' }]) {
      db.prepare('UPDATE inbox SET message=?').run(JSON.stringify({ ...source, ...marker }));
      assert.throws(() => quoteReferenceFromInbox({ db, accountId, groupId, messageId: 'message1' }), /state/u);
    }
    const quote = { messageId: 'message1', serverId: '18446744073709551615' };
    const remote = { id: quote.messageId, serverId: quote.serverId, accountId, threadId: groupId, type: 1 };
    const verify = value => verifyQuoteReference({ accountId, groupId, quote,
      client: { accountId, message: async () => value } });
    assert.deepEqual(await verify(remote), quote);
    for (const changed of [{ recall: {} }, { serverId: '9' }, { accountId: 'other' }, { threadId: 'other@chatroom' }, { type: 10000 }]) {
      await assert.rejects(verify({ ...remote, ...changed }));
    }
  } finally { db.close(); }
});
