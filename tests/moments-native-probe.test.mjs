import test from 'node:test';
import assert from 'node:assert/strict';
import { probeNativeMoments } from '../packages/moments/native-probe.mjs';

test('native probe reports unsupported when wx has no moments capability or profile database', async () => {
  const calls = [];
  const fake = async (_path, args) => {
    calls.push(args);
    if (args.at(-1) === 'version') return { stdout: JSON.stringify({ product: 'agent-wechat', version: '1.3.2', capabilities: ['text-send'] }) };
    return { stdout: JSON.stringify({ items: {} }) };
  };
  const result = await probeNativeMoments({ wxPath: 'wx.exe', dataDir: 'data', runner: fake });
  assert.equal(result.state, 'unsupported');
  assert.equal(result.read, false);
  assert.equal(result.publish, false);
  assert.equal(calls.length, 2);
});

test('native probe reports profile-only evidence when a moment database is present', async () => {
  const fake = async (_path, args) => {
    if (args.at(-1) === 'version') return { stdout: JSON.stringify({ product: 'agent-wechat', version: '1.3.2', capabilities: ['text-send'] }) };
    return { stdout: JSON.stringify({ databases: [{ relativePath: 'sns/moments.db', bytes: 1 }] }) };
  };
  const result = await probeNativeMoments({ wxPath: 'wx.exe', dataDir: 'data', localProfile: 'profile', runner: fake });
  assert.equal(result.state, 'profile_only');
  assert.equal(result.read, true);
  assert.equal(result.publish, false);
  assert.equal(result.evidence.profileDatabaseSummary.momentDatabaseCandidates.length, 1);
});
