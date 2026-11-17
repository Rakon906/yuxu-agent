import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createPublishingFetchGate, readPublishingConfig } from '../scripts/moments-publish-worker.mjs';
import { MomentsPublishStore, MomentsPublishService } from '../packages/moments/publish-service.mjs';

const binding = { accountId: 'account-test', selfUserId: 'wxid-test' };
const config = () => ({ enabled: true, ...binding, visibility: 'friends', imageAcceptance: 'verified-on-phone' });
const asset = { kind: 'image', path: resolve('.runtime/moments/worker-gate-fixture.jpg'), sha256: 'a'.repeat(64),
  md5: 'b'.repeat(32), width: 10, height: 10, bytes: 1234, mimeType: 'image/jpeg' };
function directory() {
  mkdirSync(resolve('.runtime/runs'), { recursive: true });
  return mkdtempSync(resolve('.runtime/runs/moments-worker-'));
}

test('worker config stays disabled unless account, visibility and image acceptance are explicit', () => {
  const path = join(directory(), 'config.json');
  assert.deepEqual(readPublishingConfig(path), { enabled: false });
  writeFileSync(path, JSON.stringify({ enabled: false }));
  assert.deepEqual(readPublishingConfig(path), { enabled: false });
  for (const patch of [{ enabled: 'true' }, { selfUserId: null }, { accountId: '' },
    { visibility: 'private' }, { imageAcceptance: 'server-accepted' }]) {
    writeFileSync(path, JSON.stringify({ ...config(), ...patch }));
    assert.throws(() => readPublishingConfig(path));
  }
  writeFileSync(path, `\ufeff${JSON.stringify(config())}`);
  assert.deepEqual(readPublishingConfig(path), { enabled: true, ...binding, visibility: 'friends' });
});

test('fetch boundary refuses disabled, rebound, malformed or stopped configuration without HTTP', async () => {
  let current = config();
  let stopping = false;
  let calls = 0;
  const request = createPublishingFetchGate({ binding, readConfig: () => current, stopping: () => stopping,
    fetchImpl: async () => { calls++; return { ok: true }; } });
  await request('https://fixture.invalid/', {});
  assert.equal(calls, 1);
  for (const changed of [{ enabled: false }, { ...config(), accountId: 'foreign' },
    { ...config(), selfUserId: 'wxid-other' }, null]) {
    current = changed;
    await assert.rejects(request('https://fixture.invalid/'), { name: 'PublishingStoppedError' });
  }
  current = config(); stopping = true;
  await assert.rejects(request('https://fixture.invalid/'), { name: 'PublishingStoppedError' });
  assert.equal(calls, 1);
});

test('disable during successful upload blocks the subsequent actual publication request', async t => {
  let current = config();
  const requests = [];
  const guarded = createPublishingFetchGate({ binding, readConfig: () => current,
    fetchImpl: async url => { requests.push(url); return { ok: true }; } });
  const store = new MomentsPublishStore(join(directory(), 'publications.sqlite'));
  t.after(() => store.close());
  const service = new MomentsPublishService({ store, ...binding, gateway: {
    uploadImage: async a => {
      await guarded('https://fixture.invalid/upload');
      current = { enabled: false };
      return { sha256: a.sha256, width: a.width, height: a.height, bytes: a.bytes,
        url: 'https://fixture.invalid/image', thumbUrl: 'https://fixture.invalid/thumb' };
    },
    publish: async () => {
      await guarded('https://fixture.invalid/publish');
      return { state: 'accepted', momentId: '123' };
    },
    verify: async () => { throw new Error('must not verify an unpublished object'); },
  } });
  const draft = service.draft({ key: 'disable-during-upload', text: 'test', media: [asset], visibility: 'friends' });
  const outcome = await service.send(draft.key, draft.digest);
  assert.equal(outcome.state, 'needs_review');
  assert.deepEqual(requests, ['https://fixture.invalid/upload']);
  assert.equal(outcome.receipt.errorName, 'PublishingStoppedError');
  assert.ok(outcome.attemptedAt);
});

test('daemon token rotation is rejected without exposing old or new token or refreshing mid-attempt', async () => {
  let token = 'old-private-token';
  let requests = 0;
  const guarded = createPublishingFetchGate({ binding, readConfig: config,
    expectedToken: token, readToken: () => token,
    fetchImpl: async () => { requests++; return { ok: true }; } });
  await guarded('http://127.0.0.1:6174/upload');
  token = 'new-private-token';
  await assert.rejects(guarded('http://127.0.0.1:6174/publish'), error => {
    assert.equal(error.name, 'PublishingTokenChangedError');
    assert.equal(error.message.includes('old-private-token'), false);
    assert.equal(error.message.includes('new-private-token'), false);
    return true;
  });
  assert.equal(requests, 1);
});

test('SIGTERM abort signal combines with request timeout and stops an in-flight provider call', async () => {
  const shutdown = new AbortController();
  const timeout = new AbortController();
  let deliveredSignal;
  const guarded = createPublishingFetchGate({ binding, readConfig: config, stopSignal: shutdown.signal,
    fetchImpl: async (_url, options) => {
      deliveredSignal = options.signal;
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
  const waiting = guarded('https://fixture.invalid/model', { signal: timeout.signal });
  shutdown.abort(new Error('worker-stopped'));
  await assert.rejects(waiting, /worker-stopped/u);
  assert.equal(deliveredSignal.aborted, true);
  assert.equal(timeout.signal.aborted, false);
  await assert.rejects(guarded('https://fixture.invalid/next'), { name: 'PublishingStoppedError' });
});

test('disabled CLI --once emits startup-compatible ready and does not create ledgers or leave owner lock', () => {
  const dir = directory();
  const configPath = join(dir, 'config.json');
  const schedulePath = join(dir, 'schedule.sqlite');
  const publicationPath = join(dir, 'publications.sqlite');
  writeFileSync(configPath, JSON.stringify({ enabled: false }));
  const stdout = execFileSync(process.execPath, [resolve('scripts/moments-publish-worker.mjs'), '--once'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 15_000, windowsHide: true,
    env: { ...process.env, SOCIOMEM_MOMENTS_PUBLISH_CONFIG: configPath,
      SOCIOMEM_MOMENTS_PUBLISH_SCHEDULE: schedulePath, SOCIOMEM_MOMENTS_PUBLISH_LEDGER: publicationPath },
  });
  const logs = stdout.trim().split(/\r?\n/u).map(line => JSON.parse(line));
  assert.equal(logs[0].kind, 'ready'); assert.equal(logs[0].component, 'moments-publishing');
  assert.deepEqual(logs[1].calls, { model: 0, generation: 0, publish: 0 });
  assert.equal(logs[1].state, 'disabled');
  assert.equal(existsSync(schedulePath), false); assert.equal(existsSync(publicationPath), false);
  assert.equal(existsSync(`${schedulePath}.owner`), false);
});

test('second worker cannot replace an existing ownership lock or recover its jobs', () => {
  const dir = directory();
  const configPath = join(dir, 'config.json');
  const schedulePath = join(dir, 'schedule.sqlite');
  const ownerPath = `${schedulePath}.owner`;
  writeFileSync(configPath, JSON.stringify({ enabled: false }));
  writeFileSync(ownerPath, String(process.pid));
  try {
    assert.throws(() => execFileSync(process.execPath, [resolve('scripts/moments-publish-worker.mjs'), '--once'], {
      cwd: resolve('.'), encoding: 'utf8', timeout: 15_000, windowsHide: true, stdio: 'pipe',
      env: { ...process.env, SOCIOMEM_MOMENTS_PUBLISH_CONFIG: configPath, SOCIOMEM_MOMENTS_PUBLISH_SCHEDULE: schedulePath },
    }), error => { assert.equal(error.status, 1); assert.match(error.stderr, /EEXIST/u); return true; });
    assert.equal(readFileSync(ownerPath, 'utf8'), String(process.pid));
    assert.equal(existsSync(schedulePath), false);
  } finally { unlinkSync(ownerPath); }
});
