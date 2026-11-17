import test from 'node:test';
import assert from 'node:assert/strict';
import { bytesToHex, decodeMessage, encodeFields, hexToBytes, outline, tryDecode, varint } from '../packages/moments/protobuf.mjs';
import { MomentsDaemonClient } from '../packages/moments/daemon-client.mjs';
import { runProbePlan, summarize } from '../packages/moments/probe-plan.mjs';

test('encodeFields and decodeMessage round-trip nested messages', () => {
  const inner = encodeFields([{ number: 1, varint: 42 }, { number: 2, bytes: 'wxid_abc' }]);
  const outer = encodeFields([{ number: 1, bytes: inner }, { number: 2, varint: 7 }]);
  const decoded = decodeMessage(outer);
  assert.equal(decoded.fields.length, 2);
  assert.equal(decoded.fields[1].varint, '7');
  assert.equal(decoded.fields[0].message[0].varint, '42');
  assert.equal(decoded.fields[0].message[1].text, 'wxid_abc');
});

test('varint encodes multi-byte values', () => {
  assert.equal(bytesToHex(varint(0)), '00');
  assert.equal(bytesToHex(varint(300)), 'ac02');
  assert.equal(bytesToHex(varint(2n ** 40n)), '808080808020');
});

test('decodeMessage rejects truncated and unsupported input', () => {
  assert.throws(() => decodeMessage(Buffer.from([0x0a, 0x05, 0x01])), /Truncated/);
  assert.throws(() => decodeMessage(Buffer.from([0x0b])), /wire type/);
  assert.equal(tryDecode(Buffer.from([0x0a])).ok, false);
});

test('hex helpers reject junk and odd lengths', () => {
  assert.deepEqual(hexToBytes('00ff'), Buffer.from([0, 255]));
  assert.throws(() => hexToBytes('abc'));
  assert.throws(() => hexToBytes('zz'));
});

test('outline expands nested fields and labels binary payloads', () => {
  const inner = encodeFields([{ number: 3, bytes: Buffer.from([0xff, 0xfe]) }]);
  const decoded = decodeMessage(encodeFields([{ number: 2, bytes: inner }]));
  const lines = outline(decoded.fields);
  assert.ok(lines.some(line => /#2 bytes\(/.test(line)));
  assert.ok(lines.some(line => /#3 bytes\(2\) binary/.test(line)));
});

test('daemon client only addresses read cgis', async () => {
  const client = new MomentsDaemonClient({ baseUrl: 'http://127.0.0.1:6174', token: 't', accountId: 'a' });
  await assert.rejects(() => client.probe(209, ''), /read-only/);
  await assert.rejects(() => client.probe(213, ''), /read-only/);
  await assert.rejects(() => client.probe(211, 'abc'), /hex/);
});

test('daemon client refuses remote plaintext origins', () => {
  assert.throws(() => new MomentsDaemonClient({ baseUrl: 'http://10.0.0.5:6174', token: 't', accountId: 'a' }), /HTTPS/);
  assert.throws(() => new MomentsDaemonClient({ baseUrl: 'http://127.0.0.1:6174/path', token: 't', accountId: 'a' }), /bare daemon origin/);
});

test('probe plan records outlines and strips hex from the summary', async () => {
  const reply = bytesToHex(encodeFields([{ number: 1, bytes: encodeFields([{ number: 1, varint: 0 }]) }, { number: 2, bytes: 'payload' }]));
  const calls = [];
  const client = {
    async probe(cgi, bodyHex) {
      calls.push({ cgi, bodyHex });
      return { baseCode: 0, baseMessage: null, replyBytes: reply.length / 2, replyHex: reply };
    },
  };
  const results = await runProbePlan({ client });
  assert.equal(calls.length, 9);
  assert.ok(results.every(result => result.ok));
  assert.equal(results[0].baseCode, 0);
  assert.ok(results[0].outline.some(line => /#2 bytes/.test(line)));
  const summary = summarize(results);
  assert.ok(summary.every(item => !('replyHex' in item)));
  assert.equal(summary[0].replyHexBytes, reply.length / 2);
});

test('probe plan surfaces the daemon error chain instead of a generic failure', async () => {
  const client = { async probe() { return { ok: false, detail: 'sns_rpc: Unexpected status 404' }; } };
  const results = await runProbePlan({ client });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /Unexpected status 404/);
});

test('probe plan keeps going after a failure', async () => {
  let index = 0;
  const client = {
    async probe() {
      index += 1;
      if (index === 1) throw new Error('daemon_unavailable');
      return { baseCode: 0, replyHex: '' };
    },
  };
  const results = await runProbePlan({ client });
  assert.equal(results[0].ok, false);
  assert.match(results[0].error, /daemon_unavailable/);
  assert.equal(results[1].ok, true);
});
