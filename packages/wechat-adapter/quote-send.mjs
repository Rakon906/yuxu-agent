// The daemon resolves quote XML itself. Never manufacture an embedded author or body.
const id = value => typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\u0000-\u001f]/u.test(value);
const revoked = message => Boolean(message?.recall || message?.recalled || message?.deleted ||
  message?.isRecalled || message?.isDeleted || ['recalled', 'deleted', 'revoked'].includes(message?.state));

export function validateQuoteReference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['messageId', 'serverId'].includes(key)) ||
      !id(value.messageId) || typeof value.serverId !== 'string' ||
      !/^[1-9]\d{0,19}$/u.test(value.serverId) || BigInt(value.serverId) > 18446744073709551615n) {
    throw new Error('Invalid quote reference');
  }
  return { messageId: value.messageId, serverId: value.serverId };
}

export function quoteReferenceFromInbox({ db, accountId, groupId, messageId, expectedSenderId = null }) {
  if (!db || !id(accountId) || !id(groupId) || !groupId.endsWith('@chatroom') || !id(messageId)) {
    throw new Error('Invalid quote source scope');
  }
  const owner = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
  if (owner !== accountId) throw new Error('Quote Inbox account mismatch');
  const row = db.prepare('SELECT message FROM inbox WHERE id=?').get(messageId);
  if (!row) throw new Error('Quote source unavailable');
  const source = JSON.parse(row.message);
  if (source.accountId !== accountId || source.groupId !== groupId ||
      source.sourceMessageId !== messageId || !id(source.userId) || revoked(source) ||
      (expectedSenderId !== null && source.userId !== expectedSenderId)) {
    throw new Error('Quote source identity or state mismatch');
  }
  return validateQuoteReference({ messageId, serverId: source.serverId });
}

export async function verifyQuoteReference({ client, accountId, groupId, quote, signal }) {
  const reference = validateQuoteReference(quote);
  if (!id(accountId) || !id(groupId) || !groupId.endsWith('@chatroom') || client?.accountId !== accountId) {
    throw new Error('Quote send account or group mismatch');
  }
  const message = await client.message(reference.messageId, signal);
  if (!message || message.id !== reference.messageId || message.accountId !== accountId ||
      message.threadId !== groupId || message.serverId !== reference.serverId || revoked(message)) {
    throw new Error('Quote target changed or became unavailable');
  }
  // A pat/system event has no supported quote body; unsupported content must stay plain text.
  if (![1, 3, 34, 43, 47, 49].includes(message.type)) throw new Error('Quote target type is unsupported');
  return reference;
}
