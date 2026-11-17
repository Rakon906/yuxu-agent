import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PatSender } from '../packages/wechat-adapter/pat-send.mjs';

const accountId = 'preference-pat-account', groupId = 'preference@chatroom';
const selfUserId = 'wxid_self', targetUserId = 'wxid_target', now = 1794570000000;
function fixture(t, { authorize, duringCapability = () => {}, duringMembers = () => {}, uncertain = false } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE inbox(id TEXT PRIMARY KEY,message TEXT NOT NULL)');
  const sourceId = `pat:${'a'.repeat(64)}`;
  db.prepare('INSERT INTO inbox VALUES (?,?)').run(sourceId, JSON.stringify({
    sourceMessageId: sourceId, accountId, groupId, userId: targetUserId, interaction: 'pat',
    mentions: { self: true }, eventTime: new Date(now).toISOString(),
  }));
  const calls = [];
  const client = { accountId, async request(path, args) {
    calls.push({ path, args });
    if (path === '/pats/capability') { await duringCapability(); return { accountId, nativePat: true }; }
    if (path === '/pats' && uncertain) throw new Error('unknown delivery result');
    return { accountId, groupId, targetUserId, clientId: args?.body?.clientId ?? db.prepare('SELECT key FROM pat_sends').get().key,
      state: 'accepted', baseCode: 0, messageId: '12345' };
  } };
  const sender = new PatSender({ db, client, selfUserId, allowedGroups: [groupId], authorize,
    getMemberIds: async () => { await duringMembers(); return [selfUserId, targetUserId]; } });
  t.after(() => db.close());
  return { sender, db, calls, input: { groupId, targetUserId, sourceId, now },
    posts: () => calls.filter(call => call.path === '/pats') };
}

test('pat opt-out arriving during native capability lookup prevents POST and durable intent', async t => {
  let allowed = true, checked;
  const f = fixture(t, { authorize: input => { checked = input; return allowed; }, duringCapability: async () => { allowed = false; } });
  assert.deepEqual(await f.sender.send(f.input), { state: 'skipped', reason: 'preference_blocked' });
  assert.deepEqual(checked, { groupId, targetUserId, sourceId: f.input.sourceId, kind: 'reply' });
  assert.equal(f.posts().length, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM pat_sends').get().n, 0);
});

test('pat opt-out during member lookup also blocks; unavailable policy fails closed', async t => {
  let allowed = true;
  const f = fixture(t, { authorize: () => allowed, duringMembers: async () => { allowed = false; } });
  assert.equal((await f.sender.send(f.input)).reason, 'preference_blocked');
  assert.equal(f.posts().length, 0);
  f.sender.authorize = async () => { throw new Error('preference DB unavailable'); };
  assert.equal((await f.sender.send(f.input)).reason, 'preference_check_failed');
  assert.equal(f.posts().length, 0);
});

test('a previous uncertain pat is reconciled despite later opt-out and never resent', async t => {
  let allowed = true;
  const f = fixture(t, { authorize: () => allowed, uncertain: true });
  assert.equal((await f.sender.send(f.input)).state, 'needs_review');
  allowed = false;
  assert.equal((await f.sender.send(f.input)).state, 'accepted');
  assert.equal(f.posts().length, 1);
  assert.ok(f.calls.some(call => call.path.startsWith('/pats/by-idempotency-key')));
});
