const nonEmpty = value => typeof value === 'string' && value.length > 0;

export function parseGroupAllowlist(value) {
  const groups = typeof value === 'string'
    ? [...new Set(value.split(/[\r\n,]+/).map(group => group.trim()).filter(Boolean))]
    : [];
  if (!groups.length || !groups.every(group => nonEmpty(group) && group.endsWith('@chatroom'))) {
    throw new Error('SOCIOMEM_WECHAT_GROUPS must contain one or more @chatroom IDs');
  }
  return groups;
}

export function selectOnlineAccount(items, { accountId, alias } = {}) {
  if (!Array.isArray(items)) throw new Error('accounts list response is invalid');
  let candidates = items;
  if (accountId) candidates = candidates.filter(item => item.id === accountId || item.alias === accountId);
  if (alias) candidates = candidates.filter(item => item.alias === alias);
  if (!accountId && !alias) candidates = candidates.filter(item => item.authenticated && item.connection === 'online');
  if (candidates.length !== 1) throw new Error('Exactly one online WeChat account must be selected');
  const account = candidates[0];
  if (!account.authenticated || account.connection !== 'online') throw new Error('Selected WeChat account is not online');
  if (!nonEmpty(account.id) || !nonEmpty(account.ownUsername)) throw new Error('Selected account lacks identity');
  return { accountId: account.id, alias: account.alias ?? account.id, selfUserId: account.ownUsername };
}

export function validateSendGate({ enabled, key, confirmation }) {
  if (enabled !== '1') throw new Error('Real sending requires SOCIOMEM_ENABLE_SEND=1 in the current process');
  if (!nonEmpty(key) || confirmation !== `SEND ${key}`) throw new Error('Exact send confirmation is required: SEND <draft-key>');
}
