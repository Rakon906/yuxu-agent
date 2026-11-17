import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { createVoiceTransport, createWindowsVoiceSynthesizer, createVoiceSynthesizer, inspectVoiceWave,
  normalizeSpokenText, reconcileVoiceSend, sendVoiceReply } from '../packages/voice/output.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const accountId = 'account-voice', groupId = 'group@chatroom';
function wave(durationMs = 1000) {
  const dataLength = durationMs * 32, bytes = Buffer.alloc(44 + dataLength);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(dataLength, 40); return bytes;
}
function fixture() {
  const parent = join(root, '.runtime', 'test-tmp'); mkdirSync(parent, { recursive: true });
  const dir = mkdtempSync(join(parent, 'voice-output-')), path = join(dir, 'voice.wav'), bytes = wave();
  writeFileSync(path, bytes);
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT);');
  db.prepare('INSERT INTO meta VALUES (?,?)').run('accountId', accountId);
  return { db, dir, bytes, path, info: inspectVoiceWave(bytes),
    synthesizer: async () => ({ path, ...inspectVoiceWave(bytes) }) };
}
function job(sourceId, overrides = {}) {
  return { id: 'job1', accountId, threadId: groupId, sourceId, kind: 'send', state: 'accepted', phase: 'completed',
    serverMessageId: '18446744073709551615', result: { nativeReceipt: { status: 'server_accepted', serviceCode: 0,
      serverMessageId: '18446744073709551615', clientIdMatches: true } }, ...overrides };
}
function transport(f, overrides = {}) {
  const calls = { uploads: 0, sends: 0, checks: 0 };
  return { calls,
    async upload() { calls.uploads++; return { id: 'source1', sha256: f.info.sha256, byteLength: f.info.bytes }; },
    async submit() { calls.sends++; return job('source1'); },
    async status() { calls.checks++; return job('source1'); },
    async byKey() { calls.checks++; return job('source1'); }, ...overrides };
}
function args(f, output, overrides = {}) {
  return { db: f.db, client: { accountId }, accountId, groupId, taskId: 'task1', sourceId: 'message1',
    text: '咋啦，我在听呢。', synthesizer: f.synthesizer, transport: output, pollAttempts: 0, ...overrides };
}

test('voice WAV validation bounds duration and rejects wrong format and corrupt containers', () => {
  assert.equal(inspectVoiceWave(wave()).durationMs, 1000);
  assert.throws(() => inspectVoiceWave(wave(56000)), /duration/u);
  const stereo = wave(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => inspectVoiceWave(stereo), /mono/u);
  assert.throws(() => inspectVoiceWave(wave().subarray(1)));
  const truncated = wave(); truncated.writeUInt32LE(9999999, 40);
  assert.throws(() => inspectVoiceWave(truncated), /Truncated/u);
  assert.throws(() => normalizeSpokenText('a'.repeat(161)));
  assert.throws(() => normalizeSpokenText(''));
});

test('voice synthesizer passes text as data, validates output, caches it and notices corruption', async () => {
  const f = fixture(); let count = 0;
  try {
    const synth = createWindowsVoiceSynthesizer({ outputDir: f.dir, platform: 'win32', run: async request => {
      count++; assert.equal(request.text, '测试 `$(whoami) 也是文字');
      writeFileSync(request.path, wave()); return { voice: request.voice, engine: 'windows-sapi' };
    } });
    const first = await synth('测试 `$(whoami) 也是文字');
    assert.equal(first.cached, false);
    assert.equal((await synth('测试 `$(whoami) 也是文字')).cached, true);
    assert.equal(count, 1);
    const bytes = readFileSync(first.path); bytes[50] ^= 1; writeFileSync(first.path, bytes);
    await assert.rejects(synth('测试 `$(whoami) 也是文字'), /integrity/u);
    await assert.rejects(createWindowsVoiceSynthesizer({ platform: 'linux' })('你好'), /platform/u);
  } finally { f.db.close(); }
});

test('default voice routes to Xiaoyi and never silently falls back to SAPI', async () => {
  const f = fixture(); let calls = 0;
  try {
    const synth = createVoiceSynthesizer({ provider: 'edge', outputDir: f.dir, run: async request => {
      calls++; assert.equal(request.voice, 'zh-CN-XiaoyiNeural');
      throw new Error('offline');
    } });
    await assert.rejects(synth('测试晓伊'), /offline/);
    assert.equal(calls, 1);
    assert.throws(() => createVoiceSynthesizer({ provider: 'unknown' }), /provider/);
    const legacy = createVoiceSynthesizer({ provider: 'sapi', outputDir: f.dir, platform: 'win32', run: async request => {
      writeFileSync(request.path, wave()); return { voice: request.voice, engine: 'windows-sapi' };
    } });
    assert.equal((await legacy('明确选择系统声音')).engine, 'windows-sapi');
  } finally { f.db.close(); }
});

test('voice reply persists source/hash/job, validates receipt and never sends the same key twice', async () => {
  const f = fixture(), output = transport(f);
  try {
    const sent = await sendVoiceReply(args(f, output));
    assert.equal(sent.state, 'sent'); assert.equal(sent.safeToFallback, false);
    const again = await sendVoiceReply(args(f, output));
    assert.equal(again.state, 'sent'); assert.equal(output.calls.sends, 1); assert.equal(output.calls.uploads, 1);
    const row = f.db.prepare('SELECT * FROM voice_sends').get();
    assert.equal(row.upload_id, 'source1'); assert.equal(row.job_id, 'job1'); assert.equal(row.sha256, f.info.sha256);
    assert.equal(row.duration_ms, 1000);
    await assert.rejects(sendVoiceReply(args(f, output, { text: '偷偷换了内容' })), /conflict/u);
    await assert.rejects(sendVoiceReply(args(f, output, { groupId: 'friend' })), /scope/u);
  } finally { f.db.close(); }
});

test('unknown dispatch is only reconciled and cannot become a duplicate voice or fallback text', async () => {
  const f = fixture(), output = transport(f, {
    async submit() { this.calls.sends++; throw new Error('Timeout'); },
    async byKey() { this.calls.checks++; throw new Error('Unknown'); },
  });
  try {
    const first = await sendVoiceReply(args(f, output));
    assert.equal(first.state, 'needs_review'); assert.equal(first.safeToFallback, false);
    assert.equal((await sendVoiceReply(args(f, output))).state, 'needs_review');
    assert.equal(output.calls.sends, 1); assert.equal(output.calls.uploads, 1);
    output.byKey = async () => job('source1');
    assert.equal((await reconcileVoiceSend({ db: f.db, client: { accountId }, transport: output, key: first.key })).state, 'sent');
    assert.equal(output.calls.sends, 1);
  } finally { f.db.close(); }
});

test('voice failure before submission can fall back; authorization is checked again after generation/upload', async () => {
  const f = fixture(), output = transport(f); let authorizations = 0;
  try {
    const result = await sendVoiceReply(args(f, output, { authorize: async () => ++authorizations < 2 }));
    assert.equal(result.state, 'not_sent'); assert.equal(result.safeToFallback, true);
    assert.equal(output.calls.sends, 0); assert.equal(output.calls.uploads, 1);
    await sendVoiceReply(args(f, output)); assert.equal(output.calls.sends, 0);
  } finally { f.db.close(); }
});

test('wrong-account and ambiguous receipts never count as successful voice messages', async () => {
  for (const overrides of [{ accountId: 'foreign' }, { result: { nativeReceipt: { serviceCode: 0 } } }, { sourceId: 'foreign' }]) {
    const f = fixture(), output = transport(f, {
      submit: async () => job('source1', overrides), byKey: async () => job('source1', overrides),
    });
    try { assert.equal((await sendVoiceReply(args(f, output))).state, 'needs_review'); }
    finally { f.db.close(); }
  }
});

test('concurrent calls cannot hijack an active synthesis or duplicate the send', async () => {
  const f = fixture(), output = transport(f); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  try {
    const first = sendVoiceReply(args(f, output, { synthesizer: async () => { await waiting; return f.synthesizer(); } }));
    const second = await sendVoiceReply(args(f, output));
    assert.equal(second.state, 'pending_receipt'); assert.equal(second.safeToFallback, false);
    release(); assert.equal((await first).state, 'sent'); assert.equal(output.calls.sends, 1);
  } finally { f.db.close(); }
});

test('native voice transport uses scoped multipart upload then kind=voice with an idempotency key', async t => {
  const f = fixture(), requests = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({ method: request.method, path: request.url, headers: request.headers, body });
    response.setHeader('Content-Type', 'application/json');
    if (request.url.endsWith('/uploads')) {
      assert.equal(request.headers.authorization, 'Bearer fixture-token');
      assert.match(request.headers['content-type'], /multipart\/form-data/u);
      assert.ok(body.includes(f.bytes));
      response.end(JSON.stringify({ id: 'source1', sha256: f.info.sha256, byteLength: f.info.bytes }));
    } else {
      assert.equal(request.headers['idempotency-key']?.startsWith('sociomem-voice-'), true);
      assert.deepEqual(JSON.parse(body), { kind: 'voice', threadId: groupId, sourceId: 'source1' });
      response.end(JSON.stringify(job('source1')));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); f.db.close(); });
  const client = new WeChatClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'fixture-token', accountId });
  const result = await sendVoiceReply({ ...args(f, null), client, transport: createVoiceTransport({ client }) });
  assert.equal(result.state, 'sent'); assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.path.startsWith(`/v1/accounts/${accountId}/`)));
  assert.equal(createHash('sha256').update(f.bytes).digest('hex'), result.sha256);
});
