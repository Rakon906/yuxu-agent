import { createHash } from 'node:crypto';
import { readInbox } from '../diary/index.mjs';
import { matchTopics } from '../topics/lexicon.mjs';
import { selectConversationContext } from './index.mjs';
import { isNeedlesslyCruel } from './tone.mjs';
import { containsBlockedName } from './behavior-model.mjs';

const zone = 'Asia/Shanghai';
const firstMinute = 12 * 60;
const lastMinute = 24 * 60;
const nineStart = 21 * 60;
const nineEnd = 21 * 60 + 30;
const maxPostsPerDay = (() => {
  const value = Number(process.env.SOCIOMEM_PROACTIVE_MAX_PER_DAY ?? 2);
  return Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : 2;
})();
const localParts = now => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    local: `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}` };
};

export function proactiveOpportunity(now = Date.now()) {
  const local = localParts(now);
  if (local.minute < firstMinute || local.minute >= lastMinute) return null;
  return { ...local, name: local.minute >= nineStart && local.minute < nineEnd ? 'nine' : 'open' };
}

export function initProactiveLedger(ledger) {
  ledger.db.exec(`CREATE TABLE IF NOT EXISTS proactive_slots (
    group_id TEXT NOT NULL, local_date TEXT NOT NULL, slot TEXT NOT NULL,
    state TEXT NOT NULL, checked_at INTEGER NOT NULL, baseline_rowid INTEGER NOT NULL,
    reason TEXT, outbox_key TEXT, mention_user_id TEXT, followup_state TEXT,
    PRIMARY KEY(group_id,local_date,slot));
    CREATE TABLE IF NOT EXISTS proactive_schedule (
      group_id TEXT NOT NULL, local_date TEXT NOT NULL, next_due_at INTEGER NOT NULL,
      checks INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(group_id,local_date));`);
  const columns = new Set(ledger.db.prepare('PRAGMA table_info(proactive_slots)').all().map(row => row.name));
  if (!columns.has('mention_user_id')) ledger.db.exec('ALTER TABLE proactive_slots ADD COLUMN mention_user_id TEXT');
  if (!columns.has('followup_state')) ledger.db.exec('ALTER TABLE proactive_slots ADD COLUMN followup_state TEXT');
}

function nextDelay(accountId, groupId, date, checkNumber) {
  const hash = createHash('sha256').update(`${accountId}\0${groupId}\0${date}\0${checkNumber}`)
    .digest();
  return (45 + hash.readUInt16BE(0) % 51) * 60000;
}

const fingerprint = value => value.replace(/[\s，。！？!?、~～]+/gu, '').toLowerCase();
const liveSendStates = new Set(['accepted', 'queued', 'submitting', 'dispatching', 'needs_review']);

const EVENT_WORDS = /(比赛|赛事|决赛|半决赛|小组赛|总决赛|开赛|正赛)/u;
const SCHEDULE_GROUPS = [
  ['今晚', '今天晚上', '今儿晚上', '晚上'],
  ['明晚', '明天晚上', '明天', '明早'],
  ['周末', '这周末', '周六', '周日', '星期'],
  ['后天'],
];
// 热榜只有标题和摘要，没有赛程。回复里提到比赛又提到时间时，时间必须是群聊或热榜里真出现过的。
function unsupportedSchedule(reply, source) {
  if (!EVENT_WORDS.test(reply)) return false;
  for (const group of SCHEDULE_GROUPS) {
    const used = group.filter(word => reply.includes(word));
    if (!used.length) continue;
    if (!group.some(word => source.includes(word))) return true;
  }
  return false;
}

async function runIgnoredMention({ ledger, adapter, model, inboxPath, accountId, groupId,
  sendEnabled, now, date, local, lookupIdentity, lookupInteractionPreferences }) {
  const original = ledger.db.prepare(`SELECT p.*,o.attempted_at FROM proactive_slots p
    JOIN outbox o ON o.key=p.outbox_key WHERE p.group_id=? AND p.mention_user_id IS NOT NULL
    AND p.followup_state='waiting' AND p.state='sent' AND o.state='accepted'
    ORDER BY o.attempted_at LIMIT 1`).get(groupId);
  if (!original) return null;
  const rows = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 999 });
  if (rows.some(item => item.senderId === original.mention_user_id &&
      Date.parse(item.at) > original.attempted_at)) {
    ledger.db.prepare(`UPDATE proactive_slots SET followup_state='answered' WHERE group_id=?
      AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
    return { status: 'answered', slot: original.slot };
  }
  const elapsed = now - original.attempted_at;
  if (elapsed > 2 * 3600000) {
    ledger.db.prepare(`UPDATE proactive_slots SET followup_state='expired' WHERE group_id=?
      AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
    return { status: 'expired', slot: original.slot };
  }
  if (elapsed < 40 * 60000 || original.local_date !== date) return null;
  const latest = rows.at(-1);
  if (latest && now - Date.parse(latest.at) < 15 * 60000) return null;
  if (ledger.db.prepare(`SELECT 1 FROM participation_tasks WHERE group_id=? AND state='pending' LIMIT 1`)
    .get(groupId)) return null;
  const sentToday = ledger.db.prepare(`SELECT COUNT(*) AS n FROM proactive_slots WHERE group_id=?
    AND local_date=? AND state IN ('sent','pending_receipt','needs_review')`).get(groupId, date).n;
  if (sentToday >= maxPostsPerDay) return null;
  const slot = `followup:${original.slot}`;
  const baseline = latest?.rowid ?? 0;
  const key = `proactive:${createHash('sha256').update(`${accountId}\0${groupId}\0${date}\0${slot}`)
    .digest('hex')}`;
  ledger.store.transaction(() => {
    ledger.db.prepare(`INSERT INTO proactive_slots
      (group_id,local_date,slot,state,checked_at,baseline_rowid)
      VALUES (?,?,?,?,?,?)`).run(groupId, date, slot, 'evaluating', now, baseline);
    ledger.db.prepare(`UPDATE proactive_slots SET followup_state='evaluating' WHERE group_id=?
      AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
  });
  try {
    const context = selectConversationContext(rows, now).slice(-100).map(item => ({ ...item,
      speaker: lookupIdentity(item.senderId) }));
    const originalText = ledger.store.sendRecord(original.outbox_key)?.text ?? '';
    const identity = lookupIdentity(original.mention_user_id);
    const target = { id: slot, senderId: original.mention_user_id, text: '', at: new Date(now).toISOString(), sourceIds: [],
      mentions: { state: 'none', self: false, userIds: [] } };
    const decision = await model({ target, context, kind: 'proactive_followup', mustReply: false,
      currentTime: { utc: new Date(now).toISOString(), timezone: zone, local },
      initiative: { slot, ignoredMention: { name: identity.displayName ?? '群友',
        preferredNames: identity.preferredNames ?? [], originalText,
        elapsedMinutes: Math.floor(elapsed / 60000) },
        instruction: '之前主动@的人没有在群里发言。可自嘲或自然收尾，也可沉默；不要再次@、追着人问或拿对方不回复开嘲讽。' },
      coreFacts: [], latestDiary: null, relevantDiary: [],
      relatedProfiles: [{ ...identity, userId: original.mention_user_id }], personProfile: null,
      recentAgentReplies: ledger.recentAgentReplies(groupId, now),
      recentAgentMessages: ledger.recentAgentMessages(groupId, now),
      openTasks: [], toolResults: [], remainingToolCalls: 0 });
    const reply = typeof decision?.reply === 'string' ? decision.reply.trim() : '';
    const fresh = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0];
    const valid = decision?.shouldReply === true && !decision.mentionUserId && !decision.toolRequest &&
      !decision.task && reply && reply.length <= 120 && !/😂/u.test(reply) &&
      !isNeedlesslyCruel(reply) &&
      !ledger.recentAgentReplies(groupId, now).some(text => fingerprint(text) === fingerprint(reply)) &&
      (fresh?.rowid ?? 0) === baseline;
    if (!valid) {
      ledger.db.prepare(`UPDATE proactive_slots SET state='skipped',reason=? WHERE group_id=?
        AND local_date=? AND slot=?`).run('no_natural_followup_or_conversation_changed', groupId, date, slot);
      ledger.db.prepare(`UPDATE proactive_slots SET followup_state='skipped' WHERE group_id=?
        AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
      return { status: 'skipped', slot };
    }
    if (!sendEnabled) {
      ledger.db.prepare(`UPDATE proactive_slots SET state='shadowed' WHERE group_id=?
        AND local_date=? AND slot=?`).run(groupId, date, slot);
      ledger.db.prepare(`UPDATE proactive_slots SET followup_state='shadowed' WHERE group_id=?
        AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
      return { status: 'shadowed', slot, reply };
    }
    adapter.propose({ key, groupId, text: reply });
    ledger.store.approve(key);
    const subjects = [...new Set([original.mention_user_id, ...context.map(item => item.senderId)].filter(Boolean))];
    const receipt = await adapter.sendApproved(key, AbortSignal.timeout(30000), {
      authorize: () => !subjects.some(userId => containsBlockedName(reply, lookupInteractionPreferences(userId))) });
    const state = receipt.state === 'accepted' ? 'sent' : 'needs_review';
    ledger.db.prepare(`UPDATE proactive_slots SET state=?,outbox_key=?,reason=? WHERE group_id=?
      AND local_date=? AND slot=?`).run(state, key, receipt.state, groupId, date, slot);
    ledger.db.prepare(`UPDATE proactive_slots SET followup_state='done' WHERE group_id=?
      AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
    return { status: state, slot, key };
  } catch (error) {
    ledger.db.prepare(`UPDATE proactive_slots SET state='failed',reason=?,outbox_key=? WHERE group_id=?
      AND local_date=? AND slot=?`).run(error.name, ledger.store.sendRecord(key) ? key : null,
        groupId, date, slot);
    ledger.db.prepare(`UPDATE proactive_slots SET followup_state='failed' WHERE group_id=?
      AND local_date=? AND slot=?`).run(groupId, original.local_date, original.slot);
    throw error;
  }
}

export async function runProactiveCycle({ ledger, adapter, model, inboxPath, accountId, groupId,
  sendEnabled, now = Date.now(), lookupIdentity = () => ({}), routineMember = null,
  latestDiary = null, memberCandidates = [], trendTopics = [], memberInterests = new Map(),
  lookupInteractionPreferences = () => ({}) }) {
  initProactiveLedger(ledger);
  const awaiting = ledger.db.prepare(`SELECT slot,local_date,outbox_key,checked_at FROM proactive_slots
    WHERE group_id=? AND state='pending_receipt' ORDER BY checked_at LIMIT 1`).get(groupId);
  if (awaiting && now - awaiting.checked_at >= 60000) {
    const receipt = await adapter.reconcile(awaiting.outbox_key, AbortSignal.timeout(30000));
    const state = receipt.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(receipt.state) ? 'pending_receipt' : 'needs_review';
    ledger.db.prepare(`UPDATE proactive_slots SET state=?,reason=?,checked_at=? WHERE group_id=?
      AND local_date=? AND slot=?`).run(state, receipt.state, now,
      groupId, awaiting.local_date, awaiting.slot);
    return { status: state, slot: awaiting.slot, key: awaiting.outbox_key };
  }
  const opportunity = proactiveOpportunity(now);
  if (!opportunity) return { status: 'waiting' };
  const { date, local } = opportunity;
  const ignored = await runIgnoredMention({ ledger, adapter, model, inboxPath, accountId,
    groupId, sendEnabled, now, date, local, lookupIdentity, lookupInteractionPreferences });
  if (ignored) return ignored;
  let { name } = opportunity;
  if (name === 'open') {
    ledger.db.prepare(`INSERT OR IGNORE INTO proactive_schedule
      (group_id,local_date,next_due_at) VALUES (?,?,?)`).run(groupId, date, now);
    const schedule = ledger.db.prepare(`SELECT next_due_at,checks FROM proactive_schedule
      WHERE group_id=? AND local_date=?`).get(groupId, date);
    if (schedule.checks >= 6 || now < schedule.next_due_at) return { status: 'waiting' };
    name = `open:${schedule.checks + 1}`;
  }
  const prior = ledger.db.prepare(`SELECT * FROM proactive_slots WHERE group_id=? AND local_date=? AND slot=?`)
    .get(groupId, date, name);
  if (prior) return { status: 'waiting' };
  const rows = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 999 });
  const latest = rows.at(-1);
  const latestAt = latest ? Date.parse(latest.at) : NaN;
  if (latest && (!Number.isFinite(latestAt) || latestAt > now + 60000)) return { status: 'waiting' };
  // Let the active conversation and inbound answer obligations finish first.
  if (latest && now - latestAt < 15 * 60000) return { status: 'waiting' };
  const pending = ledger.db.prepare(`SELECT 1 FROM participation_tasks WHERE group_id=?
    AND state='pending' LIMIT 1`).get(groupId);
  if (pending) return { status: 'waiting' };
  const last = ledger.db.prepare(`SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=?
    AND state IN ('accepted','queued','submitting','dispatching','needs_review')`).get(groupId)?.at;
  if (last !== null && last !== undefined && now - last < 75 * 60000) return { status: 'waiting' };
  const sentToday = ledger.db.prepare(`SELECT COUNT(*) AS n FROM proactive_slots WHERE group_id=?
    AND local_date=? AND state IN ('sent','pending_receipt','needs_review')`).get(groupId, date).n;
  if (sentToday >= maxPostsPerDay) return { status: 'waiting' };
  const baseline = latest?.rowid ?? 0;
  const recent = selectConversationContext(rows, now).slice(-160).map(item => ({ ...item,
    speaker: lookupIdentity(item.senderId) }));
  const userRoutine = name === 'nine' && routineMember ? {
    person: routineMember.displayName ?? '群友', preferredName: routineMember.preferredNames?.[0] ?? routineMember.displayName ?? null,
    accountOwnerObservation: process.env.SOCIOMEM_ROUTINE_NOTE ?? '这是使用者配置的可选活动时段。',
    caution: '这只是习惯线索，不表示对方现在在线或今天一定参加。',
  } : null;
  const recentAgentReplies = ledger.recentAgentReplies(groupId, now);
  // 热榜只当背景引子：标题已在这个时段说过的不再重复。
  const trendContext = (Array.isArray(trendTopics) ? trendTopics : [])
    .filter(item => item && typeof item.title === 'string' && item.title)
    .filter(item => !recentAgentReplies.some(text => fingerprint(text) === fingerprint(item.title)))
    .slice(0, 3)
    .map(item => ({ title: item.title.slice(0, 120),
      summary: String(item.summary ?? '').slice(0, 160),
      topic: item.topic ?? null, category: item.category ?? null,
      source: item.source ?? null, lastSeenAt: item.lastSeenAt ?? null }));
  // 只允许引用群聊或热榜里确实出现过的时间词，避免把热榜脑补成“今晚开赛”。
  const scheduleSource = [...recent.slice(-30).map(item => item.text),
    ...trendContext.flatMap(item => [item.title, item.summary])].join(' ');
  const topicPool = new Set([
    ...matchTopics(recent.slice(-10).map(item => item.text).join(' ')).map(hit => hit.topic),
    ...trendContext.flatMap(item => [item.topic, item.category]).filter(Boolean),
  ]);
  const candidates = memberCandidates.filter(item => typeof item.userId === 'string' && item.userId &&
    typeof item.displayName === 'string' && item.displayName &&
    !lookupInteractionPreferences(item.userId).proactiveMentionDisabled)
    .map(item => {
      const interests = (memberInterests.get(item.userId) ?? item.interests ?? []).slice(0, 3);
      const score = interests.filter(interest => topicPool.has(interest.topic)).length;
      return { userId: item.userId, name: item.displayName,
        preferredNames: item.preferredNames ?? [], interests, score };
    })
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 30)
    .map(({ score, ...item }) => item);
  const target = { id: `proactive:${date}:${name}`, text: '', at: new Date(now).toISOString(),
    mentions: { state: 'none', self: false, userIds: [] }, sourceIds: [] };
  // Claim before the model request so a restart cannot produce the same slot twice.
  ledger.store.transaction(() => {
    if (name.startsWith('open:')) {
      const checkNumber = Number(name.slice(5));
      ledger.db.prepare(`UPDATE proactive_schedule SET checks=?,next_due_at=?
        WHERE group_id=? AND local_date=? AND checks=?`)
        .run(checkNumber, now + nextDelay(accountId, groupId, date, checkNumber),
          groupId, date, checkNumber - 1);
    }
    ledger.db.prepare(`INSERT INTO proactive_slots
      (group_id,local_date,slot,state,checked_at,baseline_rowid) VALUES (?,?,?,?,?,?)`)
      .run(groupId, date, name, 'evaluating', now, baseline);
  });
  const key = `proactive:${createHash('sha256').update(`${accountId}\0${groupId}\0${date}\0${name}`)
    .digest('hex')}`;
  try {
    const decision = await model({ target, context: recent, kind: 'proactive', mustReply: false,
      memorySubjectIds: candidates.filter(item => item.interests.some(interest => topicPool.has(interest.topic)))
        .slice(0, 3).map(item => item.userId),
      currentTime: { utc: new Date(now).toISOString(), timezone: zone, local },
      trendContext,
      initiative: { slot: name, routine: userRoutine, proactivePostsToday: sentToday,
        mentionCandidates: candidates,
        instruction: `每天最多主动开口${maxPostsPerDay}次，没有合适内容就不发，一次也不发可以。优先聊游戏（英雄联盟、瓦罗兰特、三角洲、热门单机）、电竞赛事、旅游、美食；有 trendContext 就挑一条具体、和群友兴趣对得上的热点当引子，它只是背景不是确定事实，不假称实时新闻，也不要给热榜补赛程或时间（条目里没有开赛日期，不能说今晚/周末有比赛，时间只能来自 currentTime 或群聊里明确说过的内容）；没有就聊群里刚出现的相关话题。mentionCandidates 的 interests 是从群聊推断的兴趣，只有和你要聊的话题对得上时才用 mentionUserId 真正@他，对不上或没有 interests 就不要@，也不要反复打扰同一人。` },
      coreFacts: [], latestDiary, relevantDiary: [], recentAgentReplies,
      recentAgentMessages: ledger.recentAgentMessages(groupId, now), openTasks: [],
      relatedProfiles: userRoutine && routineMember ? [routineMember] : [], personProfile: null,
      toolResults: [], remainingToolCalls: 0 });
    const reply = typeof decision?.reply === 'string' ? decision.reply.trim() : '';
    const mentionUserId = decision?.mentionUserId ?? null;
    const chosen = mentionUserId === null ? null
      : candidates.find(item => item.userId === mentionUserId) ?? null;
    // 有推断兴趣的人必须和当前话题对得上才 @；没有兴趣数据的老成员保持旧行为。
    const interestsMatch = !chosen || chosen.interests.length === 0 ||
      chosen.interests.some(interest => topicPool.has(interest.topic));
    const validMention = mentionUserId === null || (chosen !== null && interestsMatch);
    const recentlyMentioned = mentionUserId !== null && !!ledger.db.prepare(`SELECT 1 FROM proactive_slots
      WHERE group_id=? AND mention_user_id=? AND checked_at>=? AND state IN ('sent','pending_receipt','needs_review')
      LIMIT 1`).get(groupId, mentionUserId, now - 3 * 86400000);
    const scheduleUnsupported = unsupportedSchedule(reply, scheduleSource);
    if (decision?.shouldReply !== true || decision.toolRequest || decision.task ||
        !validMention || recentlyMentioned || !reply || reply.length > 120 || /😂/u.test(reply) ||
        isNeedlesslyCruel(reply) || scheduleUnsupported ||
        /(?:我是|作为)(?:AI|人工智能|机器人)|【SocioMem/u.test(reply) ||
        recentAgentReplies.some(text => fingerprint(text) === fingerprint(reply))) {
      const reason = scheduleUnsupported ? 'unsupported_schedule'
        : (decision?.reason ?? 'no_suitable_topic');
      ledger.db.prepare(`UPDATE proactive_slots SET state='skipped',reason=? WHERE group_id=? AND local_date=? AND slot=?`)
        .run(reason, groupId, date, name);
      return { status: 'skipped', slot: name };
    }
    // A fresh inbound message or an outbound reply changes the social moment.
    const fresh = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0];
    const newerSend = ledger.db.prepare(`SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=?`)
      .get(groupId)?.at;
    if ((fresh?.rowid ?? 0) !== baseline || (newerSend !== null && newerSend !== undefined && newerSend > now)) {
      ledger.db.prepare(`UPDATE proactive_slots SET state='skipped',reason='conversation_changed'
        WHERE group_id=? AND local_date=? AND slot=?`).run(groupId, date, name);
      return { status: 'skipped', slot: name };
    }
    if (!sendEnabled) {
      ledger.db.prepare(`UPDATE proactive_slots SET state='shadowed',reason=?
        WHERE group_id=? AND local_date=? AND slot=?`).run(decision.reason ?? '', groupId, date, name);
      return { status: 'shadowed', slot: name, reply };
    }
    adapter.propose({ key, groupId, text: reply,
      mentionUserIds: mentionUserId === null ? [] : [mentionUserId] });
    ledger.store.approve(key);
    const subjects = [...new Set([routineMember?.userId, ...candidates.map(item => item.userId),
      ...recent.map(item => item.senderId)].filter(Boolean))];
    const receipt = await adapter.sendApproved(key, AbortSignal.timeout(30000), {
      authorize: () => (mentionUserId === null || !lookupInteractionPreferences(mentionUserId).proactiveMentionDisabled) &&
        !subjects.some(userId => containsBlockedName(reply, lookupInteractionPreferences(userId))) });
    const state = receipt.state === 'accepted' ? 'sent' :
      liveSendStates.has(receipt.state) ? 'pending_receipt' : 'needs_review';
    ledger.db.prepare(`UPDATE proactive_slots SET state=?,reason=?,outbox_key=?,mention_user_id=?,followup_state=?
      WHERE group_id=? AND local_date=? AND slot=?`)
      .run(state, receipt.state, key, mentionUserId, mentionUserId ? 'waiting' : null,
        groupId, date, name);
    return { status: state, slot: name, key };
  } catch (error) {
    ledger.db.prepare(`UPDATE proactive_slots SET state='failed',reason=?,outbox_key=?
      WHERE group_id=? AND local_date=? AND slot=?`)
      .run(error.name, ledger.store.sendRecord(key) ? key : null, groupId, date, name);
    throw error;
  }
}
