import { createHash } from 'node:crypto';
import { readInbox } from '../diary/index.mjs';
import { selectConversationContext } from '../participation/index.mjs';
import { initProactiveLedger, proactiveOpportunity } from '../participation/proactive.mjs';
import { isNeedlesslyCruel } from '../participation/tone.mjs';
import { validateOfficialReply } from '../subscriptions/index.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fp = text => text.normalize('NFKC').replace(/[\p{P}\p{S}\s]/gu, '').toLowerCase();
const cap = () => Math.max(1, Math.min(4, Number(process.env.SOCIOMEM_PROACTIVE_MAX_PER_DAY) || 2));
const scoped = (accountId, groupId) => ({ accountId, groupId });

/** Incremental local extraction: initial installation starts at the current Inbox end. */
export function collectLifeEvents({ events, ledger, inboxPath, accountId, groupId, now = Date.now() }) {
  const key = `life-events:cursor:${groupId}`;
  const prior = ledger.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
  if (!prior) {
    const last = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0]?.rowid ?? 0;
    ledger.db.prepare('INSERT INTO meta(key,value) VALUES (?,?)').run(key, String(last));
    return { initialized: true, processed: 0 };
  }
  const messages = readInbox(inboxPath, { accountId, groupId, afterRowid: Number(prior.value), limit: 256 });
  if (!messages.length) return { processed: 0 };
  const result = events.ingest({ accountId, groupId, messages, now });
  ledger.db.prepare('UPDATE meta SET value=? WHERE key=?').run(String(messages.at(-1).rowid), key);
  return { processed: messages.length, result };
}

/** Both new kinds consume the existing proactive_slots budget, never a second send quota. */
export async function runSocialInitiative({ events, subscriptions, ledger, adapter, model,
  inboxPath, accountId, groupId, lookupIdentity = () => ({}), sendEnabled = false,
  now = Date.now() }) {
  if (adapter.client.accountId !== accountId || ledger.store.accountId !== accountId ||
      !adapter.allowed.has(groupId)) throw new Error('Initiative scope mismatch');
  initProactiveLedger(ledger);
  const scope = scoped(accountId, groupId);
  const startedAt = performance.now();
  const currentNow = () => now + Math.max(0, Math.floor(performance.now() - startedAt));
  events?.maintain({ ...scope, inboxPath, now });
  // Reconcile only; an uncertain send is never turned into a fresh request.
  for (const event of events?.pendingReceipts(scope) ?? []) {
    if (!event.outboxKey || now - event.updatedAt < 60000) continue;
    const row = ledger.store.sendRecord(event.outboxKey);
    if (!row || row.state === 'draft') continue;
    const receipt = await adapter.reconcile(event.outboxKey, AbortSignal.timeout(30000));
    const state = receipt.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(receipt.state) ? 'pending_receipt' : 'needs_review';
    events.settle({ ...scope, id: event.id, claimKey: event.claimKey, state, now });
    ledger.db.prepare('UPDATE proactive_slots SET state=?,reason=? WHERE outbox_key=?')
      .run(state, receipt.state, event.outboxKey);
  }
  for (const item of subscriptions?.pendingReceipts({ ...scope, now }) ?? []) {
    if (!item.outboxKey || now - item.updatedAt < 60000) continue;
    const row = ledger.store.sendRecord(item.outboxKey);
    if (!row || row.state === 'draft') continue;
    const receipt = await adapter.reconcile(item.outboxKey, AbortSignal.timeout(30000));
    const state = receipt.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(receipt.state) ? 'pending_receipt' : 'needs_review';
    subscriptions.settle(item.deliveryKey, { ...scope, ownerKey: item.ownerKey, outboxKey: item.outboxKey, state, now });
    ledger.db.prepare('UPDATE proactive_slots SET state=?,reason=? WHERE outbox_key=?').run(state, receipt.state, item.outboxKey);
  }
  const opportunity = proactiveOpportunity(now);
  if (!opportunity || !sendEnabled) return { status: 'waiting' };
  const rows = readInbox(inboxPath, { ...scope, recent: true, limit: 999 });
  const last = rows.at(-1);
  if (last && (!Number.isFinite(Date.parse(last.at)) || now - Date.parse(last.at) < 15 * 60000)) return { status: 'waiting' };
  if (ledger.db.prepare("SELECT 1 FROM participation_tasks WHERE group_id=? AND state='pending' LIMIT 1").get(groupId)) return { status: 'waiting' };
  const lastSent = ledger.db.prepare('SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=?').get(groupId)?.at;
  if (lastSent != null && now - lastSent < 75 * 60000) return { status: 'waiting' };
  const used = ledger.db.prepare("SELECT COUNT(*) n FROM proactive_slots WHERE group_id=? AND local_date=? AND state IN ('sent','pending_receipt','needs_review','evaluating')")
    .get(groupId, opportunity.date).n;
  if (used >= cap()) return { status: 'waiting' };
  let event = events?.due({ ...scope, now, limit: 1 })?.[0];
  const news = !event ? subscriptions?.candidates({ ...scope, now, limit: 1 })?.[0] : null;
  if (!event && !news) return { status: 'waiting' };
  const kind = event ? 'life_event' : 'interest_update';
  const slot = `${kind}:${digest(event ? [event.id, event.revision] : [news.deliveryKey]).slice(0, 32)}`;
  const key = `social:${digest([accountId, groupId, slot])}`;
  if (ledger.db.prepare('SELECT 1 FROM proactive_slots WHERE group_id=? AND slot=?').get(groupId, slot)) return { status: 'waiting' };
  if (event) {
    event = events.claim({ ...scope, id: event.id, revision: event.revision, inboxPath, now });
    if (!event) return { status: 'waiting' };
  } else if (!subscriptions.claim(news, { ...scope, ownerKey: key, now })) return { status: 'waiting' };
  const finish = (state, reason) => {
    ledger.db.prepare('UPDATE proactive_slots SET state=?,reason=? WHERE group_id=? AND local_date=? AND slot=?')
      .run(state, reason, groupId, opportunity.date, slot);
    if (event) events.settle({ ...scope, id: event.id, claimKey: event.claimKey, state, reason, now: currentNow() });
    else subscriptions.settle(news.deliveryKey, { ...scope, state, outboxKey: key, ownerKey: key, now: currentNow() });
    return { status: state, kind, slot, key };
  };
  try {
    ledger.db.prepare('INSERT INTO proactive_slots(group_id,local_date,slot,state,checked_at,baseline_rowid,outbox_key) VALUES (?,?,?,?,?,?,?)')
      .run(groupId, opportunity.date, slot, 'evaluating', now, last?.rowid ?? 0, key);
    const context = selectConversationContext(rows, now).slice(-160).map(item => ({ ...item, speaker: lookupIdentity(item.senderId) }));
    const identity = event ? lookupIdentity(event.subjectId) : null;
    const decision = await model({ kind, mustReply: false,
      target: { id: slot, senderId: event?.subjectId ?? null, text: '', at: new Date(now).toISOString(), sourceIds: [] }, context,
      currentTime: { utc: new Date(now).toISOString(), timezone: 'Asia/Shanghai', local: opportunity.local },
      initiative: { kind, event: event ? { id: event.id, kind: event.kind, topic: event.topic,
        name: identity?.displayName, preferredNames: identity?.preferredNames ?? [],
        eventAt: event.eventAt, evidenceQuote: event.evidenceQuote, sourceMessageId: event.sourceMessageId } : null,
        officialUpdate: news,
        instruction: event ? '朋友之前明确说过这件事，现在到了适合跟进的时间。先看最近聊天是否已经说过结果；有结果或不适合就沉默。可自然问一句，别假设结果、别催促，不提后台记录或提醒系统。不需要@。生日可以祝福。' :
          '这是订阅的官方更新，不是热搜推测。只按提供的日期、比赛状态和内容聊一句；未证实进行中不能说正在比赛。没有自然话题就沉默，不照搬公告或假称自己亲身参加。不需要@。' },
      coreFacts: [], latestDiary: null, relevantDiary: [], relatedProfiles: [], personProfile: null,
      recentAgentReplies: ledger.recentAgentReplies(groupId, now), recentAgentMessages: ledger.recentAgentMessages(groupId, now),
      openTasks: [], toolResults: [], remainingToolCalls: 0 });
    const reply = typeof decision?.reply === 'string' ? decision.reply.trim() : '';
    if (decision?.shouldReply !== true || !reply || reply.length > 160 ||
        /[\u0000-\u001f]|😂|【SocioMem/u.test(reply) || isNeedlesslyCruel(reply) ||
        decision.toolRequest || decision.mentionUserId || (news && !validateOfficialReply(reply, news, { now: currentNow() })) ||
        ledger.recentAgentReplies(groupId, now).some(x => fp(x) === fp(reply))) {
      return finish('skipped', 'no_suitable_followup');
    }
    const fresh = readInbox(inboxPath, { ...scope, recent: true, limit: 1 })[0];
    if (proactiveOpportunity(currentNow())?.date !== opportunity.date) return finish('skipped', 'window_closed');
    const newerSend = ledger.db.prepare('SELECT MAX(attempted_at) at FROM outbox WHERE group_id=?').get(groupId)?.at;
    if ((fresh?.rowid ?? 0) !== (last?.rowid ?? 0) || newerSend > now) return finish('skipped', 'conversation_changed');
    if (event) {
      events.maintain({ ...scope, inboxPath, now: currentNow() });
      const current = events.list({ ...scope, states: ['evaluating'], limit: 100 }).find(x => x.id === event.id && x.revision === event.revision);
      if (!current) return finish('skipped', 'source_or_event_changed');
    } else if (!subscriptions.validateClaim(news, { ...scope, ownerKey: key, now: currentNow() })) {
      return finish('skipped', 'subscription_or_source_changed');
    }
    adapter.propose({ key, groupId, text: reply });
    ledger.store.approve(key);
    if (event && !events.beginDispatch({ ...scope, id: event.id, claimKey: event.claimKey, outboxKey: key, inboxPath, now: currentNow() })) return finish('skipped', 'event_no_longer_due');
    const receipt = await adapter.sendApproved(key, AbortSignal.timeout(30000));
    return finish(receipt.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(receipt.state) ? 'pending_receipt' : 'needs_review', receipt.state);
  } catch (error) {
    const attempted = ledger.store.sendRecord(key)?.attempted_at != null;
    finish(attempted ? 'needs_review' : 'skipped', error.name);
    ledger.store.trace('social.initiative_error', { kind, errorType: error.name });
    return { status: attempted ? 'needs_review' : 'skipped', kind, slot, key };
  }
}
