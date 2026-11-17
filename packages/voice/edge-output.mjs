import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectVoiceWave, normalizeSpokenText } from './output.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const MAX_WAV_BYTES = 2 * 1024 * 1024;
const digest = value => createHash('sha256').update(value).digest('hex');
export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoyiNeural';
export const DEFAULT_EDGE_RATE = '-5%';
export const EDGE_TTS_VERSION = '7.3.1';
export const MINIAUDIO_VERSION = '1.73';
const engine = 'edge-tts';

function boundedWave(path) {
  const stat = statSync(path);
  if (!stat.isFile() || stat.size > MAX_WAV_BYTES) throw new Error('Invalid Edge voice WAV size');
  return inspectVoiceWave(readFileSync(path));
}

function processRunner({ pythonPath, helperPath, timeoutMs, spawnProcess }) {
  return (request, { signal } = {}) => new Promise((resolveResult, reject) => {
    if (signal?.aborted) return reject(new Error('Edge speech synthesis aborted'));
    let child;
    try {
      child = spawnProcess(pythonPath, ['-I', '-B', helperPath], {
        windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch { return reject(new Error('Edge speech process unavailable')); }
    let done = false, discarded = false, chunks = [], outputBytes = 0, timer;
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) { discarded = true; try { child.kill(); } catch {} reject(error); }
      else resolveResult(value);
    };
    const abort = () => finish(new Error('Edge speech synthesis aborted'));
    timer = setTimeout(() => finish(new Error('Edge speech synthesis timed out')), timeoutMs);
    child.stdout.on('data', value => {
      if (done) return;
      const chunk = Buffer.from(value); outputBytes += chunk.length;
      if (outputBytes > 4096) return finish(new Error('Edge speech response exceeds limit'));
      chunks.push(chunk);
    });
    // Engine diagnostics can contain source text or URLs. Never echo them.
    child.stderr.on('data', () => {});
    child.on('error', () => finish(new Error('Edge speech process unavailable')));
    child.stdin.on('error', () => finish(new Error('Edge speech input failed')));
    child.on('close', code => {
      if (done) {
        // kill() may return before Python finishes a pending write. The outer finally
        // cleans immediately; repeat after process close for this invocation's unique
        // temporary path only. Content-addressed cached WAVs are never touched here.
        if (discarded) { try { if (existsSync(request.path)) unlinkSync(request.path); } catch {} }
        return;
      }
      if (code !== 0) return finish(new Error('Edge speech synthesis failed'));
      try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8').trim())); }
      catch { finish(new Error('Invalid Edge speech response')); }
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) return abort();
    try { child.stdin.end(JSON.stringify(request), 'utf8'); }
    catch { finish(new Error('Edge speech input failed')); }
  });
}

/** Network TTS only; failure is propagated for the existing pre-send text fallback. */
export function createEdgeVoiceSynthesizer({
  outputDir = join(root, '.runtime', 'voice-output', 'edge'),
  voice = DEFAULT_EDGE_VOICE, rate = DEFAULT_EDGE_RATE,
  pythonPath = join(root, '.tools', 'edge-tts', 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'])),
  helperPath = join(root, 'tools', 'voice', 'edge_synthesize.py'),
  timeoutMs = 30000, run, spawnProcess = spawn,
} = {}) {
  if (typeof voice !== 'string' || !/^zh-CN-[A-Za-z]+Neural$/u.test(voice) ||
      typeof rate !== 'string' || !/^[+-](?:0|[1-9]\d?)%$/u.test(rate) || Math.abs(Number(rate.slice(0, -1))) > 50 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 120000 ||
      ![outputDir, pythonPath, helperPath].every(value => typeof value === 'string' && value && !/[\u0000-\u001f]/u.test(value)) ||
      typeof spawnProcess !== 'function' || (run !== undefined && typeof run !== 'function')) {
    throw new Error('Invalid Edge voice configuration');
  }
  outputDir = resolve(outputDir);
  const execute = run ?? processRunner({ pythonPath: resolve(pythonPath), helperPath: resolve(helperPath), timeoutMs, spawnProcess });
  return async (input, { signal } = {}) => {
    signal?.throwIfAborted();
    const text = normalizeSpokenText(input);
    mkdirSync(outputDir, { recursive: true, mode: 0o700 });
    const fingerprint = digest(JSON.stringify(['edge-pcm16k-v1', EDGE_TTS_VERSION, MINIAUDIO_VERSION, voice, rate, text]));
    const metadataPath = join(outputDir, `${fingerprint}.json`);
    if (existsSync(metadataPath)) {
      if (statSync(metadataPath).size > 4096) throw new Error('Cached Edge voice metadata exceeds limit');
      const saved = JSON.parse(readFileSync(metadataPath, 'utf8'));
      if (saved.fingerprint !== fingerprint || saved.voice !== voice || saved.rate !== rate || saved.engine !== engine ||
          saved.engineVersion !== EDGE_TTS_VERSION || saved.converterVersion !== MINIAUDIO_VERSION ||
          typeof saved.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(saved.sha256)) {
        throw new Error('Cached Edge voice identity mismatch');
      }
      // File names come from validated hashes, never a caller-provided metadata path.
      const path = join(outputDir, `${saved.sha256}.wav`), info = boundedWave(path);
      if (saved.sha256 !== info.sha256 || saved.bytes !== info.bytes || saved.durationMs !== info.durationMs) {
        throw new Error('Cached Edge voice integrity mismatch');
      }
      signal?.throwIfAborted();
      return { ...info, path, voice, rate, engine, engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION, cached: true };
    }
    const temp = join(outputDir, `${fingerprint}-${randomUUID()}.wav`), metadataTemp = `${temp}.json`;
    try {
      const result = await execute({ text, path: temp, voice, rate,
        engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION,
        timeoutMs: Math.max(10, timeoutMs - Math.min(1000, Math.floor(timeoutMs / 10))) }, { signal });
      signal?.throwIfAborted();
      if (result?.engine !== engine || result.voice !== voice || result.rate !== rate ||
          result.engineVersion !== EDGE_TTS_VERSION || result.converterVersion !== MINIAUDIO_VERSION) {
        throw new Error('Edge speech engine identity mismatch');
      }
      const info = boundedWave(temp);
      if (result.sha256 !== info.sha256 || result.bytes !== info.bytes || result.durationMs !== info.durationMs) {
        throw new Error('Edge speech output integrity mismatch');
      }
      const path = join(outputDir, `${info.sha256}.wav`);
      if (existsSync(path)) {
        if (boundedWave(path).sha256 !== info.sha256) throw new Error('Cached Edge voice content collision');
        unlinkSync(temp);
      } else renameSync(temp, path);
      writeFileSync(metadataTemp, JSON.stringify({ ...info, fingerprint, voice, rate, engine,
        engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION }), { mode: 0o600, flag: 'wx' });
      renameSync(metadataTemp, metadataPath);
      return { ...info, path, voice, rate, engine, engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION, cached: false };
    } finally {
      // Only this invocation's unique files are cleaned; cached audio remains immutable.
      for (const owned of [temp, metadataTemp]) {
        try { if (existsSync(owned)) unlinkSync(owned); } catch {}
      }
    }
  };
}
