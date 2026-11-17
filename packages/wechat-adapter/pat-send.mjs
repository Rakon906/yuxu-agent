import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const id = value => typeof value === 'string' && /^[a-zA-Z0-9_.@-]{1,128}$/u.test(value);
const group = value => id(value) && value.endsWith('@chatroom');

export function ensurePatSendTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS pat_sends (
    key TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
    target_id TEXT NOT NULL, source_id TEXT NOT NULL, kind TEXT NOT NULL,
    state TEXT NOT NULL, attempted_at INTEGER NOT NULL, receipt TEXT,
    UNIQUE(account_id,group_id,source_id)
  ); CREATE INDEX IF NOT EXISTS pat_sends_cooldown ON pat_sends(account_id,group_id,attempted_at);`);
}

export function patSendKey(accountId, groupId, targetUserId, sourceId) {
  return `sociomem-pat-${createHash('sha256').update(JSON.stringify([
    accountId, groupId, targetUserId, sourceId,
  ])).digest('hex').slice(0, 40)}`;
}

function result(row) {
  return { key: row.key, state: row.state, kind: row.kind, groupId: row.group_id,
    targetUserId: row.target_id, sourceId: row.source_id,
    receipt: row.receipt ? JSON.parse(row.receipt) : null };
}

function checkedReceipt(value, row) {
  if (value?.accountId !== row.account_id || value?.groupId !== row.group_id ||
      value?.targetUserId !== row.target_id || value?.clientId !== row.key ||
      !Number.isSafeInteger(value?.baseCode)) return null;
  const positiveId = typeof value.messageId === 'string' && /^[1-9][0-9]{0,19}$/u.test(value.messageId)
    && BigInt(value.messageId) <= 18446744073709551615n;
  return { state: value.baseCode !== 0 ? 'failed'
    : value.state === 'accepted' && positiveId ? 'accepted' : 'needs_review',
  receipt: { accountId: row.account_id, groupId: row.group_id, targetUserId: row.target_id,
    clientId: row.key, baseCode: value.baseCode, messageId: positiveId ? value.messageId : null } };
}

/** Same-account native pat gateway. No fabricated text/system message fallback. */
export class PatSender {
  constructor({ db, sourceDb = null, inboxPath = null, client, selfUserId, allowedGroups, getMemberIds,
    botUserIds = [], groupCooldownMs = 10 * 60000, targetCooldownMs = 60 * 60000,
    maxPerDay = 8, authorize = () => true }) {
    if (!db?.prepare || !id(client?.accountId) || typeof client.request !== 'function' ||
        !id(selfUserId) || selfUserId.endsWith('@chatroom') ||
        typeof getMemberIds !== 'function' || typeof authorize !== 'function') throw new Error('Invalid pat gateway');
    this.allowedGroups = new Set(allowedGroups);
    if (!this.allowedGroups.size || [...this.allowedGroups].some(value => !group(value))) throw new Error('Invalid pat groups');
    if (![groupCooldownMs, targetCooldownMs].every(value => Number.isSafeInteger(value) && value >= 60000) ||
        !Number.isSafeInteger(maxPerDay) || maxPerDay < 1 || maxPerDay > 20) throw new Error('Invalid pat limits');
    Object.assign(this, { db, client, selfUserId, getMemberIds, groupCooldownMs, targetCooldownMs, maxPerDay, authorize });
    if (sourceDb && inboxPath) throw new Error('Use sourceDb or inboxPath, not both');
    this.sourceDb = sourceDb ?? (inboxPath ? new DatabaseSync(inboxPath, { readOnly: true }) : db);
    this.ownsSourceDb = Boolean(inboxPath);
    this.botUserIds = new Set([selfUserId, ...botUserIds]);
    ensurePatSendTable(db);
  }

  async capability(signal) {
    try {
      const value = await this.client.request('/pats/capability', { signal });
      return value?.accountId === this.client.accountId && value?.nativePat === true
        ? { available: true, verified: value.verified === true }
        : { available: false, reason: 'native_pat_unavailable' };
    } catch (error) {
      return { available: false, reason: error.status === 404 ? 'native_route_missing' : 'native_capability_unavailable' };
    }
  }

  #source({ groupId, targetUserId, sourceId, kind, now }) {
    if (!group(groupId) || !this.allowedGroups.has(groupId) || !id(targetUserId) ||
        targetUserId.endsWith('@chatroom') || typeof sourceId !== 'string' || !sourceId ||
        sourceId.length > 512 || !['reply', 'proactive'].includes(kind) ||
        !Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid or unauthorized pat target');
    if (this.botUserIds.has(targetUserId)) return 'self_or_bot';
    const stored = this.sourceDb.prepare('SELECT message FROM inbox WHERE id=?').get(sourceId);
    if (!stored) return 'source_missing';
    let source;
    try { source = JSON.parse(stored.message); } catch { return 'source_invalid'; }
    if (source.accountId !== this.client.accountId || source.groupId !== groupId ||
        source.userId !== targetUserId || source.sourceMessageId !== sourceId ||
        source.direction === 'outgoing') return 'source_scope_mismatch';
    if (source.recall || source.recalled || source.revoked || source.deleted ||
        ['recalled', 'revoked', 'deleted'].includes(source.state)) return 'source_recalled';
    const time = Date.parse(source.eventTime);
    if (!Number.isFinite(time) || time > now + 60000 || now - time > 5 * 60000) return 'source_expired';
    // The existing sealed-batch projector owns this stable ID namespace. A plain
    // chat message containing "拍了拍" is not sufficient to authorize a pat-back.
    if (kind === 'reply' && (source.interaction !== 'pat' || source.mentions?.self !== true ||
        !/^pat:[a-f0-9]{64}$/u.test(sourceId))) return 'unverified_pat_event';
    if (kind === 'proactive' && source.interaction === 'pat') return 'pat_cannot_trigger_proactive';
    if (kind === 'proactive' && source.interaction && source.interaction !== 'text') return 'not_direct_text';
    return null;
  }

  #cooldown(groupId, targetUserId, now) {
    const rows = this.db.prepare(`SELECT target_id,attempted_at FROM pat_sends
      WHERE account_id=? AND group_id=? AND state IN ('submitting','accepted','needs_review','failed')
      AND attempted_at>?`).all(this.client.accountId, groupId, now - 24 * 60 * 60000);
    if (rows.length >= this.maxPerDay) return 'daily_limit';
    if (rows.some(row => row.target_id === targetUserId && now - row.attempted_at < this.targetCooldownMs)) return 'target_cooldown';
    if (rows.some(row => now - row.attempted_at < this.groupCooldownMs)) return 'group_cooldown';
    return null;
  }

  async send({ groupId, targetUserId, sourceId, kind = 'reply', now = Date.now(), signal } = {}) {
    const rejected = this.#source({ groupId, targetUserId, sourceId, kind, now });
    if (rejected) return { state: 'skipped', reason: rejected };
    const key = patSendKey(this.client.accountId, groupId, targetUserId, sourceId);
    const previous = this.db.prepare('SELECT * FROM pat_sends WHERE account_id=? AND group_id=? AND source_id=?')
      .get(this.client.accountId, groupId, sourceId);
    if (previous) return this.reconcile(previous.key, { signal });
    const cooldown = this.#cooldown(groupId, targetUserId, now);
    if (cooldown) return { state: 'skipped', reason: cooldown };
    const capability = await this.capability(signal);
    if (!capability.available) return { state: 'unavailable', reason: capability.reason };
    const members = new Set(await this.getMemberIds(groupId, signal));
    if (!members.has(targetUserId) || !members.has(this.selfUserId)) return { state: 'skipped', reason: 'not_current_member' };
    signal?.throwIfAborted();
    // Capability/member lookups can yield while a member opts out. Consult the
    // latest host-bound policy immediately before reserving/sending the action.
    try {
      if (await this.authorize({ groupId, targetUserId, sourceId, kind }) !== true) {
        return { state: 'skipped', reason: 'preference_blocked' };
      }
    } catch { return { state: 'skipped', reason: 'preference_check_failed' }; }
    signal?.throwIfAborted();
    // This transaction serializes concurrent calls and leaves durable uncertainty
    // before any request bytes can leave the process. Restarts never re-POST it.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raced = this.db.prepare('SELECT * FROM pat_sends WHERE account_id=? AND group_id=? AND source_id=?')
        .get(this.client.accountId, groupId, sourceId);
      const blocked = this.#cooldown(groupId, targetUserId, now);
      if (raced || blocked) {
        this.db.exec('COMMIT');
        return raced ? result(raced) : { state: 'skipped', reason: blocked };
      }
      this.db.prepare(`INSERT INTO pat_sends
        (key,account_id,group_id,target_id,source_id,kind,state,attempted_at) VALUES (?,?,?,?,?,?,'submitting',?)`)
        .run(key, this.client.accountId, groupId, targetUserId, sourceId, kind, now);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    let state = 'needs_review', receipt = null;
    try {
      const value = await this.client.request('/pats', { method: 'POST', key,
        body: { groupId, targetUserId, clientId: key }, signal });
      const checked = checkedReceipt(value, { key, account_id: this.client.accountId, group_id: groupId, target_id: targetUserId });
      if (checked) ({ state, receipt } = checked);
    } catch { /* Transport errors may occur after delivery; never retry blindly. */ }
    this.db.prepare('UPDATE pat_sends SET state=?,receipt=? WHERE key=?')
      .run(state, receipt ? JSON.stringify(receipt) : null, key);
    return result(this.db.prepare('SELECT * FROM pat_sends WHERE key=?').get(key));
  }

  async reconcile(key, { signal } = {}) {
    const row = this.db.prepare('SELECT * FROM pat_sends WHERE key=? AND account_id=?').get(key, this.client.accountId);
    if (!row) return { state: 'unavailable', reason: 'intent_missing' };
    if (!['submitting', 'needs_review'].includes(row.state)) return result(row);
    try {
      const value = await this.client.request(`/pats/by-idempotency-key?key=${encodeURIComponent(key)}`, { signal });
      const checked = checkedReceipt(value, row);
      if (checked && checked.state !== 'needs_review') {
        this.db.prepare('UPDATE pat_sends SET state=?,receipt=? WHERE key=? AND account_id=?')
          .run(checked.state, JSON.stringify(checked.receipt), key, this.client.accountId);
      }
    } catch { /* A missing receipt is not permission to post again. */ }
    return result(this.db.prepare('SELECT * FROM pat_sends WHERE key=?').get(key));
  }

  async reconcilePending({ limit = 10, signal } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid pat reconcile limit');
    const rows = this.db.prepare(`SELECT key FROM pat_sends WHERE account_id=?
      AND state IN ('submitting','needs_review') ORDER BY attempted_at LIMIT ?`).all(this.client.accountId, limit);
    const results = [];
    for (const row of rows) { signal?.throwIfAborted(); results.push(await this.reconcile(row.key, { signal })); }
    return results;
  }

  close() { if (this.ownsSourceDb) { this.sourceDb.close(); this.ownsSourceDb = false; } }
}
