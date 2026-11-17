import { createHash } from 'node:crypto';

export const CHAT_MAX_MESSAGES = 999;
export const CHAT_MAX_TOKENS = 120000;
export const CHAT_COMPACT_TOKENS = Math.floor(CHAT_MAX_TOKENS * 0.8);
export const CHAT_COMPACT_MESSAGES = Math.ceil(CHAT_MAX_MESSAGES * 0.8);
export const CHAT_CONTINUITY_MESSAGES = 80;

// Same conservative byte estimate used by the conversation prompt. This is
// a capacity estimate, not a provider's billed-token measurement.
export function estimateChatTokens(items) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(items.map(item => ({
    id: item.id, role: 'group_member',
    speakerKey: item.senderId ? `M_${createHash('sha256').update(item.senderId).digest('base64url').slice(0, 12)}` : null,
    name: item.speaker?.displayName ?? null, preferredNames: item.speaker?.preferredNames ?? [],
    text: item.text.slice(0, item.interaction === 'forwarded' ? 12000 : 2000), at: item.at,
    interaction: item.interaction ?? 'text', mentions: item.mentions ?? null,
    replyTo: item.quote ?? null,
  }))), 'utf8') / 2);
}

export function selectChatContext(items, { consolidatedThroughRowid = 0,
  tailMessages = CHAT_CONTINUITY_MESSAGES } = {}) {
  if (!Number.isSafeInteger(consolidatedThroughRowid) || consolidatedThroughRowid < 0 ||
      !Number.isSafeInteger(tailMessages) || tailMessages < 0) throw new Error('Invalid context checkpoint');
  const recent = items.slice(-CHAT_MAX_MESSAGES);
  if (consolidatedThroughRowid === 0) return recent;
  const tailStart = Math.max(0, recent.length - tailMessages);
  return recent.filter((item, index) => index >= tailStart || !Number.isSafeInteger(item.rowid) ||
    item.rowid > consolidatedThroughRowid);
}
