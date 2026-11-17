import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectVoiceWave } from '../packages/voice/output.mjs';
import { createEdgeVoiceSynthesizer, DEFAULT_EDGE_VOICE, DEFAULT_EDGE_RATE,
  EDGE_TTS_VERSION, MINIAUDIO_VERSION } from '../packages/voice/edge-output.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtimePython = join(root, '.tools', 'edge-tts', 'venv', ...(process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python']));
const helperPath = join(root, 'tools', 'voice', 'edge_synthesize.py');
function fixtureDir() {
  const parent = join(root, '.runtime', 'test-tmp'); mkdirSync(parent, { recursive: true });
  return mkdtempSync(join(parent, 'edge-voice-'));
}
function wave(durationMs = 1000, marker = 1) {
  const bytes = Buffer.alloc(44 + durationMs * 32);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36);
  bytes.writeUInt32LE(durationMs * 32, 40); bytes[50] = marker; return bytes;
}
function output(request, bytes = wave()) {
  writeFileSync(request.path, bytes);
  return { ...inspectVoiceWave(bytes), engine: 'edge-tts', engineVersion: EDGE_TTS_VERSION,
    converterVersion: MINIAUDIO_VERSION, voice: request.voice, rate: request.rate };
}
function fakeSpawn(onInput) {
  const calls = [];
  const spawnProcess = (command, args, options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kills = 0; child.kill = () => { child.kills++; return true; };
    let input = '';
    child.stdin = new Writable({ write(chunk, _, done) { input += chunk.toString('utf8'); done(); } });
    calls.push({ command, args, options, child });
    child.stdin.on('finish', () => onInput?.(JSON.parse(input), child));
    return child;
  };
  return { spawnProcess, calls };
}

test('Edge synthesis defaults to Xiaoyi, hashes verified WAV cache and treats source text as data', async () => {
  const dir = fixtureDir(), inputs = [];
  const synth = createEdgeVoiceSynthesizer({ outputDir: dir, run: async request => {
    inputs.push(request); return output(request);
  } });
  const text = '测试 `$(whoami) 和 <tag> 都是文字';
  const first = await synth(text), cached = await synth(text);
  assert.equal(inputs.length, 1); assert.equal(inputs[0].text, text);
  assert.equal(inputs[0].voice, DEFAULT_EDGE_VOICE); assert.equal(inputs[0].rate, DEFAULT_EDGE_RATE);
  assert.equal(first.engine, 'edge-tts'); assert.equal(first.cached, false); assert.equal(cached.cached, true);
  assert.equal(first.path, cached.path); assert.ok(first.path.endsWith(`${first.sha256}.wav`));
  const bytes = readFileSync(first.path); bytes[60] ^= 1; writeFileSync(first.path, bytes);
  await assert.rejects(synth(text), /integrity/u);
  assert.equal(inputs.length, 1, 'corrupt cache cannot silently generate a different voice');
  await assert.rejects(synth('a'.repeat(161)), /160/u);
});

test('Edge process uses argv only for trusted paths and bounded JSON stdin for the message', async () => {
  const dir = fixtureDir(), seen = [];
  const fake = fakeSpawn((request, child) => {
    seen.push(request); child.stdout.write(JSON.stringify(output(request))); child.emit('close', 0);
  });
  const synth = createEdgeVoiceSynthesizer({ outputDir: dir, pythonPath: runtimePython, helperPath, spawnProcess: fake.spawnProcess });
  await synth('别执行 $(exit) 和 `反引号`');
  assert.deepEqual(fake.calls[0].args, ['-I', '-B', helperPath]);
  assert.equal(fake.calls[0].command, runtimePython);
  assert.equal(fake.calls[0].options.shell, false); assert.equal(fake.calls[0].options.windowsHide, true);
  assert.equal(seen[0].text, '别执行 $(exit) 和 `反引号`');
  assert.ok(!fake.calls[0].args.join(' ').includes('exit'));
  assert.equal(seen[0].engineVersion, '7.3.1'); assert.equal(seen[0].converterVersion, '1.73');
});

test('Edge process kills on timeout and abort, bounds stdout, and never echoes provider diagnostics', async () => {
  const timeout = fakeSpawn();
  await assert.rejects(createEdgeVoiceSynthesizer({ outputDir: fixtureDir(), timeoutMs: 20, spawnProcess: timeout.spawnProcess })('超时'), /timed out/u);
  assert.equal(timeout.calls[0].child.kills, 1);
  const controller = new AbortController(), aborted = fakeSpawn(() => controller.abort());
  await assert.rejects(createEdgeVoiceSynthesizer({ outputDir: fixtureDir(), spawnProcess: aborted.spawnProcess })('取消', { signal: controller.signal }), /aborted/u);
  assert.equal(aborted.calls[0].child.kills, 1);
  const huge = fakeSpawn((_, child) => child.stdout.write('x'.repeat(4097)));
  await assert.rejects(createEdgeVoiceSynthesizer({ outputDir: fixtureDir(), spawnProcess: huge.spawnProcess })('超长输出'), /limit/u);
  assert.equal(huge.calls[0].child.kills, 1);
  const failed = fakeSpawn((_, child) => { child.stderr.write('PRIVATE SOURCE TEXT https://private.invalid'); child.emit('close', 1); });
  await assert.rejects(createEdgeVoiceSynthesizer({ outputDir: fixtureDir(), spawnProcess: failed.spawnProcess })('失败'), error => {
    assert.equal(error.message, 'Edge speech synthesis failed'); return true;
  });
  assert.equal(failed.calls.length, 1, 'no fallback SAPI process or network retry loop');
});

test('Edge clears a temporary WAV written after kill when the process closes, preserving cached audio', async () => {
  for (const mode of ['abort', 'timeout']) {
    const dir = fixtureDir();
    const cached = await createEdgeVoiceSynthesizer({ outputDir: dir, run: async request => output(request) })('已有缓存');
    const controller = new AbortController(); let onLateClose, temporaryPath;
    const lateClose = new Promise(resolve => { onLateClose = resolve; });
    const fake = fakeSpawn((request, child) => {
      temporaryPath = request.path;
      child.kill = () => {
        child.kills++;
        setTimeout(() => {
          writeFileSync(request.path, wave(1000, 2));
          child.emit('close', 1);
          onLateClose();
        }, 20);
        return true;
      };
      if (mode === 'abort') controller.abort();
    });
    const synth = createEdgeVoiceSynthesizer({ outputDir: dir, timeoutMs: 20, spawnProcess: fake.spawnProcess });
    await assert.rejects(synth('取消中的新句子', { signal: controller.signal }), /aborted|timed out/u);
    await lateClose;
    assert.equal(fake.calls[0].child.kills, 1);
    assert.equal(existsSync(temporaryPath), false, 'late child output must be removed after close');
    assert.equal(inspectVoiceWave(readFileSync(cached.path)).sha256, cached.sha256);
    assert.equal(readdirSync(dir).filter(name => name.endsWith('.wav')).length, 1);
  }
});

test('Edge rejects wrong voice/version/hash or long audio, and cleans only its temporary files', async () => {
  for (const change of [r => ({ ...r, voice: 'zh-CN-XiaoxiaoNeural' }), r => ({ ...r, engineVersion: '9.0' }),
    r => ({ ...r, converterVersion: '0.0' }), r => ({ ...r, sha256: 'f'.repeat(64) })]) {
    const dir = fixtureDir(); writeFileSync(join(dir, 'keep.txt'), 'keep');
    const synth = createEdgeVoiceSynthesizer({ outputDir: dir, run: async request => change(output(request)) });
    await assert.rejects(synth('校验'), /identity|integrity/u);
    assert.deepEqual(readdirSync(dir), ['keep.txt']);
  }
  const dir = fixtureDir();
  await assert.rejects(createEdgeVoiceSynthesizer({ outputDir: dir, run: async request => {
    writeFileSync(request.path, wave(56000));
    return { engine: 'edge-tts', engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION,
      voice: request.voice, rate: request.rate };
  } })('太长'), /duration/u);
  assert.deepEqual(readdirSync(dir), []);
});

test('Edge voice/rate separate caches and concurrent output cannot overwrite returned audio', async () => {
  const dir = fixtureDir(); let count = 0;
  const run = async request => { await new Promise(resolve => setImmediate(resolve)); return output(request, wave(1000, ++count)); };
  const synth = createEdgeVoiceSynthesizer({ outputDir: dir, run });
  const [a, b] = await Promise.all([synth('同一句'), synth('同一句')]);
  assert.notEqual(a.path, b.path);
  assert.equal(inspectVoiceWave(readFileSync(a.path)).sha256, a.sha256);
  assert.equal(inspectVoiceWave(readFileSync(b.path)).sha256, b.sha256);
  const cached = await synth('同一句'); assert.ok([a.path, b.path].includes(cached.path)); assert.equal(count, 2);
  await createEdgeVoiceSynthesizer({ outputDir: dir, voice: 'zh-CN-XiaoxiaoNeural', run })('同一句');
  await createEdgeVoiceSynthesizer({ outputDir: dir, rate: '+0%', run })('同一句'); assert.equal(count, 4);
});

test('Edge configuration rejects executable syntax and cancellation also applies to cached audio', async () => {
  for (const options of [{ voice: 'zh-CN-XiaoyiNeural;exit' }, { rate: '-100%' }, { rate: '-5%;exit' },
    { timeoutMs: 0 }, { pythonPath: 'python\nother' }]) assert.throws(() => createEdgeVoiceSynthesizer(options));
  const synth = createEdgeVoiceSynthesizer({ outputDir: fixtureDir(), run: async request => output(request) });
  await synth('缓存'); const controller = new AbortController(); controller.abort();
  await assert.rejects(synth('缓存', { signal: controller.signal }));
});

test('Python bridge validates stdin, bounds streamed audio and creates exact PCM WAV without network',
  { skip: !existsSync(runtimePython) }, () => {
    const dir = fixtureDir(), request = { text: '仅离线夹具', path: join(dir, 'bridge.wav'), voice: DEFAULT_EDGE_VOICE,
      rate: DEFAULT_EDGE_RATE, engineVersion: EDGE_TTS_VERSION, converterVersion: MINIAUDIO_VERSION, timeoutMs: 3000 };
    const script = `
import asyncio, array, importlib.util, json, sys, types
spec = importlib.util.spec_from_file_location('bridge', sys.argv[1]); bridge = importlib.util.module_from_spec(spec); spec.loader.exec_module(bridge)
request = bridge.validate_request(json.loads(sys.stdin.buffer.read().decode('utf-8')))
class Communicate:
    def __init__(self, text, **kwargs):
        assert text == request['text']; assert kwargs['voice'] == request['voice']; assert kwargs['rate'] == '-5%'
    async def stream(self):
        yield {'type':'SentenceBoundary','text':'ignored'}
        yield {'type':'audio','data':b'fixture-mp3'}
audio = asyncio.run(bridge.collect_audio(request, types.SimpleNamespace(Communicate=Communicate)))
assert audio == b'fixture-mp3'
def decode(data, **kwargs):
    assert data == audio; assert kwargs == {'output_format':2,'nchannels':1,'sample_rate':16000}
    return types.SimpleNamespace(nchannels=1,sample_rate=16000,sample_width=2,sample_format=2,samples=array.array('h',[5]*16000))
codec = types.SimpleNamespace(SampleFormat=types.SimpleNamespace(SIGNED16=2),mp3_get_info=lambda data:types.SimpleNamespace(sample_rate=24000,num_frames=24000),decode=decode)
wav, duration = bridge.to_wave(audio, codec)
assert duration == 1000
open(request['path'],'xb').write(wav)
codec.decode = lambda *args, **kwargs: types.SimpleNamespace(nchannels=1,sample_rate=16000,sample_width=2,sample_format=2,samples=array.array('h',[5]*16008))
assert bridge.to_wave(audio, codec)[1] == 1001, 'half milliseconds must match JavaScript Math.round'
for invalid in [dict(request, rate='-80%'),dict(request, engineVersion='changed'),dict(request, timeoutMs=True)]:
    try: bridge.validate_request(invalid)
    except ValueError: pass
    else: raise AssertionError('invalid request accepted')
class Huge(Communicate):
    async def stream(self): yield {'type':'audio','data':b'x'*(bridge.MAX_MP3_BYTES+1)}
try: asyncio.run(bridge.collect_audio(request,types.SimpleNamespace(Communicate=Huge)))
except ValueError: pass
else: raise AssertionError('unbounded stream')
print('offline bridge checks passed')
`;
    const result = execFileSync(runtimePython, ['-I', '-B', '-c', script, helperPath], {
      cwd: root, input: JSON.stringify(request), encoding: 'utf8', windowsHide: true, timeout: 10000,
    });
    assert.match(result, /offline bridge checks passed/u);
    assert.equal(inspectVoiceWave(readFileSync(request.path)).durationMs, 1000);
  });
