import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
export const defaultVoiceModelDir = join(projectRoot, '.cache', 'voice-models', 'sensevoice');
export const defaultVoiceDir = join(projectRoot, '.runtime', 'voice');
export const VOICE_MODEL_NAME = 'sensevoice-small-int8';
export const VOICE_MODEL_ASSETS = {
  model: {
    name: 'model.int8.onnx', bytes: 239233841,
    sha256: 'c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/model.int8.onnx',
  },
  tokens: {
    name: 'tokens.txt', bytes: 315894,
    sha256: 'f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc',
    url: 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/tokens.txt',
  },
};
const maxTranscript = 1000;
const require = createRequire(import.meta.url);

function cleanTag(value) {
  return typeof value === 'string' ? value.replace(/^<\|(.*)\|>$/u, '$1').trim() : null;
}

export function cleanTranscript(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<\|[^|>]*\|>/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, maxTranscript);
}

export function voiceModelDir() {
  return process.env.SOCIOMEM_VOICE_MODEL_DIR ?? defaultVoiceModelDir;
}

export function voiceModelReady(dir = voiceModelDir()) {
  return Object.values(VOICE_MODEL_ASSETS).every(asset => existsSync(join(dir, asset.name)));
}

function sha256File(filename) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(filename).on('data', chunk => hash.update(chunk))
      .on('error', reject).on('end', () => resolve(hash.digest('hex')));
  });
}

export function createSenseVoiceTranscriber({ modelDir = voiceModelDir(), threads = 4,
  language = process.env.SOCIOMEM_VOICE_LANGUAGE ?? 'zh',
  recognizerFactory = null, readWave: readWaveImpl = null } = {}) {
  let recognizer = null;
  let readWave = readWaveImpl;
  const ensure = () => {
    if (recognizer) return recognizer;
    if (recognizerFactory) {
      recognizer = recognizerFactory();
      return recognizer;
    }
    if (!voiceModelReady(modelDir)) {
      throw new Error('SenseVoice model is not installed; run node scripts/voice-install.mjs');
    }
    const sherpa = require('sherpa-onnx-node');
    readWave ??= sherpa.readWave;
    recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        senseVoice: { model: join(modelDir, 'model.int8.onnx'), language,
          useInverseTextNormalization: 1 },
        tokens: join(modelDir, 'tokens.txt'),
        numThreads: threads, provider: 'cpu', debug: 0,
      },
    });
    return recognizer;
  };
  return async wavPath => {
    const active = ensure();
    if (!readWave) throw new Error('WAV reader is unavailable');
    const wave = readWave(wavPath);
    const stream = active.createStream();
    stream.acceptWaveform({ sampleRate: wave.sampleRate, samples: wave.samples });
    active.decode(stream);
    const result = active.getResult(stream);
    return { text: cleanTranscript(result?.text), lang: cleanTag(result?.lang),
      emotion: cleanTag(result?.emotion), event: cleanTag(result?.event),
      durationMs: Math.round((wave.samples.length / wave.sampleRate) * 1000),
      model: VOICE_MODEL_NAME };
  };
}

async function voiceAssets(client, message, signal) {
  const inline = Array.isArray(message.media) ? message.media.filter(item => item?.kind === 'voice') : [];
  if (inline.some(item => item.state === 'available')) return inline;
  const response = await client.messageMedia(message.sourceMessageId ?? message.id, signal);
  const remote = Array.isArray(response?.items)
    ? response.items.filter(item => item?.kind === 'voice') : [];
  return [...inline, ...remote];
}

function availableVoice(assets) {
  return assets.find(item => item.state === 'available' && item.id &&
    (typeof item.contentType === 'string' ? item.contentType.toLowerCase().startsWith('audio/') : true));
}

async function waitForVoiceAsset(client, message, signal, { attempts, delayMs }) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const asset = availableVoice(await voiceAssets(client, message, signal));
    if (asset) return asset;
    if (attempt + 1 < attempts) await delay(delayMs, undefined, { signal });
  }
  throw new Error('Voice asset is not available');
}

export function createVoiceEnricher({ client, transcriber, voiceDir = defaultVoiceDir,
  maxAudioBytes = 16 * 1024 * 1024, waitAttempts = 12, waitDelayMs = 500 } = {}) {
  if (!client || typeof transcriber !== 'function') throw new Error('Voice enricher requires a client and transcriber');
  return async (message, signal) => {
    const asset = await waitForVoiceAsset(client, message, signal,
      { attempts: waitAttempts, delayMs: waitDelayMs });
    const { bytes, contentType } = await client.mediaContent(asset.id, signal);
    if (bytes.length > maxAudioBytes) throw new Error('Voice audio is too large');
    if (typeof contentType === 'string' && !contentType.toLowerCase().startsWith('audio/')) {
      throw new Error('Unsupported voice content type');
    }
    mkdirSync(voiceDir, { recursive: true });
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const filename = join(voiceDir, `${sha256}.wav`);
    if (!existsSync(filename)) writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
    const transcript = await transcriber(filename);
    if (!transcript.text) throw new Error('Voice transcript is empty');
    return { ...message, text: transcript.text, interaction: 'voice', voiceState: 'done',
      voiceModel: transcript.model, voiceDurationMs: transcript.durationMs,
      voiceLang: transcript.lang, voiceEmotion: transcript.emotion,
      voiceAssetId: asset.id, voiceSha256: sha256,
      voiceContentType: contentType ?? asset.contentType ?? null, media: [] };
  };
}

async function downloadAsset(asset, target, { origins, fetchImpl, log }) {
  const part = `${target}.part`;
  for (const origin of origins) {
    const url = new URL(asset.url);
    const source = `${origin.replace(/\/$/u, '')}${url.pathname}`;
    let start = existsSync(part) ? statSync(part).size : 0;
    if (start > asset.bytes) { start = 0; writeFileSync(part, Buffer.alloc(0)); }
    try {
      const response = await fetchImpl(source, { redirect: 'follow',
        headers: start > 0 ? { Range: `bytes=${start}-` } : {},
        signal: AbortSignal.timeout(600000) });
      if (![200, 206].includes(response.status)) throw new Error(`HTTP ${response.status}`);
      if (start > 0 && response.status === 200) { start = 0; writeFileSync(part, Buffer.alloc(0)); }
      await pipeline(Readable.fromWeb(response.body),
        createWriteStream(part, { flags: start > 0 ? 'a' : 'w', mode: 0o600 }));
      const size = statSync(part).size;
      if (size !== asset.bytes) throw new Error(`size mismatch ${size}/${asset.bytes}`);
      const digest = await sha256File(part);
      if (digest !== asset.sha256) throw new Error('sha256 mismatch');
      renameSync(part, target);
      log(`${asset.name} ready from ${origin}`);
      return;
    } catch (error) {
      log(`${asset.name} from ${origin} failed: ${error.message}`);
    }
  }
  throw new Error(`${asset.name} download failed from every origin`);
}

export async function installVoiceModel({ dir = voiceModelDir(),
  origins = ['https://huggingface.co', 'https://hf-mirror.com'],
  fetchImpl = fetch, log = () => {} } = {}) {
  mkdirSync(dir, { recursive: true });
  for (const asset of Object.values(VOICE_MODEL_ASSETS)) {
    const target = join(dir, asset.name);
    if (existsSync(target) && await sha256File(target) === asset.sha256) {
      log(`${asset.name} already verified`);
      continue;
    }
    await downloadAsset(asset, target, { origins, fetchImpl, log });
  }
  return dir;
}
