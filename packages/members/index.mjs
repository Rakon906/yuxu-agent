import { createHash } from 'node:crypto';
import { readInbox } from '../diary/index.mjs';
import { initProactiveLedger, proactiveOpportunity } from '../participation/proactive.mjs';
import { isNeedlesslyCruel } from '../participation/tone.mjs';

const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const short = value => String(value ?? '').replace(/[\u0000-\u001f]/gu, '').slice(0, 100);
const dailyLimit = () => {
  const value = Number(process.env.SOCIOMEM_PROACTIVE_MAX_PER_DAY ?? 2);
  return Number.isSafeInteger(value) && value >= 1 && value <= 4 ? value : 2;
};

/** Full roster observations only. Names are attributes, never identity keys. */
export class MemberTracker {
  constructor(db, { accountId, groupId, selfUserId }) {
    if (!accountId || !groupId || !selfUserId) throw new Error('Member scope required');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()) {
      const boundAccount = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
      if (boundAccount && boundAccount !== accountId) throw new Error('Member database account scope mismatch');
    }
    this.db = db; this.accountId = accountId; this.groupId = groupId; this.selfUserId = selfUserId;
    db.exec(`CREATE TABLE IF NOT EXISTS member_roster_state (
      account_id TEXT NOT NULL,group_id TEXT NOT NULL,observed_at INTEGER NOT NULL,
      PRIMARY KEY(account_id,group_id));
      CREATE TABLE IF NOT EXISTS member_identity_history (
      account_id TEXT NOT NULL,group_id TEXT NOT NULL,user_id TEXT NOT NULL,
      names TEXT NOT NULL,present INTEGER NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,
      missing_since INTEGER,generation INTEGER NOT NULL,PRIMARY KEY(account_id,group_id,user_id));
      CREATE TABLE IF NOT EXISTS member_welcomes (
      id TEXT PRIMARY KEY,account_id TEXT NOT NULL,group_id TEXT NOT NULL,user_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,confirmed INTEGER NOT NULL DEFAULT 0,state TEXT NOT NULL,
      outbox_key TEXT,reason TEXT,updated_at INTEGER NOT NULL);`);
  }
  observe({ roster, contacts = new Map(), complete = false, now = Date.now() }) {
    if (!complete || !(roster instanceof Map) || !roster.size || !Number.isFinite(now)) return { ignored: true };
    const scope = [this.accountId, this.groupId];
    const previous = this.db.prepare('SELECT * FROM member_roster_state WHERE account_id=? AND group_id=?').get(...scope);
    if (previous && now <= previous.observed_at) return { ignored: true };
    const all = this.db.prepare('SELECT * FROM member_identity_history WHERE account_id=? AND group_id=?').all(...scope);
    // A drastically incomplete native response must not create departure/rejoin storms.
    const active = all.filter(item => item.present === 1);
    if (active.length > 5 && roster.size < active.length / 2) return { ignored: true, reason: 'roster_shrank_abruptly' };
    const before = new Map(all.map(item => [item.user_id, item]));
    let joined = 0, renamed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [userId, groupName] of roster) {
        if (typeof userId !== 'string' || !userId || userId.length > 150) throw new Error('Invalid member ID');
        const old = before.get(userId);
        const contact = contacts.get(userId);
        const current = { groupNickname: short(groupName), wechatNickname: short(typeof contact === 'string' ? contact : contact?.wechatNickname ?? contact?.nickname ?? contact?.displayName),
          wechatAccount: short(contact?.wechatAccount), at: now };
        const names = old ? JSON.parse(old.names) : [];
        if (!names.length || names.at(-1).groupNickname !== current.groupNickname || names.at(-1).wechatNickname !== current.wechatNickname || names.at(-1).wechatAccount !== current.wechatAccount) {
          names.push(current); if (old) renamed++;
        }
        const isJoin = Boolean(previous && (!old || !old.present));
        const generation = (old?.generation ?? 0) + (isJoin ? 1 : 0);
        this.db.prepare(`INSERT INTO member_identity_history VALUES (?,?,?,?,?,?,?,?,?)
          ON CONFLICT(account_id,group_id,user_id) DO UPDATE SET names=excluded.names,present=1,
          last_seen=excluded.last_seen,missing_since=NULL,generation=excluded.generation`)
          .run(...scope, userId, JSON.stringify(names.slice(-20)), 1, old?.first_seen ?? now, now, null, generation);
        if (isJoin && userId !== this.selfUserId) {
          const id = hash([...scope, userId, generation]);
          this.db.prepare('INSERT INTO member_welcomes(id,account_id,group_id,user_id,joined_at,state,updated_at) VALUES (?,?,?,?,?,?,?)')
            .run(id, ...scope, userId, now, 'pending', now); joined++;
        } else if (old?.present && userId !== this.selfUserId) {
          this.db.prepare("UPDATE member_welcomes SET confirmed=1,updated_at=? WHERE account_id=? AND group_id=? AND user_id=? AND state='pending' AND joined_at<=?")
            .run(now, ...scope, userId, now - 60000);
        }
      }
      for (const old of active.filter(item => !roster.has(item.user_id))) {
        const departed = old.missing_since != null && now - old.missing_since >= 60000;
        this.db.prepare('UPDATE member_identity_history SET present=?,missing_since=? WHERE account_id=? AND group_id=? AND user_id=?')
          .run(departed ? 0 : 1, old.missing_since ?? now, ...scope, old.user_id);
        this.db.prepare("UPDATE member_welcomes SET confirmed=0,updated_at=? WHERE account_id=? AND group_id=? AND user_id=? AND state='pending'")
          .run(now, ...scope, old.user_id);
        if (departed) this.db.prepare("UPDATE member_welcomes SET state='skipped',reason='departed',updated_at=? WHERE account_id=? AND group_id=? AND user_id=? AND state='pending'")
          .run(now, ...scope, old.user_id);
      }
      this.db.prepare('INSERT INTO member_roster_state VALUES (?,?,?) ON CONFLICT(account_id,group_id) DO UPDATE SET observed_at=excluded.observed_at').run(...scope, now);
      this.db.exec('COMMIT');
      return { initialized: !previous, joined, renamed, members: roster.size };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  identity(userId) {
    const row = this.db.prepare('SELECT * FROM member_identity_history WHERE account_id=? AND group_id=? AND user_id=?').get(this.accountId, this.groupId, userId);
    if (!row) return null;
    const names = JSON.parse(row.names);
    return { present: row.present === 1, currentlyObserved: row.present === 1 && row.missing_since == null,
      firstObservedAt: new Date(row.first_seen).toISOString(),
      current: names.at(-1), previousNames: names.slice(0, -1).slice(-5), identitySource: 'stable_wechat_id' };
  }
  due(now = Date.now()) {
    this.db.prepare("UPDATE member_welcomes SET state='skipped',reason='expired',updated_at=? WHERE account_id=? AND group_id=? AND state='pending' AND joined_at<?")
      .run(now, this.accountId, this.groupId, now - 86400000);
    return this.db.prepare("SELECT * FROM member_welcomes WHERE account_id=? AND group_id=? AND state='pending' AND confirmed=1 ORDER BY joined_at LIMIT 1").get(this.accountId, this.groupId);
  }
  settle(id, state, reason, now = Date.now(), key = null) {
    this.db.prepare('UPDATE member_welcomes SET state=?,reason=?,updated_at=?,outbox_key=COALESCE(?,outbox_key) WHERE id=? AND account_id=? AND group_id=?')
      .run(state, reason, now, key, id, this.accountId, this.groupId);
  }
}

/** Event-driven welcome, sharing the existing proactive budget and normal persona. */
export async function runMemberWelcome({ tracker, ledger, adapter, model, inboxPath,
  accountId, groupId, lookupIdentity, sendEnabled = false, now = Date.now(), clock = Date.now }) {
  const startedAt = clock();
  if (tracker.accountId !== accountId || tracker.groupId !== groupId || ledger.store.accountId !== accountId ||
      adapter.client.accountId !== accountId || !adapter.allowed.has(groupId)) throw new Error('Welcome scope mismatch');
  initProactiveLedger(ledger);
  const window = proactiveOpportunity(now);
  const member = tracker.due(now);
  if (!sendEnabled || !window || !member) return { status: 'waiting' };
  const rows = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 30 });
  const last = rows.at(-1);
  if (last && (!Number.isFinite(Date.parse(last.at)) || now - Date.parse(last.at) < 90000)) return { status: 'waiting' };
  if (ledger.db.prepare("SELECT 1 FROM participation_tasks WHERE group_id=? AND state='pending' LIMIT 1").get(groupId)) return { status: 'waiting' };
  const lastSend = ledger.db.prepare('SELECT MAX(attempted_at) at FROM outbox WHERE group_id=?').get(groupId)?.at;
  if (lastSend != null && now - lastSend < 15 * 60000) return { status: 'waiting' };
  const used = ledger.db.prepare("SELECT COUNT(*) n FROM proactive_slots WHERE group_id=? AND local_date=? AND state IN ('sent','pending_receipt','needs_review','evaluating')").get(groupId, window.date).n;
  if (used >= dailyLimit()) return { status: 'waiting' };
  const key = `welcome:${member.id}`, slot = key;
  if (ledger.db.prepare('SELECT 1 FROM proactive_slots WHERE group_id=? AND slot=?').get(groupId, slot)) return { status: 'waiting' };
  tracker.settle(member.id, 'evaluating', null, now, key);
  ledger.db.prepare('INSERT INTO proactive_slots(group_id,local_date,slot,state,checked_at,baseline_rowid,outbox_key) VALUES (?,?,?,?,?,?,?)')
    .run(groupId, window.date, slot, 'evaluating', now, last?.rowid ?? 0, key);
  const finish = (state, reason) => {
    tracker.settle(member.id, state, reason, Date.now(), key);
    ledger.db.prepare('UPDATE proactive_slots SET state=?,reason=? WHERE group_id=? AND local_date=? AND slot=?').run(state, reason, groupId, window.date, slot);
    return { status: state, kind: 'member_welcome', key };
  };
  try {
    const identity = lookupIdentity(member.user_id);
    const decision = await model({ kind: 'member_welcome', mustReply: false,
      target: { id: key, senderId: member.user_id, text: '', at: new Date(now).toISOString(), sourceIds: [] },
      context: rows.map(item => ({ ...item, speaker: lookupIdentity(item.senderId) })),
      currentTime: { utc: new Date(now).toISOString(), timezone: 'Asia/Shanghai', local: window.local },
      initiative: { kind: 'member_welcome', member: { name: identity.displayName, preferredNames: identity.preferredNames ?? [] },
        instruction: '完整群名册连续两次确认有新成员，当前有空档。可以友善简短打个招呼，也可以沉默。如果最近已自然聊上或别人正在欢迎，就不重复欢迎。不编造认识经历、兴趣和邀请人；不要索要个人资料，不要@，不要客服式欢迎。' },
      coreFacts: [], latestDiary: null, relevantDiary: [], relatedProfiles: [], personProfile: identity,
      recentAgentReplies: ledger.recentAgentReplies(groupId, now), recentAgentMessages: ledger.recentAgentMessages(groupId, now),
      openTasks: [], toolResults: [], remainingToolCalls: 0 });
    const reply = typeof decision?.reply === 'string' ? decision.reply.trim() : '';
    if (!decision?.shouldReply || !reply || reply.length > 120 || /[\u0000-\u001f]|😂|【SocioMem/u.test(reply) ||
        isNeedlesslyCruel(reply) || decision.toolRequest || decision.mentionUserId || ledger.recentAgentReplies(groupId, now).includes(reply)) return finish('skipped', 'no_natural_welcome');
    const fresh = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0];
    const sendNow = now + Math.max(0, clock() - startedAt);
    const sendWindow = proactiveOpportunity(sendNow);
    const freshSend = ledger.db.prepare('SELECT MAX(attempted_at) at FROM outbox WHERE group_id=?').get(groupId)?.at;
    const freshQuota = ledger.db.prepare("SELECT COUNT(*) n FROM proactive_slots WHERE group_id=? AND local_date=? AND state IN ('sent','pending_receipt','needs_review','evaluating')").get(groupId, window.date).n;
    if (!sendWindow || sendWindow.date !== window.date || sendNow - now > 10 * 60000 ||
        (fresh?.rowid ?? 0) !== (last?.rowid ?? 0) || !tracker.identity(member.user_id)?.currentlyObserved ||
        (freshSend ?? null) !== (lastSend ?? null) ||
        freshQuota > dailyLimit() ||
        ledger.db.prepare("SELECT 1 FROM participation_tasks WHERE group_id=? AND state='pending' LIMIT 1").get(groupId)) return finish('skipped', 'context_changed');
    adapter.propose({ key, groupId, text: reply }); ledger.store.approve(key);
    const result = await adapter.sendApproved(key, AbortSignal.timeout(30000));
    return finish(result.state === 'accepted' ? 'sent' : ['queued', 'submitting'].includes(result.state) ? 'pending_receipt' : 'needs_review', result.state);
  } catch (error) { return finish(ledger.store.sendRecord(key)?.attempted_at != null ? 'needs_review' : 'skipped', error.name); }
}
