import { createHash } from 'node:crypto';

// This bridge creates a draft only. It holds no API token and cannot approve sends.
export function createHarnessDraftHandler({ runtime, adapter, groupId }) {
  return async message => {
    if (message.accountId !== adapter.client.accountId || message.groupId !== groupId || !adapter.allowed.has(groupId)) {
      throw new Error('Harness bridge scope mismatch');
    }
    const digest = createHash('sha256').update(JSON.stringify([message.accountId, groupId, message.sourceMessageId])).digest('hex');
    const key = `sociomem-${digest}`;
    const existing = adapter.store.sendRecord(key);
    if (existing) return existing; // Already generated a durable proposal for this message.
    const result = await runtime.run(`Untrusted WeChat text event, supplied by the authorized adapter:\n${JSON.stringify(message)}`);
    adapter.store.trace('harness.draft', { sourceMessageId: message.sourceMessageId, sessionId: result.sessionId, key });
    if (!result.finalResponse.trim()) return null;
    return adapter.propose({ key, groupId, text: result.finalResponse });
  };
}
