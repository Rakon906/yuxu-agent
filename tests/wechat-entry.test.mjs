import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { engineInvocation, runWeChatCli } from '../scripts/wechat.mjs';

test('entry preserves the existing account store and literal message arguments', () => {
  const args = ['--json', 'messages', 'send', 'filehelper', '--text', '原文 $() ` & " 中文'];
  const command = engineInvocation(args, { root: process.cwd(), env: {} });
  assert.equal(command.executable, resolve('.tools/agent-wechat/v1.3.2/wx.exe'));
  assert.deepEqual(command.args, ['--data-dir', resolve('.runtime/agent-wechat'), ...args]);
  assert.equal(args[0], '--json');
});

test('entry respects explicit storage and executable overrides without duplicate flags', () => {
  const args = ['--data-dir=./test-account', '--json', 'accounts', 'list'];
  const command = engineInvocation(args, { root: process.cwd(), env: {
    SOCIOMEM_WECHAT_CLI: 'work/custom engine.exe', SOCIOMEM_WECHAT_DATA_DIR: 'work/unused',
  } });
  assert.equal(command.executable, resolve('work/custom engine.exe'));
  assert.deepEqual(command.args, args);
  const literal = engineInvocation(['messages', '--', '--data-dir'], { root: process.cwd(), env: {} });
  assert.equal(literal.args[0], '--data-dir');
  assert.equal(literal.args[1], resolve('.runtime/agent-wechat'));
});

test('entry forwards native output and exit status without a shell or automatic retry', () => {
  let calls = 0;
  const stdout = { write() { assert.fail('Do not prefix native JSON'); } };
  const status = runWeChatCli(['--json', 'accounts', 'list'], {
    env: {}, stdout,
    execute(executable, args, options) {
      calls++;
      assert.equal(options.shell, false);
      assert.equal(options.stdio, 'inherit');
      assert.deepEqual(args.slice(-3), ['--json', 'accounts', 'list']);
      return { status: 7 };
    },
  });
  assert.equal(status, 7);
  assert.equal(calls, 1);
});

test('help and product version never start a daemon or authenticate an account', () => {
  const texts = [];
  for (const args of [[], ['--help'], ['--version'], ['--licenses']]) {
    const status = runWeChatCli(args, { stdout: { write: text => texts.push(text) },
      execute() { assert.fail('Information commands must not execute the native program'); } });
    assert.equal(status, 0);
  }
  assert.match(texts[0], /Yuxu 微信引擎/u);
  assert.match(texts[2], /Yuxu 微信引擎 \d+\.\d+\.\d+/u);
  assert.match(texts[3], /Nick Yu and contributors/u);
});
