import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { inspectVoiceWave } from '../packages/voice/output.mjs';
import { sendParticipationVoice, reconcileVoiceReplies } from '../packages/voice/participation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), accountId = 'voice-account', groupId = 'voice@chatroom';
const now = Date.parse('2026-11-13T12:00:00+08:00');
function fixture() {
  const base = join(root, '.runtime', 'test-tmp'); mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'voice-participation-'));
  const store = new AdapterStore(join(dir, 'ledger.sqlite'), accountId), ledger = new ParticipationLedger(store);
  const calls = { text: 0, submit: 0, checks: 0 };
  const client = { accountId, send: async () => { calls.text++; throw new Error('Text must never be sent'); } };
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId: 'self', sendingEnabled: true, cooldownMs: 10000 });
  const target = { id: 'message1', senderId: 'friend', text: '肥鱼，用语音回我', groupId, rowid: 1, at: new Date(now).toISOString() };
  ledger.seed(groupId, 0); ledger.observe(target, 'mention', now);
  const bytes = Buffer.alloc(32044); bytes.write('RIFF'); bytes.writeUInt32LE(32036, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(32000, 40);
  const path = join(dir, 'audio.wav'); writeFileSync(path, bytes); const info = inspectVoiceWave(bytes);
  const accepted = { id: 'job1', kind: 'send', accountId, threadId: groupId, sourceId: 'source1', phase: 'completed', state: 'accepted',
    serverMessageId: '9007199254740993', result: { nativeReceipt: { status: 'server_accepted', serviceCode: 0,
      serverMessageId: '9007199254740993', clientIdMatches: true } } };
  const transport = { upload: async () => ({ id: 'source1', sha256: info.sha256, byteLength: info.bytes }),
    submit: async () => { calls.submit++; return accepted; },
    byKey: async () => { calls.checks++; return accepted; },
    status: async () => { calls.checks++; return accepted; } };
  return { store, ledger, adapter, client, target, task: ledger.task(target.id), groupId,
    text: '咋啦，我在听呢。', key: 'participation1', now, calls, transport, accepted,
    synthesizer: async () => ({ path, ...info }), pollAttempts: 0 };
}

test('confirmed voice participates in conversation history/cooldown without submitting fallback text', async () => {
  const f = fixture();
  try {
    const sent = await sendParticipationVoice(f);
    assert.equal(sent.status, 'sent'); assert.equal(f.calls.text, 0); assert.equal(f.calls.submit, 1);
    assert.equal(f.ledger.task(f.target.id).state, 'sent');
    const outbox = f.store.sendRecord(f.key);
    assert.equal(outbox.state, 'accepted'); assert.equal(outbox.attempted_at, now);
    assert.equal(JSON.parse(outbox.receipt).channel, 'voice');
    assert.deepEqual(f.ledger.recentAgentReplies(groupId, now), [f.text]);
    assert.equal(f.ledger.recentAgentMessages(groupId, now)[0].text, f.text);
    f.store.draft('other', groupId, '不应该立刻再发'); f.store.approve('other');
    assert.throws(() => f.store.claim('other', 10000, now + 1000), /rate/u);
    assert.equal((await sendParticipationVoice({ ...f, text: '重启后模型换了个说法' })).status, 'sent');
    assert.equal(f.calls.submit, 1); assert.equal(f.store.sendRecord(f.key).text, f.text);
  } finally { f.store.close(); }
});

test('unknown voice is terminal for text task loop and can be reconciled after restart without another POST', async () => {
  const f = fixture();
  f.transport.submit = async () => { f.calls.submit++; throw new Error('lost response'); };
  f.transport.byKey = async () => { f.calls.checks++; throw new Error('not yet available'); };
  try {
    const sent = await sendParticipationVoice(f);
    assert.equal(sent.status, 'needs_review'); assert.equal(sent.safeToFallback, false);
    assert.equal(f.ledger.task(f.target.id).state, 'needs_review'); assert.equal(f.ledger.receiptTask(groupId), null);
    assert.equal(f.store.sendRecord(f.key).state, 'needs_review');
    assert.equal(f.ledger.recentAgentReplies(groupId, now).length, 0);
    f.transport.byKey = async () => { f.calls.checks++; return f.accepted; };
    const [settled] = await reconcileVoiceReplies({ ...f, now: now + 60000 });
    assert.equal(settled.status, 'sent'); assert.equal(f.store.sendRecord(f.key).state, 'accepted');
    assert.equal(f.ledger.task(f.target.id).state, 'sent');
    assert.equal(f.ledger.db.prepare('SELECT state FROM participation_messages WHERE source_id=?').get(f.target.id).state, 'sent');
    assert.equal(f.calls.submit, 1); assert.equal(f.calls.text, 0);
    assert.deepEqual(await reconcileVoiceReplies(f), []);
  } finally { f.store.close(); }
});

test('pre-send voice failure leaves no outbox and permits ordinary text fallback; existing cooldown is obeyed', async () => {
  for (const mode of ['tts', 'cooldown', 'disabled']) {
    const f = fixture();
    try {
      if (mode === 'tts') f.synthesizer = async () => { throw new Error('unavailable'); };
      if (mode === 'disabled') f.adapter.sendingEnabled = false;
      if (mode === 'cooldown') {
        f.store.draft('prior', groupId, '刚说过'); f.store.approve('prior'); f.store.claim('prior', 0, now - 1000);
        f.store.receipt('prior', 'accepted', {});
      }
      const failed = await sendParticipationVoice(f);
      assert.equal(failed.safeToFallback, true); assert.equal(failed.status, 'fallback');
      assert.equal(f.store.sendRecord(f.key), undefined); assert.equal(f.ledger.task(f.target.id).state, 'pending');
      assert.equal(f.calls.submit, 0); assert.equal(f.calls.text, 0);
    } finally { f.store.close(); }
  }
});

test('voice cannot adopt another source sender, private thread, or an existing text draft', async () => {
  const f = fixture();
  try {
    await assert.rejects(sendParticipationVoice({ ...f, target: { ...f.target, senderId: 'other' } }), /task/u);
    await assert.rejects(sendParticipationVoice({ ...f, groupId: 'private-friend' }), /scope/u);
    f.store.draft(f.key, groupId, f.text);
    await assert.rejects(sendParticipationVoice(f), /another outbound/u);
    assert.equal(f.calls.submit, 0); assert.equal(f.calls.text, 0);
  } finally { f.store.close(); }
});
