import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { classifyParticipation } from '../packages/participation/index.mjs';
import { cleanTranscript, createSenseVoiceTranscriber, createVoiceEnricher } from '../packages/voice/index.mjs';
import { startWeChatFixture, ACCOUNT, GROUP, SELF, TOKEN, message, event } from './fixtures/wechat-server.mjs';

const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]);
const sha256 = createHash('sha256').update(wav).digest('hex');

test('SenseVoice transcriber normalizes transcript tags and reports duration', async () => {
  let accepted;
  const transcriber = createSenseVoiceTranscriber({
    recognizerFactory: () => ({
      createStream: () => ({ acceptWaveform: value => { accepted = value; } }),
      decode: () => {},
      getResult: () => ({ text: '<|zh|>你好 世界', lang: '<|zh|>',
        emotion: '<|NEUTRAL|>', event: '<|Speech|>' }),
    }),
    readWave: () => ({ sampleRate: 16000, samples: new Float32Array(16000) }),
  });
  const output = await transcriber('test.wav');
  assert.deepEqual(output, { text: '你好 世界', lang: 'zh', emotion: 'NEUTRAL', event: 'Speech',
    durationMs: 1000, model: 'sensevoice-small-int8' });
  assert.equal(accepted.sampleRate, 16000);
  assert.equal(accepted.samples.length, 16000);
  assert.equal(cleanTranscript('<|zh|> 你\u0000好  '), '你 好');
});

test('voice enricher downloads the available voice asset and replaces the placeholder', async () => {
  const voiceDir = await mkdtemp(join(tmpdir(), 'sociomem-voice-'));
  try {
    let requested;
    const enricher = createVoiceEnricher({ voiceDir, transcriber: async file => {
      requested = file;
      return { text: '在吗', model: 'fixture', durationMs: 1200, lang: 'zh', emotion: 'NEUTRAL' };
    }, client: {
      messageMedia: async () => ({ items: [] }),
      mediaContent: async id => {
        assert.equal(id, 'asset_voice');
        return { bytes: wav, contentType: 'audio/wav' };
      },
    } });
    const enriched = await enricher({ sourceMessageId: 'v1', media: [
      { id: 'asset_voice', kind: 'voice', state: 'available', contentType: 'audio/wav' },
    ] });
    assert.equal(enriched.text, '在吗');
    assert.equal(enriched.interaction, 'voice');
    assert.equal(enriched.voiceState, 'done');
    assert.equal(enriched.voiceAssetId, 'asset_voice');
    assert.equal(enriched.voiceSha256, sha256);
    assert.deepEqual(enriched.media, []);
    assert.equal(requested, join(voiceDir, `${sha256}.wav`));
    assert.deepEqual(await readFile(requested), wav);
  } finally {
    await rm(voiceDir, { recursive: true, force: true });
  }
});

test('voice enricher waits for a media asset that becomes available', async () => {
  const voiceDir = await mkdtemp(join(tmpdir(), 'sociomem-voice-wait-'));
  try {
    let calls = 0;
    const enricher = createVoiceEnricher({ voiceDir, waitAttempts: 4, waitDelayMs: 1,
      transcriber: async () => ({ text: '测试测试。', model: 'fixture', durationMs: 1000 }),
      client: { messageMedia: async () => {
        calls++;
        return { items: calls < 3
          ? [{ id: 'asset_voice', kind: 'voice', state: 'pending' }]
          : [{ id: 'asset_voice', kind: 'voice', state: 'available', contentType: 'audio/wav' }] };
      }, mediaContent: async () => ({ bytes: wav, contentType: 'audio/wav' }) } });
    const enriched = await enricher({ sourceMessageId: 'v1', media: [] });
    assert.equal(enriched.text, '测试测试。');
    assert.equal(calls, 3);
  } finally {
    await rm(voiceDir, { recursive: true, force: true });
  }
});

test('voice enricher rejects a voice asset that is not available', async () => {
  const enricher = createVoiceEnricher({ voiceDir: tmpdir(), waitAttempts: 1, waitDelayMs: 1,
    transcriber: async () => ({ text: 'x' }),
    client: { messageMedia: async () => ({ items: [
      { id: 'asset_pending', kind: 'voice', state: 'pending' },
    ] }), mediaContent: async () => { throw new Error('must not download'); } } });
  await assert.rejects(enricher({ sourceMessageId: 'v1', media: [] }), /not available/u);
});

test('adapter commits a voice transcript as a text-like message', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sociomem-voice-adapter-'));
  const server = await startWeChatFixture();
  const store = new AdapterStore(join(root, 'adapter.sqlite'), ACCOUNT);
  const client = new WeChatClient({ baseUrl: server.origin, accountId: ACCOUNT, token: TOKEN, timeoutMs: 1000 });
  t.after(async () => { store.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [GROUP], selfUserId: SELF,
    enrichVoice: async msg => ({ ...msg, text: '那咋办，你们打呗。', interaction: 'voice',
      voiceState: 'done', voiceModel: 'fixture' }) });
  server.state.messages.set('voice-1', message('voice-1', { type: 34, body: null, media: [] }));
  assert.equal(await adapter.ingest(event(1, 'voice-1')), true);
  const captured = store.pending()[0].message;
  assert.equal(captured.text, '那咋办，你们打呗。');
  assert.equal(captured.interaction, 'voice');
  assert.equal(captured.voiceState, 'done');
  assert.equal(classifyParticipation({ ...captured, mentions: { self: false } }), 'ordinary');
});

test('a failed voice transcription still commits an explicit placeholder', async t => {
  const root = await mkdtemp(join(tmpdir(), 'sociomem-voice-failed-'));
  const server = await startWeChatFixture();
  const store = new AdapterStore(join(root, 'adapter.sqlite'), ACCOUNT);
  const client = new WeChatClient({ baseUrl: server.origin, accountId: ACCOUNT, token: TOKEN, timeoutMs: 1000 });
  t.after(async () => { store.close(); await server.close(); await rm(root, { recursive: true, force: true }); });
  const adapter = new WeChatAdapter({ client, store, allowedGroups: [GROUP], selfUserId: SELF,
    enrichVoice: async () => { throw new Error('model unavailable'); } });
  server.state.messages.set('voice-2', message('voice-2', { type: 34, body: null, media: [] }));
  await adapter.ingest(event(1, 'voice-2'));
  const captured = store.pending()[0].message;
  assert.equal(captured.text, '[群友发送语音；暂时无法识别]');
  assert.equal(captured.voiceState, 'failed');
  assert.equal(captured.voiceError, 'Error');
  assert.equal(classifyParticipation({ ...captured, mentions: { self: false } }), 'ordinary');
});

test('failed voice rows can be found and updated for retry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sociomem-voice-store-'));
  const store = new AdapterStore(join(root, 'adapter.sqlite'), ACCOUNT);
  try {
    store.commitEvent('1', { sourceMessageId: 'voice-1', interaction: 'voice',
      voiceState: 'failed', text: '[群友发送语音；暂时无法识别]' }, 'voice_unavailable');
    const failures = store.inboxVoiceFailures();
    assert.equal(failures.length, 1);
    assert.equal(failures[0].id, 'voice-1');
    store.updateInbox('voice-1', { ...failures[0].message, voiceState: 'done', text: '测试测试。' });
    assert.equal(store.inboxVoiceFailures().length, 0);
    assert.equal(store.pending()[0].message.text, '测试测试。');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
