import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { PatSender, patSendKey } from '../packages/wechat-adapter/pat-send.mjs';

const accountId = 'account-one', groupId = '123@chatroom', self = 'wxid_self', target = 'wxid_friend';
const now = 1794570000000;
function harness(options = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE inbox(id TEXT PRIMARY KEY,message TEXT NOT NULL)');
  const calls = [];
  const client = { accountId, async request(path, args) {
    calls.push({ path, args });
    if (path === '/pats/capability') {
      if (options.missing) throw Object.assign(new Error('missing'), { status: 404 });
      return { accountId, nativePat: true };
    }
    if (options.error) throw new Error('socket lost after write');
    return { accountId, groupId, targetUserId: target, clientId: args.body.clientId,
      baseCode: 0, state: 'accepted', messageId: '18446744073709551600', ...options.receipt };
  } };
  const args = { db, client, selfUserId: self, allowedGroups: [groupId],
    getMemberIds: async () => options.members ?? [self, target] };
  const gateway = new PatSender(args);
  function source(n = 'a', overrides = {}) {
    const sourceId = `pat:${n.repeat(64)}`;
    const message = { sourceMessageId: sourceId, accountId, groupId, userId: target,
      interaction: 'pat', mentions: { self: true }, eventTime: new Date(now).toISOString(), ...overrides };
    db.prepare('INSERT OR REPLACE INTO inbox VALUES (?,?)').run(sourceId, JSON.stringify(message));
    return { groupId, targetUserId: target, sourceId, now };
  }
  return { db, gateway, args, source, calls, posts: () => calls.filter(c => c.path === '/pats') };
}

test('native pat reserves one durable intent, binds receipt and never reposts across gateway restart', async () => {
  const h = harness();
  try {
    const input = h.source();
    const first = await h.gateway.send(input);
    assert.equal(first.state, 'accepted');
    assert.equal(first.receipt.messageId, '18446744073709551600');
    assert.equal(h.posts().length, 1);
    assert.equal((await new PatSender(h.args).send(input)).state, 'accepted');
    assert.equal(h.posts().length, 1);
    assert.equal(h.posts()[0].args.key, patSendKey(accountId, groupId, target, input.sourceId));
  } finally { h.db.close(); }
});

test('concurrent identical pats issue only one POST', async () => {
  const h = harness();
  try { const input = h.source(); await Promise.all([h.gateway.send(input), h.gateway.send(input)]); assert.equal(h.posts().length, 1); }
  finally { h.db.close(); }
});

test('unknown outcome and mismatched receipts persist uncertainty and do not resend', async () => {
  for (const options of [{ error: true }, { receipt: { accountId: 'other' } }, { receipt: { targetUserId: 'other' } },
    { receipt: { baseCode: undefined } }, { receipt: { messageId: null } }, { receipt: { state: 'needs_review' } }]) {
    const h = harness(options);
    try {
      const input = h.source(); assert.equal((await h.gateway.send(input)).state, 'needs_review');
      assert.equal((await new PatSender(h.args).send(input)).state, 'needs_review');
      assert.equal(h.posts().length, 1);
    } finally { h.db.close(); }
  }
});

test('old daemon returns unavailable without creating an intent or text fallback', async () => {
  const h = harness({ missing: true });
  try {
    assert.deepEqual(await h.gateway.send(h.source()), { state: 'unavailable', reason: 'native_route_missing' });
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM pat_sends').get().n, 0);
    assert.equal(h.posts().length, 0);
  } finally { h.db.close(); }
});

test('scope, membership, source freshness and verified incoming pat are enforced', async () => {
  const h = harness();
  try {
    const input = h.source();
    await assert.rejects(h.gateway.send({ ...input, groupId: '456@chatroom' }), /unauthorized/u);
    assert.equal((await h.gateway.send({ ...input, targetUserId: self })).reason, 'self_or_bot');
    assert.equal((await h.gateway.send({ ...input, sourceId: 'missing' })).reason, 'source_missing');
    assert.equal((await h.gateway.send({ ...input, now: now + 301000 })).reason, 'source_expired');
    assert.equal((await h.gateway.send(h.source('b', { accountId: 'other' }))).reason, 'source_scope_mismatch');
    assert.equal((await h.gateway.send(h.source('c', { interaction: null, text: '我拍了拍肥鱼' }))).reason, 'unverified_pat_event');
    assert.equal((await h.gateway.send({ ...h.source('d'), kind: 'proactive' })).reason, 'pat_cannot_trigger_proactive');
    assert.equal((await h.gateway.send(h.source('e', { recalled: true }))).reason, 'source_recalled');
    assert.equal((await h.gateway.send({ ...h.source('f', { interaction: 'forwarded' }), kind: 'proactive' })).reason, 'not_direct_text');
    assert.equal(h.posts().length, 0);
  } finally { h.db.close(); }
  const noMember = harness({ members: [self] });
  try { assert.equal((await noMember.gateway.send(noMember.source())).reason, 'not_current_member'); assert.equal(noMember.posts().length, 0); }
  finally { noMember.db.close(); }
});

test('pat-back does not escalate into a bot loop; same-target cooldown survives new source IDs', async () => {
  const h = harness();
  try {
    await h.gateway.send(h.source());
    assert.equal((await h.gateway.send(h.source('b'))).reason, 'target_cooldown');
    assert.equal(h.posts().length, 1);
  } finally { h.db.close(); }
});

test('a proactive pat is permitted only for a recent real utterance by a current member', async () => {
  const h = harness();
  try {
    const input = h.source('a', { interaction: null, text: '来了' });
    assert.equal((await h.gateway.send({ ...input, kind: 'proactive' })).state, 'accepted');
  } finally { h.db.close(); }
});

test('negative server status is explicit failure, still not automatically resubmitted', async () => {
  const h = harness({ receipt: { baseCode: -1 } });
  try { const input = h.source(); assert.equal((await h.gateway.send(input)).state, 'failed'); await h.gateway.send(input);
    assert.equal((await h.gateway.send(h.source('b'))).reason, 'target_cooldown'); assert.equal(h.posts().length, 1); }
  finally { h.db.close(); }
});

test('canonical capture inbox and send ledger can be separate databases', async () => {
  const h = harness();
  const ledger = new DatabaseSync(':memory:');
  try {
    const input = h.source();
    const split = new PatSender({ ...h.args, db: ledger, sourceDb: h.db });
    assert.equal((await split.send(input)).state, 'accepted');
    assert.equal(ledger.prepare('SELECT COUNT(*) AS n FROM pat_sends').get().n, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS n FROM pat_sends').get().n, 0);
    assert.equal(ledger.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='inbox'").get().n, 0);
  } finally { h.db.close(); ledger.close(); }
});

test('lost POST receipt converges using only a scope-checked read of native operations', async () => {
  const h = harness({ error: true });
  try {
    const input = h.source();
    const uncertain = await h.gateway.send(input);
    assert.equal(uncertain.state, 'needs_review');
    const lookups = [];
    h.args.client.request = async (path, args) => {
      lookups.push(path); assert.equal(args?.method, undefined);
      assert.match(path, /^\/pats\/by-idempotency-key\?key=/u);
      return { accountId, groupId, targetUserId: target, clientId: uncertain.key,
        state: 'accepted', baseCode: 0, messageId: '12345678901234567890' };
    };
    const rows = await new PatSender(h.args).reconcilePending();
    assert.equal(rows[0].state, 'accepted');
    assert.equal(lookups.length, 1);
    assert.equal(h.posts().length, 1);
    assert.equal((await h.gateway.reconcilePending()).length, 0);
  } finally { h.db.close(); }
});
