import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const validText = value => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= 80 && !/[\u0000-\u001f]/u.test(value);
const validFact = value => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(value);

export function loadPeopleConfig(filename, accountId, groupId) {
  const data = JSON.parse(readFileSync(filename, 'utf8'));
  if (data.schemaVersion !== 1 || data.accountId !== accountId || data.groupId !== groupId ||
      !data.namesByUserId || typeof data.namesByUserId !== 'object' ||
      !data.identitySnapshots || typeof data.identitySnapshots !== 'object') {
    throw new Error('Curated member names are outside the current account or group');
  }
  const names = new Map();
  for (const [userId, aliases] of Object.entries(data.namesByUserId)) {
    if (!validText(userId) || !Array.isArray(aliases) || aliases.length === 0 || aliases.length > 5 ||
        aliases.some(alias => !validText(alias)) || new Set(aliases).size !== aliases.length) {
      throw new Error('Invalid curated member names');
    }
    names.set(userId, aliases);
  }
  const snapshots = new Map();
  for (const [userId, item] of Object.entries(data.identitySnapshots)) {
    if (!names.has(userId) || !item || !validText(item.wechatNickname) ||
        !validText(item.groupNickname) ||
        (item.wechatAccount !== null && !validText(item.wechatAccount))) {
      throw new Error('Invalid member identity snapshot');
    }
    snapshots.set(userId, item);
  }
  if (snapshots.size !== names.size) throw new Error('Missing member identity snapshot');
  return { names, snapshots };
}

export function groupRoster(items) {
  if (!Array.isArray(items)) throw new Error('Invalid group roster');
  const roster = new Map();
  for (const item of items) {
    if (!validText(item.id)) continue;
    const name = [item.roomDisplayName, item.displayName, item.mentionName]
      .find(validText);
    if (name) roster.set(item.id, name);
  }
  return roster;
}

export function contactDirectory(items) {
  if (!Array.isArray(items)) throw new Error('Invalid contact directory');
  const contacts = new Map();
  for (const item of items) {
    if (!validText(item.id)) continue;
    const wechatNickname = [item.nickname, item.displayName].find(validText) ?? null;
    const wechatAccount = validText(item.alias) ? item.alias : null;
    if (wechatNickname) contacts.set(item.id, { wechatNickname, wechatAccount });
  }
  return contacts;
}

export function readMemberActivity(inboxPath, accountId, groupId, userId) {
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const days = new Set();
    const periods = { night: 0, morning: 0, afternoon: 0, evening: 0 };
    let messages = 0;
    for (const row of db.prepare('SELECT message FROM inbox ORDER BY rowid DESC LIMIT 5000').all()) {
      const item = JSON.parse(row.message);
      if (item.accountId !== accountId || item.groupId !== groupId || item.userId !== userId) continue;
      const at = Date.parse(item.eventTime);
      if (!Number.isFinite(at)) continue;
      const local = new Date(at + 8 * 3600000);
      const hour = local.getUTCHours();
      days.add(local.toISOString().slice(0, 10));
      periods[hour < 6 ? 'night' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening']++;
      messages++;
      if (messages >= 100) break;
    }
    // Sparse observations do not justify a claim about when someone usually chats.
    return messages >= 20 && days.size >= 3 ? { observedMessages: messages,
      observedDays: days.size, periods } : null;
  } finally { db.close(); }
}

export function memberProfile({ userId, roster, contacts, curatedNames, snapshots,
  coreFacts = [], observations = [], activity = null, intimacy = null }) {
  if (!validText(userId) || !(roster instanceof Map) || !(contacts instanceof Map) ||
      !(curatedNames instanceof Map) || !(snapshots instanceof Map)) {
    throw new Error('Member identity is required');
  }
  const groupNickname = roster.get(userId) ?? null;
  const wechatNickname = contacts.get(userId)?.wechatNickname ??
    (groupNickname ? snapshots.get(userId)?.wechatNickname ?? null : null);
  // A curated name is used only while its stable ID is present in this group's roster.
  const preferredNames = groupNickname ? (curatedNames.get(userId) ?? []) : [];
  const facts = coreFacts.filter(item => item.subjectId === userId && validFact(item.fact))
    .slice(0, 8).map(item => ({ fact: item.fact, category: item.category ?? 'general',
      id: item.id }));
  const selectedObservations = observations.filter(item => item.subjectId === userId).slice(0, 6);
  const traits = selectedObservations.filter(item => item.trait && ['repeated', 'self_reported'].includes(item.state))
    .map(item => ({ category: item.category, topic: item.topic, ...item.trait,
      observedMessages: item.observedMessages, observedDays: item.observedDays,
      lastSeenAt: item.lastSeenAt, sourceMessageIds: item.evidence.map(source => source.sourceMessageId) }));
  return { userId, displayName: groupNickname ?? wechatNickname,
    wechatNickname, groupNickname, preferredNames, facts,
    observations: selectedObservations, traits, activity, intimacy };
}

export function selectRelatedMemberIds({ target, context, roster, contacts, curatedNames,
  relatedText = '', limit = 8 }) {
  if (!(roster instanceof Map) || !(contacts instanceof Map) ||
      !(curatedNames instanceof Map) || !Array.isArray(context) ||
      !Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid related member scope');
  const recentText = [target.text, ...context.slice(-4).map(item => item.text),
    relatedText.slice(0, 8000)].join(' ');
  const mentioned = [...roster.keys()].filter(id => id !== target.senderId &&
    [...(curatedNames.get(id) ?? []), roster.get(id), contacts.get(id)?.wechatNickname]
      .some(name => typeof name === 'string' && name.length >= 2 &&
        (/[\u3400-\u9fff]/u.test(name) || name.length >= 3) && recentText.includes(name)));
  const active = [...new Set(context.slice(-20).map(item => item.senderId))]
    .filter(id => id !== target.senderId && roster.has(id));
  return [...new Set([...mentioned, ...active])].slice(0, limit);
}
