import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGroupAllowlist, selectOnlineAccount, validateSendGate } from '../packages/wechat-adapter/real-config.mjs';

test('real config requires explicit chatroom allowlist', () => {
  assert.deepEqual(parseGroupAllowlist('a@chatroom, a@chatroom\nb@chatroom'), ['a@chatroom', 'b@chatroom']);
  assert.throws(() => parseGroupAllowlist('filehelper'), /@chatroom/);
  assert.throws(() => parseGroupAllowlist(''), /@chatroom/);
});

test('real config selects exactly one authenticated online account', () => {
  const items = [
    { id: 'offline', alias: 'old', authenticated: false, connection: 'disconnected', ownUsername: 'wxid_old' },
    { id: 'online', alias: 'sociomem', authenticated: true, connection: 'online', ownUsername: 'wxid_self' },
  ];
  assert.deepEqual(selectOnlineAccount(items), { accountId: 'online', alias: 'sociomem', selfUserId: 'wxid_self' });
  assert.deepEqual(selectOnlineAccount(items, { alias: 'sociomem' }), { accountId: 'online', alias: 'sociomem', selfUserId: 'wxid_self' });
  assert.throws(() => selectOnlineAccount(items, { alias: 'old' }), /not online/);
  assert.throws(() => selectOnlineAccount([...items, { ...items[1], id: 'second', alias: 'second' }]), /Exactly one/);
});

test('real send gate requires process opt-in and exact draft confirmation', () => {
  assert.doesNotThrow(() => validateSendGate({ enabled: '1', key: 'draft-1', confirmation: 'SEND draft-1' }));
  assert.throws(() => validateSendGate({ enabled: undefined, key: 'draft-1', confirmation: 'SEND draft-1' }), /SOCIOMEM_ENABLE_SEND/);
  assert.throws(() => validateSendGate({ enabled: '1', key: 'draft-1', confirmation: 'SEND draft-2' }), /Exact send confirmation/);
});
