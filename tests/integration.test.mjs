import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { prepareRun, createRuntime } from '../scripts/runtime.mjs';

async function jsonLines(path) {
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

test('real Harness profile: tools, scope, silence, trace and cross-process persistence', { timeout: 180000 }, async t => {
  const run = await prepareRun('integration');
  const runtime = createRuntime(run);
  let sessionId;
  try {
    await t.test('plugin exposes context through the default loop tool continuation', async () => {
      const result = await runtime.run('[test] inspect context; marker=phase1-persisted');
      sessionId = result.sessionId;
      assert.match(result.finalResponse, /CONTEXT_OK/);
      assert.ok(result.events.some(event => event.type === 'tool/call'));
      assert.ok(result.events.some(event => event.type === 'tool/result'));
      assert.ok(result.events.some(event => event.type === 'turn/end'));
    });
    await t.test('invalid tool input is rejected before body execution', async () => {
      const before = (await jsonLines(join(run.runRoot, 'decisions.jsonl'))).filter(row => row.kind === 'tool.body').length;
      const result = await runtime.run('[test] bad-input');
      assert.match(result.finalResponse, /TOOL_ERROR/);
      assert.doesNotMatch(result.finalResponse, /GROUP_SCOPE_DENIED/);
      assert.match(result.finalResponse, /string/);
      const after = (await jsonLines(join(run.runRoot, 'decisions.jsonl'))).filter(row => row.kind === 'tool.body').length;
      assert.equal(after, before);
    });
    await t.test('host-bound group guard rejects a different group', async () => {
      const before = (await jsonLines(join(run.runRoot, 'decisions.jsonl'))).filter(row => row.kind === 'tool.body').length;
      const result = await runtime.run('[test] cross-group');
      assert.match(result.finalResponse, /GROUP_SCOPE_DENIED/);
      assert.equal((await jsonLines(join(run.runRoot, 'decisions.jsonl'))).filter(row => row.kind === 'tool.body').length, before);
    });
    await t.test('Harness rejects malformed tool output', async () => {
      const result = await runtime.run('[test] bad-output');
      assert.match(result.finalResponse, /TOOL_ERROR/);
      const trace = await jsonLines(join(run.runRoot, 'decisions.jsonl'));
      assert.ok(trace.some(row => row.tool === 'fixture_bad_output' && row.errorCode === 'INVALID_TOOL_OUTPUT'));
    });
    await t.test('inherited shell tools are not executable', async () => {
      const result = await runtime.run('[test] forbidden-tool');
      assert.match(result.finalResponse, /TOOL_ERROR/);
      const calls = await jsonLines(join(run.runRoot, 'model-calls.jsonl'));
      assert.ok(calls.every(call => call.tools.every(name => ['sociomem_context', 'fixture_bad_output'].includes(name))));
      const trace = await jsonLines(join(run.runRoot, 'decisions.jsonl'));
      assert.ok(trace.some(row => row.tool === 'bash' && row.errorCode === 'UNKNOWN_TOOL'));
    });
    await t.test('explicit context-only message closes without a model call', async () => {
      const before = (await jsonLines(join(run.runRoot, 'model-calls.jsonl'))).length;
      const result = await runtime.run('[context-only] synthetic background chatter');
      assert.equal(result.finalResponse, '');
      assert.equal((await jsonLines(join(run.runRoot, 'model-calls.jsonl'))).length, before);
      assert.ok((await jsonLines(join(run.runRoot, 'decisions.jsonl'))).some(row => row.kind === 'decision.silent'));
    });
  } finally {
    await runtime.close();
  }
  await t.test('new dsh process resumes the original persisted history', async () => {
    assert.ok(sessionId);
    const resumed = createRuntime(run);
    try {
      const session = await resumed.resumeSession(sessionId);
      const result = await session.run('[test] recall-marker');
      assert.equal(result.sessionId, sessionId);
      assert.equal(result.finalResponse, 'RESTORED_MARKER_FOUND');
      const trace = await jsonLines(join(run.runRoot, 'decisions.jsonl'));
      assert.ok(trace.some(row => row.kind === 'agent.ready' && row.source === 'resume'));
    } finally {
      await resumed.close();
    }
  });
  console.log('Integration artifacts:', run.runRoot);
});
