import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chooseWorkerAction,
  parseManifest,
  repairStaleOwner,
  workerCommandMatches,
  workerDatabasePath,
  workerEnvironment,
  workerKey,
  workerScriptPath,
} from '../packages/supervisor/index.mjs';

test('supervisor manifest accepts only known worker scripts', () => {
  assert.deepEqual(parseManifest({ workers: ['watch-wechat-capture.mjs', 'participation-worker.mjs'] }),
    ['watch-wechat-capture.mjs', 'participation-worker.mjs']);
  assert.deepEqual(parseManifest({ workers: ['moments-worker.mjs', 'moments-worker.mjs'] }),
    ['moments-worker.mjs']);
  assert.throws(() => parseManifest({ workers: [] }), /Invalid/u);
  assert.throws(() => parseManifest({ workers: ['../../evil.mjs'] }), /Unknown/u);
  assert.throws(() => parseManifest({ workers: ['not-a-worker.mjs'] }), /Unknown/u);
  assert.throws(() => parseManifest({ workers: ['watch-wechat-capture.mjs', 1] }), /Unknown/u);
});

test('worker command matching normalizes Windows separators', () => {
  const script = workerScriptPath('C:\\fixture\\yuxu', 'watch-wechat-capture.mjs');
  assert.equal(workerCommandMatches('node.exe C:\\fixture\\yuxu\\scripts\\watch-wechat-capture.mjs', script), true);
  assert.equal(workerCommandMatches('node.exe C:/fixture/yuxu/scripts/watch-wechat-capture.mjs', script), true);
  assert.equal(workerCommandMatches('node.exe C:\\fixture\\yuxu\\scripts\\participation-worker.mjs', script), false);
  assert.equal(workerCommandMatches(null, script), false);
  assert.equal(workerCommandMatches(`node.exe "${script}.backup"`, script), false);
  assert.equal(workerCommandMatches(`node.exe "${script}"`, script), true);
});

test('manifest keeps independently identified group instances while accepting legacy workers', () => {
  const one = { script: 'group-participation-worker.mjs', groupId: '12345@chatroom' };
  const two = { script: 'group-participation-worker.mjs', groupId: '67890@chatroom' };
  assert.deepEqual(parseManifest({ workers: ['participation-worker.mjs', one, two, one] }),
    ['participation-worker.mjs', one, two]);
  assert.notEqual(workerKey(one), workerKey(two));
  assert.throws(() => parseManifest({ workers: ['group-participation-worker.mjs'] }), /requires/u);
  for (const invalid of [
    { ...one, groupId: 'other-user' }, { ...one, groupId: '../../12345@chatroom' },
    { ...one, env: { SOCIOMEM_WECHAT_GROUPS: 'unauthorized@chatroom' } },
    { script: 'diary-worker.mjs', groupId: one.groupId },
  ]) assert.throws(() => parseManifest({ workers: [invalid] }), /Invalid/u);
});

test('one group worker cannot satisfy another group instance process check', () => {
  const script = workerScriptPath('C:\\fixture\\yuxu', 'group-participation-worker.mjs');
  const command = `"E:\\node.exe" "${script}" --group "12345@chatroom"`;
  assert.equal(workerCommandMatches(command, script, '12345@chatroom'), true);
  assert.equal(workerCommandMatches(command, script, '67890@chatroom'), false);
  assert.equal(workerCommandMatches(`node.exe ${script}`, script, '12345@chatroom'), false);
  assert.equal(workerCommandMatches(`${command} --group 67890@chatroom`, script, '12345@chatroom'), false);
  assert.equal(workerCommandMatches(command.replace('12345@chatroom', '12345@chatroom-other'), script, '12345@chatroom'), false);
});

test('restart environments restore multi-group capture and diary with separate single-group participation', () => {
  const config = { accountId: 'account-test', primaryGroupId: '11111@chatroom',
    groupIds: ['11111@chatroom', '22222@chatroom'], groups: [
      { groupId: '11111@chatroom', participationDbPath: 'primary.sqlite' },
      { groupId: '22222@chatroom', participationDbPath: 'secondary.sqlite' },
    ] };
  const base = { SOCIOMEM_WECHAT_GROUPS: 'wrong@chatroom', SOCIOMEM_PARTICIPATION_SEND: '1' };
  for (const name of ['watch-wechat-capture.mjs', 'diary-worker.mjs']) {
    const environment = workerEnvironment(name, config, base);
    assert.equal(environment.SOCIOMEM_WECHAT_GROUPS, '11111@chatroom,22222@chatroom');
    assert.equal(environment.SOCIOMEM_WECHAT_ACCOUNT_ID, 'account-test');
  }
  for (const name of ['participation-worker.mjs', 'moments-worker.mjs', 'moments-publish-worker.mjs']) {
    assert.equal(workerEnvironment(name, config, base).SOCIOMEM_WECHAT_GROUPS, '11111@chatroom');
  }
  const additional = { script: 'group-participation-worker.mjs', groupId: '22222@chatroom' };
  assert.equal(workerEnvironment(additional, config, base).SOCIOMEM_WECHAT_GROUPS, '22222@chatroom');
  assert.equal(workerEnvironment(additional, config, base).SOCIOMEM_PARTICIPATION_SEND, '1');
  assert.equal(base.SOCIOMEM_WECHAT_GROUPS, 'wrong@chatroom');
  assert.equal(workerDatabasePath('C:\\fixture\\yuxu', additional, config), 'secondary.sqlite');
  assert.notEqual(workerDatabasePath('C:\\fixture\\yuxu', 'participation-worker.mjs', config), 'secondary.sqlite');
  for (const groupId of ['11111@chatroom', '33333@chatroom']) {
    assert.throws(() => workerEnvironment({ ...additional, groupId }, config, base), /authorized additional/u);
    assert.throws(() => workerDatabasePath('C:\\fixture\\yuxu', { ...additional, groupId }, config), /authorized additional/u);
  }
});

test('supervisor restarts missing workers with exponential backoff', () => {
  const now = 1_000_000;
  const first = chooseWorkerAction({ running: false, now });
  assert.equal(first.action, 'restart');
  assert.equal(first.nextState.attempts, 1);
  assert.equal(first.nextState.nextAttemptAt, now + 15000);

  const waiting = chooseWorkerAction({ running: false, now: now + 5000, ...first.nextState });
  assert.equal(waiting.action, 'wait');

  const second = chooseWorkerAction({ running: false, now: now + 15001, ...first.nextState });
  assert.equal(second.action, 'restart');
  assert.equal(second.nextState.attempts, 2);
  assert.equal(second.nextState.nextAttemptAt, now + 15001 + 30000);

  const recovered = chooseWorkerAction({ running: true, now, attempts: 5, nextAttemptAt: now + 1 });
  assert.equal(recovered.action, 'none');
  assert.deepEqual(recovered.nextState, { attempts: 0, nextAttemptAt: 0 });

  let state = { attempts: 0, nextAttemptAt: 0 };
  let at = now;
  let lastDelay = 0;
  for (let index = 0; index < 8; index += 1) {
    const decision = chooseWorkerAction({ running: false, now: at, ...state });
    lastDelay = decision.nextState.nextAttemptAt - at;
    state = decision.nextState;
    at = state.nextAttemptAt;
  }
  assert.equal(state.attempts, 8);
  assert.equal(lastDelay, 300000);
});

test('supervisor repairs stale owner locks and keeps live ones', t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-supervisor-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupDir = join(root, 'backups');
  mkdirSync(backupDir, { recursive: true });
  const script = join(root, 'scripts', 'watch-wechat-capture.mjs');
  const lock = join(root, 'sociomem.sqlite.owner');
  writeFileSync(lock, '999999\n');
  const stale = repairStaleOwner({ lockPath: lock, scriptPath: script, processes: new Map(), backupDir, now: 1000 });
  assert.equal(stale.removed, true);
  assert.equal(existsSync(lock), false);
  assert.equal(readdirSync(backupDir).length, 1);

  writeFileSync(lock, '123\n');
  const live = repairStaleOwner({
    lockPath: lock,
    scriptPath: script,
    processes: new Map([[123, `node.exe ${script}`]]),
    backupDir,
    now: 1000,
  });
  assert.deepEqual(live, { removed: false, reason: 'live' });
  assert.equal(existsSync(lock), true);

  writeFileSync(lock, '123\n');
  const reused = repairStaleOwner({
    lockPath: lock,
    scriptPath: script,
    processes: new Map([[123, 'node.exe C:\\fixture\\yuxu\\scripts\\participation-worker.mjs']]),
    backupDir,
    now: 1000,
  });
  assert.equal(reused.removed, true);
  assert.equal(existsSync(lock), false);

  writeFileSync(lock, 'not-a-pid\n');
  const invalid = repairStaleOwner({ lockPath: lock, scriptPath: script, processes: new Map(), backupDir, now: 1000 });
  assert.equal(invalid.removed, true);
  assert.equal(existsSync(lock), false);
});

test('group owner repair preserves live wrappers and stores separate backups for equal database names', t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-group-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const backupDir = join(root, 'backups');
  mkdirSync(backupDir);
  const script = workerScriptPath(root, 'group-participation-worker.mjs');
  const first = join(root, 'first', 'participation.sqlite.owner');
  const second = join(root, 'second', 'participation.sqlite.owner');
  mkdirSync(join(root, 'first'));
  mkdirSync(join(root, 'second'));
  writeFileSync(first, '123\n');
  const live = repairStaleOwner({ lockPath: first, scriptPath: script,
    processes: new Map([[123, `node.exe "${script}" --group 99999@chatroom`]]), backupDir, now: 1000 });
  assert.equal(live.reason, 'live');
  assert.equal(existsSync(first), true);
  writeFileSync(second, '456\n');
  for (const lockPath of [first, second]) {
    assert.equal(repairStaleOwner({ lockPath, scriptPath: script, processes: new Map(), backupDir, now: 1000 }).removed, true);
  }
  assert.equal(readdirSync(backupDir).length, 2);
  writeFileSync(first, '123\n');
  assert.throws(() => repairStaleOwner({ lockPath: first, scriptPath: script, processes: new Map(),
    backupDir: join(root, 'missing-backup-directory'), now: 1000 }));
  assert.equal(existsSync(first), true);
});
