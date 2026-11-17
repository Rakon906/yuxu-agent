import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MAX_BYTES = 2 * 1024 * 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f]/u.test(value);
const terminal = new Set(['sent', 'failed', 'cancelled', 'not_sent']);
export const DEFAULT_OUTPUT_VOICE = 'Microsoft Huihui Desktop';
export const DEFAULT_VOICE_PROVIDER = 'edge';

/** The selected online voice is explicit; a service failure must not silently change the speaker. */
export function createVoiceSynthesizer({ provider = process.env.SOCIOMEM_TTS_PROVIDER ?? DEFAULT_VOICE_PROVIDER,
  ...options } = {}) {
  if (provider === 'sapi' || provider === 'windows-sapi') return createWindowsVoiceSynthesizer(options);
  if (provider !== 'edge') throw new Error('Unknown voice synthesis provider');
  let synth;
  return async (input, requestOptions = {}) => {
    synth ??= (await import('./edge-output.mjs')).createEdgeVoiceSynthesizer({
      voice: process.env.SOCIOMEM_TTS_VOICE ?? 'zh-CN-XiaoyiNeural',
      rate: process.env.SOCIOMEM_TTS_RATE ?? '-5%',
      pythonPath: process.env.SOCIOMEM_TTS_PYTHON,
      ...options,
    });
    return synth(input, requestOptions);
  };
}

export function normalizeSpokenText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 160 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new Error('Voice reply must contain 1 to 160 text characters');
  }
  return text.trim();
}

export function inspectVoiceWave(input, { maxDurationMs = 55000 } = {}) {
  const bytes = Buffer.from(input);
  if (!Number.isFinite(maxDurationMs) || maxDurationMs <= 0 || maxDurationMs > 60000 ||
      bytes.length < 44 || bytes.length > MAX_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) {
    throw new Error('Invalid voice WAV container');
  }
  let offset = 12, format = false, dataBytes = null, count = 0;
  while (offset < bytes.length) {
    if (++count > 64 || offset + 8 > bytes.length) throw new Error('Invalid voice WAV chunk');
    const type = bytes.toString('ascii', offset, offset + 4), length = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (offset + length > bytes.length) throw new Error('Truncated voice WAV chunk');
    if (type === 'fmt ') {
      if (format || ![16, 18].includes(length) || bytes.readUInt16LE(offset) !== 1 ||
          bytes.readUInt16LE(offset + 2) !== 1 || bytes.readUInt32LE(offset + 4) !== 16000 ||
          bytes.readUInt32LE(offset + 8) !== 32000 || bytes.readUInt16LE(offset + 12) !== 2 ||
          bytes.readUInt16LE(offset + 14) !== 16 || (length === 18 && bytes.readUInt16LE(offset + 16) !== 0)) {
        throw new Error('Voice WAV must be PCM16 mono at 16000 Hz');
      }
      format = true;
    } else if (type === 'data') {
      if (dataBytes !== null || !length || length % 2) throw new Error('Invalid voice WAV data');
      dataBytes = length;
    }
    offset += length + (length % 2);
  }
  if (offset !== bytes.length || !format || dataBytes === null) throw new Error('Incomplete voice WAV');
  const durationMs = Math.round(dataBytes / 32);
  if (durationMs < 200 || durationMs > maxDurationMs) throw new Error('Voice duration exceeds one short note');
  return { sha256: hash(bytes), bytes: bytes.length, durationMs, sampleRate: 16000, channels: 1, bitsPerSample: 16 };
}

const SAPI_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $voice = $speaker.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Name -ceq $request.voice -and $_.VoiceInfo.Culture.Name -eq 'zh-CN' } | Select-Object -First 1
  if (-not $voice) { throw 'Requested Chinese voice is unavailable' }
  $speaker.SelectVoice($voice.VoiceInfo.Name)
  $speaker.Rate = [int]$request.rate
  $speaker.Volume = 100
  $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $speaker.SetOutputToWaveFile([string]$request.path, $format)
  $speaker.Speak([string]$request.text)
  $speaker.SetOutputToNull()
  @{ voice=$voice.VoiceInfo.Name; engine='windows-sapi' } | ConvertTo-Json -Compress
} finally { $speaker.Dispose() }
`;

function sapiRun(request, { signal, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(SAPI_SCRIPT, 'utf16le').toString('base64')],
    { windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', done = false;
    const finish = (error, result) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { child.kill(); finish(new Error('Voice synthesis aborted')); };
    const timer = setTimeout(() => { child.kill(); finish(new Error('Voice synthesis timed out')); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); if (stdout.length > 4096) abort(); });
    // Never echo the request or engine stderr; either may contain the spoken message.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Windows speech process unavailable')));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Windows speech synthesis failed'));
      try { finish(null, JSON.parse(stdout.trim().replace(/^\uFEFF/u, ''))); }
      catch { finish(new Error('Invalid speech synthesis response')); }
    });
    child.stdin.on('error', () => finish(new Error('Voice synthesis input failed')));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.end(JSON.stringify(request), 'utf8');
  });
}

export function createWindowsVoiceSynthesizer({ outputDir = join(root, '.runtime', 'voice-output'),
  voice = process.env.SOCIOMEM_TTS_VOICE ?? DEFAULT_OUTPUT_VOICE, rate = 0,
  platform = process.platform, run = sapiRun } = {}) {
  if (!identity(voice) || !Number.isInteger(rate) || rate < -3 || rate > 3 || typeof run !== 'function') {
    throw new Error('Invalid voice synthesis configuration');
  }
  return async (input, { signal } = {}) => {
    if (platform !== 'win32') throw new Error('Windows speech is unavailable on this platform');
    const text = normalizeSpokenText(input);
    mkdirSync(outputDir, { recursive: true });
    const fingerprint = hash(JSON.stringify(['sapi-pcm16k-v1', voice, rate, text]));
    const path = join(outputDir, `${fingerprint}.wav`), metadataPath = `${path}.json`;
    if (existsSync(path) && existsSync(metadataPath)) {
      const info = inspectVoiceWave(readFileSync(path));
      const saved = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (saved.fingerprint !== fingerprint || saved.sha256 !== info.sha256 || saved.voice !== voice) {
        throw new Error('Cached voice integrity mismatch');
      }
      return { ...info, path, voice, engine: 'windows-sapi', cached: true };
    }
    const temp = join(outputDir, `${fingerprint}-${randomUUID()}.wav`);
    const result = await run({ text, path: temp, voice, rate }, { signal });
    if (result?.voice !== voice || result?.engine !== 'windows-sapi') throw new Error('Voice engine identity mismatch');
    const info = inspectVoiceWave(readFileSync(temp));
    renameSync(temp, path);
    writeFileSync(metadataPath, JSON.stringify({ ...info, fingerprint, voice, engine: 'windows-sapi' }), { mode: 0o600 });
    return { ...info, path, voice, engine: 'windows-sapi', cached: false };
  };
}

export function createVoiceTransport({ client, fetchImpl = fetch }) {
  if (!client || !identity(client.accountId) || typeof client.request !== 'function') throw new Error('Voice client unavailable');
  return {
    async upload(bytes, signal) {
      const info = inspectVoiceWave(bytes), form = new FormData();
      form.append('file', new Blob([bytes], { type: 'audio/wav' }), `${info.sha256}.wav`);
      const response = await fetchImpl(`${client.origin}/v1/accounts/${encodeURIComponent(client.accountId)}/uploads`, {
        method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${client.token}`, Accept: 'application/json' },
        body: form, signal: AbortSignal.any([AbortSignal.timeout(20000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok) throw new Error('Voice upload failed');
      const raw = await response.text();
      if (Buffer.byteLength(raw) > 16384) throw new Error('Voice upload response too large');
      const source = JSON.parse(raw);
      if (!identity(source.id) || source.sha256 !== info.sha256 || source.byteLength !== info.bytes) {
        throw new Error('Voice upload content mismatch');
      }
      return source;
    },
    submit: (groupId, sourceId, key, signal) => client.request('/sends', {
      method: 'POST', body: { kind: 'voice', threadId: groupId, sourceId }, key, signal }),
    status: (jobId, signal) => client.request(`/jobs/${encodeURIComponent(jobId)}`, { signal }),
    byKey: (key, signal) => client.sendByKey(key, signal),
  };
}

export function ensureVoiceSendTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS voice_sends (
    key TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL, task_id TEXT NOT NULL,
    source_message_id TEXT NOT NULL, text_hash TEXT NOT NULL, state TEXT NOT NULL,
    path TEXT, sha256 TEXT, duration_ms INTEGER, upload_id TEXT, job_id TEXT, receipt TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
}
export function voiceSendKey(accountId, groupId, taskId, sourceId) {
  if (![accountId, groupId, taskId, sourceId].every(identity)) throw new Error('Invalid voice send identity');
  return `sociomem-voice-${hash(JSON.stringify([accountId, groupId, taskId, sourceId])).slice(0, 40)}`;
}
function rowResult(row) {
  return { key: row.key, state: row.state, path: row.path, sha256: row.sha256, durationMs: row.duration_ms,
    jobId: row.job_id, receipt: row.receipt ? JSON.parse(row.receipt) : null,
    safeToFallback: row.state === 'not_sent' || row.state === 'failed' || row.state === 'cancelled' };
}
function acceptJob(job, row) {
  if (!job || !identity(job.id) || job.accountId !== row.account_id || job.threadId !== row.group_id ||
      job.sourceId !== row.upload_id || job.kind !== 'send' || (row.job_id && job.id !== row.job_id)) {
    throw new Error('Voice receipt identity mismatch');
  }
  const receipt = job.result?.nativeReceipt;
  if (job.phase === 'completed' && job.state === 'accepted' && receipt?.status === 'server_accepted' &&
      receipt.serviceCode === 0 && typeof receipt.serverMessageId === 'string' && /^[1-9]\d*$/u.test(receipt.serverMessageId) &&
      job.serverMessageId === receipt.serverMessageId && receipt.clientIdMatches === true) {
    return 'sent';
  }
  if (job.phase === 'completed' && job.state === 'failed' && receipt?.status === 'rejected') return 'failed';
  if (job.state === 'cancelled' && !receipt) return 'cancelled';
  if (['queued', 'running', 'preparing', 'submitting'].includes(job.state) && job.phase !== 'completed') return 'pending_receipt';
  return 'needs_review';
}
function saveJob(db, row, job, now) {
  const state = acceptJob(job, row);
  db.prepare('UPDATE voice_sends SET state=?,job_id=?,receipt=?,updated_at=? WHERE key=?')
    .run(state, job.id, JSON.stringify(job), now, row.key);
  return db.prepare('SELECT * FROM voice_sends WHERE key=?').get(row.key);
}

export async function reconcileVoiceSend({ db, client, transport = createVoiceTransport({ client }), key,
  signal, now = Date.now(), pollAttempts = 0, pollMs = 500 }) {
  ensureVoiceSendTable(db);
  let row = db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key);
  if (!row || row.account_id !== client?.accountId) throw new Error('Unknown or foreign voice attempt');
  if (terminal.has(row.state)) return rowResult(row);
  if (!row.upload_id || !['dispatching', 'pending_receipt', 'needs_review'].includes(row.state)) {
    // An interrupted pre-send stage has no message submission to replay.
    db.prepare("UPDATE voice_sends SET state='not_sent',updated_at=? WHERE key=?").run(now, key);
    return rowResult(db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key));
  }
  try {
    for (let i = 0; i <= pollAttempts; i++) {
      const job = row.job_id ? await transport.status(row.job_id, signal) : await transport.byKey(key, signal);
      row = saveJob(db, row, job, now);
      if (row.state !== 'pending_receipt' || i === pollAttempts) break;
      await delay(pollMs, undefined, { signal });
    }
  } catch {
    db.prepare("UPDATE voice_sends SET state='needs_review',updated_at=? WHERE key=?").run(now, key);
    row = db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key);
  }
  return rowResult(row);
}

export async function sendVoiceReply({ db, client, accountId = client?.accountId, groupId, taskId, sourceId,
  text, key = voiceSendKey(accountId, groupId, taskId, sourceId), synthesizer = createVoiceSynthesizer(),
  transport = createVoiceTransport({ client }), authorize = async () => true, signal,
  now = Date.now(), pollAttempts = 12, pollMs = 500 }) {
  text = normalizeSpokenText(text);
  if (!db || ![accountId, groupId, taskId, sourceId, key].every(identity) || !groupId.endsWith('@chatroom') ||
      accountId !== client?.accountId || !Number.isInteger(pollAttempts) || pollAttempts < 0 || pollAttempts > 60 ||
      !Number.isInteger(pollMs) || pollMs < 0 || pollMs > 2000 || typeof authorize !== 'function') {
    throw new Error('Invalid voice send scope or configuration');
  }
  const owner = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
  if (owner !== accountId) throw new Error('Voice database account mismatch');
  ensureVoiceSendTable(db);
  const textHash = hash(text);
  const inserted = db.prepare(`INSERT OR IGNORE INTO voice_sends
    (key,account_id,group_id,task_id,source_message_id,text_hash,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'synthesizing',?,?)`).run(key, accountId, groupId, taskId, sourceId, textHash, now, now).changes;
  let row = db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key);
  if (row.account_id !== accountId || row.group_id !== groupId || row.task_id !== taskId ||
      row.source_message_id !== sourceId || row.text_hash !== textHash) throw new Error('Voice idempotency content conflict');
  if (!inserted) {
    // A concurrent caller must not mark another live synthesizer as failed or cause fallback text.
    if (['synthesizing', 'prepared', 'uploading'].includes(row.state) && now - row.updated_at < 120000) {
      return { ...rowResult(row), state: 'pending_receipt', safeToFallback: false };
    }
    return reconcileVoiceSend({ db, client, transport, key, signal, now, pollAttempts, pollMs });
  }
  let dispatched = false;
  try {
    if (!await authorize()) throw new Error('Voice send no longer authorized');
    const audio = await synthesizer(text, { signal });
    const bytes = readFileSync(audio.path), info = inspectVoiceWave(bytes);
    if (audio.sha256 !== info.sha256) throw new Error('Synthesized voice content mismatch');
    db.prepare("UPDATE voice_sends SET state='prepared',path=?,sha256=?,duration_ms=?,updated_at=? WHERE key=?")
      .run(audio.path, info.sha256, info.durationMs, now, key);
    db.prepare("UPDATE voice_sends SET state='uploading',updated_at=? WHERE key=?").run(now, key);
    const uploaded = await transport.upload(bytes, signal);
    if (!identity(uploaded?.id) || uploaded.sha256 !== info.sha256 || uploaded.byteLength !== info.bytes) {
      throw new Error('Uploaded voice identity mismatch');
    }
    if (!await authorize()) throw new Error('Voice send no longer authorized');
    db.prepare("UPDATE voice_sends SET state='dispatching',upload_id=?,updated_at=? WHERE key=?").run(uploaded.id, now, key);
    dispatched = true;
    const job = await transport.submit(groupId, uploaded.id, key, signal);
    row = saveJob(db, db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key), job, now);
    if (row.state === 'pending_receipt') return reconcileVoiceSend({ db, client, transport, key, signal, now, pollAttempts, pollMs });
    return rowResult(row);
  } catch (error) {
    if (dispatched) {
      const result = await reconcileVoiceSend({ db, client, transport, key, signal, now, pollAttempts: 0, pollMs });
      return { ...result, errorType: error.name };
    }
    db.prepare("UPDATE voice_sends SET state='not_sent',updated_at=? WHERE key=?").run(now, key);
    return { ...rowResult(db.prepare('SELECT * FROM voice_sends WHERE key=?').get(key)), errorType: error.name };
  }
}
