import { DatabaseSync } from 'node:sqlite';
import { matchTopics } from '../topics/lexicon.mjs';

// 具体游戏名/赛事名（≥3 字）一次就够；「旅游」「火锅」这类两字词要至少两条消息才算。
const isStrongTerm = term => term.length >= 3;

export function deriveMemberInterests({ inboxPath, accountId, groupId, now = Date.now(),
  days = 30, maxMessages = 3000 } = {}) {
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const since = now - days * 86400000;
    const byUser = new Map();
    for (const row of db.prepare(`SELECT message FROM inbox WHERE CASE WHEN json_valid(message)
      THEN json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=? ELSE 0 END
      ORDER BY rowid DESC LIMIT ?`).all(accountId, groupId, maxMessages)) {
      let item;
      try { item = JSON.parse(row.message); } catch { continue; }
      if (item.accountId !== accountId || item.groupId !== groupId) continue;
      if (typeof item.userId !== 'string' || !item.userId) continue;
      const at = Date.parse(item.eventTime);
      if (Number.isFinite(at) && at < since) continue;
      const text = typeof item.text === 'string' ? item.text : '';
      if (!text) continue;
      const hits = matchTopics(text);
      if (!hits.length) continue;
      let topics = byUser.get(item.userId);
      if (!topics) { topics = new Map(); byUser.set(item.userId, topics); }
      const counted = new Set();
      for (const { topic, term } of hits) {
        let entry = topics.get(topic);
        if (!entry) {
          entry = { topic, terms: new Set(), messages: 0, strong: false, lastAt: 0 };
          topics.set(topic, entry);
        }
        if (!counted.has(topic)) { entry.messages++; counted.add(topic); }
        entry.terms.add(term);
        if (isStrongTerm(term)) entry.strong = true;
        if (Number.isFinite(at)) entry.lastAt = Math.max(entry.lastAt, at);
      }
    }
    const result = new Map();
    for (const [userId, topics] of byUser) {
      const list = [...topics.values()]
        .filter(entry => entry.messages >= 2 || entry.strong)
        .sort((a, b) => b.messages - a.messages || b.lastAt - a.lastAt)
        .slice(0, 3)
        .map(entry => ({ topic: entry.topic, terms: [...entry.terms].slice(0, 4),
          messages: entry.messages, lastAt: entry.lastAt || null }));
      if (list.length) result.set(userId, list);
    }
    return result;
  } finally { db.close(); }
}

export function interestsFromFacts(facts = []) {
  const topics = new Map();
  for (const fact of Array.isArray(facts) ? facts : []) {
    if (fact?.category !== 'interest' || typeof fact.fact !== 'string') continue;
    for (const { topic, term } of matchTopics(fact.fact)) {
      let entry = topics.get(topic);
      if (!entry) { entry = { topic, terms: new Set() }; topics.set(topic, entry); }
      entry.terms.add(term);
    }
  }
  return [...topics.values()].map(entry => ({ topic: entry.topic,
    terms: [...entry.terms].slice(0, 4), messages: 0, lastAt: null }));
}

export function mergeInterests(derived = [], fromFacts = []) {
  const merged = new Map();
  for (const entry of [...derived, ...fromFacts]) {
    if (!entry?.topic) continue;
    const prior = merged.get(entry.topic);
    if (!prior) { merged.set(entry.topic, { ...entry, terms: [...(entry.terms ?? [])] }); continue; }
    prior.terms = [...new Set([...prior.terms, ...(entry.terms ?? [])])].slice(0, 4);
    prior.messages = Math.max(prior.messages ?? 0, entry.messages ?? 0);
    prior.lastAt = prior.lastAt ?? entry.lastAt ?? null;
  }
  return [...merged.values()].sort((a, b) => (b.messages ?? 0) - (a.messages ?? 0)).slice(0, 3);
}
