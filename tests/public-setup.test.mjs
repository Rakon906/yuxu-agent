import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('public setup creates empty isolated group records and refuses to overwrite them', t => {
  const root = mkdtempSync(join(tmpdir(), 'yuxu-public-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  copyFileSync(new URL('../scripts/setup.mjs', import.meta.url), join(root, 'scripts/setup.mjs'));
  const args = [join(root, 'scripts/setup.mjs'), '--account', 'account-fixture', '--group', '10001@chatroom', '--group', '10002@chatroom'];
  const run = () => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const first = run(); assert.equal(first.status, 0, first.stderr);
  const peoplePath = join(root, '.runtime/people/group-people.json');
  const before = readFileSync(peoplePath, 'utf8');
  assert.deepEqual(JSON.parse(before).namesByUserId, {});
  assert.deepEqual(JSON.parse(before).identitySnapshots, {});
  assert.equal(JSON.parse(readFileSync(join(root, '.runtime/wechat-groups.json'), 'utf8')).groups.length, 2);
  assert.notEqual(run().status, 0);
  assert.equal(readFileSync(peoplePath, 'utf8'), before);
});
