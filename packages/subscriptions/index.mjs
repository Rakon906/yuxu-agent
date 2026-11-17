import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { OFFICIAL_SOURCES, parseOfficialSource } from './sources.mjs';

const HOUR = 3600000, DAY = 24 * HOUR;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f]/u.test(value);
const finiteTime = value => Number.isSafeInteger(value) && value > 0;
function scope(accountId, groupId) {
  if (!validId(accountId) || !validId(groupId) || !groupId.endsWith('@chatroom')) throw new Error('Invalid subscription scope');
}

/** Conservative final guard for claims about official time/status; supplied source text is still untrusted data. */
export function validateOfficialReply(reply, candidate, { now = Date.now() } = {}) {
  if (typeof reply !== 'string' || !reply.trim() || !candidate?.officialEvidence || !finiteTime(now)) return false;
  const words = reply.normalize('NFKC');
  const liveClaim = /(?:正在|已经|现在|这会儿|刚刚).{0,6}(?:比赛|开打|开赛)|(?:开打|开赛|开始打)了/u;
  const resultClaim = /(?:赢了|输了|夺冠|拿下冠军|战胜|输给|淘汰了|打完了|比赛结束|最终比分)/u;
  if (candidate.kind === 'patch' || candidate.kind === 'announcement') {
    if (liveClaim.test(words) || resultClaim.test(words)) return false;
    if (/国服/u.test(words) && /已经|已更新|已上线|正式上线|更新了|上线了|开服了/u.test(words)) return false;
    // A publication date is not a deployment schedule.
    if (/(?:今晚|今天|明天|明晚|后天|周末|\d{1,2}点).{0,15}(?:上线|开服|更新)|(?:上线|开服|更新).{0,15}(?:今晚|明天|后天|周末|\d{1,2}点)/u.test(words)) return false;
    if (candidate.kind === 'announcement' &&
        /(?:已经|现已|正式)(?:上线|开服|更新)|(?:游戏|服务器|国服|新赛季).{0,6}(?:已更新|已上线|更新了|上线了|开服了)|上线了|开服了|更新完成|维护结束/u.test(words)) return false;
    return true;
  }
  if (candidate.kind !== 'match' || typeof candidate.startTime !== 'string' ||
      !/(?:Z|[+-]\d{2}:\d{2})$/u.test(candidate.startTime)) return false;
  const start = Date.parse(candidate.startTime);
  if (!Number.isFinite(start)) return false;
  if (liveClaim.test(words) && candidate.status !== 'live') return false;
  if (resultClaim.test(words) && candidate.status !== 'completed') return false;
  if (/取消|延期|推迟/u.test(words) && !['cancelled', 'postponed'].includes(candidate.status)) return false;
  const local = new Date(start + 8 * HOUR);
  const day = Math.floor((start + 8 * HOUR) / DAY), today = Math.floor((now + 8 * HOUR) / DAY);
  const hour = local.getUTCHours(), minute = local.getUTCMinutes(), weekday = local.getUTCDay();
  const weeks = value => Math.floor((value + 3) / 7);
  for (const [word, delta, evening] of [['今天', 0, false], ['今晚', 0, true], ['明天', 1, false],
    ['明晚', 1, true], ['后天', 2, false], ['昨天', -1, false], ['昨晚', -1, true]]) {
    if (words.includes(word) && (day !== today + delta || (evening && hour < 18))) return false;
  }
  if (/下周/u.test(words) && weeks(day) !== weeks(today) + 1) return false;
  if (/(?:本周|这周)/u.test(words) && weeks(day) !== weeks(today)) return false;
  if (/周末/u.test(words) && ![0, 6].includes(weekday)) return false;
  for (const match of words.matchAll(/(?:星期|周)([一二三四五六日天])/gu)) {
    if (({ 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 })[match[1]] !== weekday) return false;
  }
  for (const match of words.matchAll(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})(?:日|号)/gu)) {
    if ((match[1] && Number(match[1]) !== local.getUTCFullYear()) || Number(match[2]) !== local.getUTCMonth() + 1 || Number(match[3]) !== local.getUTCDate()) return false;
  }
  for (const match of words.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/gu)) {
    if (Number(match[1]) !== local.getUTCFullYear() || Number(match[2]) !== local.getUTCMonth() + 1 || Number(match[3]) !== local.getUTCDate()) return false;
  }
  const zhNumber = word => {
    if (/^\d+$/u.test(word)) return Number(word);
    const digits = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    if (word in digits) return digits[word];
    const parts = word.split('十');
    if (parts.length !== 2) return NaN;
    return (parts[0] ? digits[parts[0]] : 1) * 10 + (parts[1] ? digits[parts[1]] : 0);
  };
  for (const match of words.matchAll(/(早上|上午|中午|下午|傍晚|晚上|今晚|明晚|凌晨)?\s*([零一二两三四五六七八九十\d]{1,3})[点时](?:([零一二两三四五六七八九十\d]{1,3})分|(半))?/gu)) {
    let statedHour = zhNumber(match[2]);
    const statedMinute = match[4] ? 30 : match[3] ? zhNumber(match[3]) : 0;
    if (['中午', '下午', '傍晚', '晚上', '今晚', '明晚'].includes(match[1]) && statedHour < 12) statedHour += 12;
    if (!Number.isFinite(statedHour) || !Number.isFinite(statedMinute) || statedMinute !== minute) return false;
    if (match[1] || statedHour > 12) { if (statedHour !== hour) return false; }
    else if (statedHour % 12 !== hour % 12) return false;
  }
  for (const match of words.matchAll(/\b(\d{1,2}):(\d{2})\b/gu)) {
    if (Number(match[1]) !== hour || Number(match[2]) !== minute) return false;
  }
  const teams = Array.isArray(candidate.teams) ? candidate.teams : [];
  if (teams.length !== 2) return false;
  if (resultClaim.test(words) && (!teams.every(team => Number.isSafeInteger(team.wins)) || teams[0].wins === teams[1].wins)) return false;
  const ordered = [...teams].sort((a, b) => {
    const position = team => {
      const places = [words.toUpperCase().indexOf(String(team.code).toUpperCase()), words.indexOf(team.name)]
        .filter(index => index >= 0);
      return places.length ? Math.min(...places) : Number.MAX_SAFE_INTEGER;
    };
    return position(a) - position(b);
  });
  for (const match of words.matchAll(/\b(\d)\s*[:比-]\s*(\d)\b/gu)) {
    if (!['live', 'completed'].includes(candidate.status) || !teams.every(t => Number.isSafeInteger(t.wins))) return false;
    if (Number(match[1]) !== ordered[0].wins || Number(match[2]) !== ordered[1].wins) return false;
  }
  if (candidate.status === 'completed') {
    for (const team of teams) {
      const escaped = String(team.code).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
      if (new RegExp(`${escaped}.{0,4}(?:赢了|夺冠|拿下冠军|战胜|击败)`, 'iu').test(words) && team.wins <= teams.find(t => t !== team).wins) return false;
      if (new RegExp(`${escaped}.{0,4}输了`, 'iu').test(words) && team.wins >= teams.find(t => t !== team).wins) return false;
    }
  }
  return true;
}

export function defaultSubscriptions({ accountId, groupIds }) {
  if (!Array.isArray(groupIds)) throw new Error('Subscription groups required');
  return { subscriptions: groupIds.flatMap(groupId => {
    scope(accountId, groupId);
    return [{ accountId, groupId, sourceId: 'lol-patches', enabled: true, teams: [] },
      { accountId, groupId, sourceId: 'lol-esports', enabled: true, teams: ['BLG'] },
      { accountId, groupId, sourceId: 'delta-announcements', enabled: true, teams: [] }];
  }) };
}

function subscriptions(config) {
  if (!config || !Array.isArray(config.subscriptions) || config.subscriptions.length > 100) throw new Error('Invalid subscription configuration');
  const seen = new Set();
  return config.subscriptions.map(item => {
    scope(item.accountId, item.groupId);
    if (!OFFICIAL_SOURCES[item.sourceId] || typeof item.enabled !== 'boolean') throw new Error('Unknown subscription source or switch');
    if (!Array.isArray(item.teams) || item.teams.length > 20 || item.teams.some(t => typeof t !== 'string' || !/^[A-Z0-9._-]{1,20}$/u.test(t))) throw new Error('Invalid team filters');
    if (item.sourceId === 'lol-esports' && item.teams.length === 0) throw new Error('Explicit subscribed teams required');
    const key = JSON.stringify([item.accountId, item.groupId, item.sourceId]);
    if (seen.has(key)) throw new Error('Duplicate subscription');
    seen.add(key);
    return { accountId: item.accountId, groupId: item.groupId, sourceId: item.sourceId,
      enabled: item.enabled, teams: [...new Set(item.teams)] };
  });
}

export class SubscriptionStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS interest_subscriptions (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, source_id TEXT NOT NULL,
        enabled INTEGER NOT NULL, teams_json TEXT NOT NULL, activated_at INTEGER NOT NULL,
        PRIMARY KEY(account_id,group_id,source_id));
      CREATE TABLE IF NOT EXISTS interest_sources (
        source_id TEXT PRIMARY KEY, checked_at INTEGER, fetched_at INTEGER, next_at INTEGER,
        etag TEXT, last_modified TEXT, status TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS interest_events (
        id TEXT PRIMARY KEY, source_id TEXT NOT NULL, external_id TEXT NOT NULL,
        revision TEXT NOT NULL, event_json TEXT NOT NULL, first_seen_at INTEGER NOT NULL,
        changed_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, baseline INTEGER NOT NULL,
        UNIQUE(source_id,external_id));
      CREATE INDEX IF NOT EXISTS interest_events_source ON interest_events(source_id,changed_at);
      CREATE TABLE IF NOT EXISTS interest_deliveries (
        account_id TEXT NOT NULL, group_id TEXT NOT NULL, delivery_key TEXT NOT NULL,
        event_id TEXT NOT NULL, revision TEXT NOT NULL, state TEXT NOT NULL, owner_key TEXT NOT NULL,
        claimed_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, outbox_key TEXT,
        PRIMARY KEY(account_id,group_id,delivery_key));`);
    const deliveryColumns = new Set(this.db.prepare('PRAGMA table_info(interest_deliveries)').all().map(row => row.name));
    if (!deliveryColumns.has('receipt_checks')) this.db.exec('ALTER TABLE interest_deliveries ADD COLUMN receipt_checks INTEGER NOT NULL DEFAULT 0');
    if (!deliveryColumns.has('last_receipt_check_at')) this.db.exec('ALTER TABLE interest_deliveries ADD COLUMN last_receipt_check_at INTEGER');
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const out = fn(); this.db.exec('COMMIT'); return out; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  configure(config, now = Date.now()) {
    if (!finiteTime(now)) throw new Error('Invalid subscription time');
    const rows = subscriptions(config);
    this.transaction(() => {
      // The complete explicit configuration owns this store; removal disables a subscription.
      this.db.prepare('UPDATE interest_subscriptions SET enabled=0').run();
      for (const item of rows) this.db.prepare(`INSERT INTO interest_subscriptions
        (account_id,group_id,source_id,enabled,teams_json,activated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(account_id,group_id,source_id) DO UPDATE SET enabled=excluded.enabled,
        teams_json=excluded.teams_json`).run(item.accountId, item.groupId, item.sourceId,
          Number(item.enabled), JSON.stringify(item.teams), now);
    });
    return rows;
  }
  source(sourceId) { return this.db.prepare('SELECT * FROM interest_sources WHERE source_id=?').get(sourceId) ?? null; }
  recordFetch(sourceId, { status, now, etag = null, lastModified = null, error = null, items = [] }) {
    const source = OFFICIAL_SOURCES[sourceId];
    if (!source || !finiteTime(now) || !['ok', 'unchanged', 'error'].includes(status)) throw new Error('Invalid source fetch');
    const prior = this.source(sourceId);
    if (status === 'unchanged' && !prior?.fetched_at) throw new Error('Cannot accept 304 before baseline');
    let inserted = 0, updated = 0;
    this.transaction(() => {
      if (status === 'ok') {
        for (const event of items) {
          const id = hash([sourceId, event.externalId]), revision = hash(event);
          const existing = this.db.prepare('SELECT revision FROM interest_events WHERE id=?').get(id);
          if (!existing) {
            this.db.prepare(`INSERT INTO interest_events VALUES(?,?,?,?,?,?,?,?,?)`).run(id, sourceId,
              event.externalId, revision, JSON.stringify(event), now, now, now, Number(!prior?.fetched_at));
            inserted++;
          } else {
            const changed = existing.revision !== revision;
            this.db.prepare(`UPDATE interest_events SET revision=?,event_json=?,changed_at=CASE WHEN ? THEN ? ELSE changed_at END,
              last_seen_at=?,baseline=CASE WHEN ? THEN 0 ELSE baseline END WHERE id=?`)
              .run(revision, JSON.stringify(event), Number(changed), now, now, Number(changed), id);
            if (changed) updated++;
          }
        }
      }
      this.db.prepare(`INSERT INTO interest_sources(source_id,checked_at,fetched_at,next_at,etag,last_modified,status,error)
        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET checked_at=excluded.checked_at,
        fetched_at=excluded.fetched_at,next_at=excluded.next_at,etag=excluded.etag,
        last_modified=excluded.last_modified,status=excluded.status,error=excluded.error`)
        .run(sourceId, now, status === 'error' ? prior?.fetched_at ?? null : now,
          now + source.pollMs, status === 'ok' ? etag : prior?.etag ?? null,
          status === 'ok' ? lastModified : prior?.last_modified ?? null, status, error);
    });
    return { inserted, updated };
  }
  candidates({ accountId, groupId, now = Date.now(), limit = 3 } = {}) {
    scope(accountId, groupId);
    if (!finiteTime(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid candidate query');
    const result = [];
    for (const subscription of this.db.prepare(`SELECT * FROM interest_subscriptions WHERE account_id=? AND group_id=? AND enabled=1`).all(accountId, groupId)) {
      const source = OFFICIAL_SOURCES[subscription.source_id], fetched = this.source(subscription.source_id);
      if (!source || !fetched?.fetched_at || fetched.fetched_at > now + 60000 || now - fetched.fetched_at > source.pollMs * 2) continue;
      const teamsFilter = JSON.parse(subscription.teams_json);
      for (const row of this.db.prepare('SELECT * FROM interest_events WHERE source_id=? ORDER BY changed_at DESC LIMIT 500').all(source.id)) {
        // A disappeared event is not evidence of cancellation; do not offer a stale homepage row.
        if (row.last_seen_at < fetched.fetched_at && fetched.status !== 'unchanged') continue;
        const event = JSON.parse(row.event_json);
        let phase;
        if (event.kind === 'match') {
          if (!event.teams.some(team => teamsFilter.includes(team.code))) continue;
          const start = Date.parse(event.startTime);
          if (event.status === 'scheduled' && start >= now && start - now <= 48 * HOUR) phase = 'upcoming';
          else if (event.status === 'live' && start <= now + HOUR && now - start < 12 * HOUR) phase = 'live';
          else if (event.status === 'completed' && start <= now && now - start < DAY) phase = 'result';
          else if (['cancelled', 'postponed'].includes(event.status) && Math.abs(now - start) < 48 * HOUR && !row.baseline) phase = event.status;
          else continue;
        } else {
          const published = Date.parse(event.publishedAt);
          if (row.baseline || !Number.isFinite(published) || published > now + 60000 || now - published > 7 * DAY || row.changed_at < subscription.activated_at) continue;
          phase = 'update';
        }
        const deliveryKey = hash([row.id, row.revision, phase]);
        if (this.db.prepare(`SELECT 1 FROM interest_deliveries WHERE account_id=? AND group_id=? AND delivery_key=?`).get(accountId, groupId, deliveryKey)) continue;
        const localStart = event.startTime ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai',
          year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(event.startTime)) : null;
        result.push({ ...event, id: row.id, revision: row.revision, deliveryKey, sourceId: source.id,
          source: source.name, topic: source.topic, category: source.category, phase,
          observedAt: new Date(fetched.fetched_at).toISOString(), changedAt: new Date(row.changed_at).toISOString(),
          localStart, timezone: 'Asia/Shanghai', officialEvidence: true,
          evidence: { sourceUrl: event.sourceUrl, startTime: event.startTime, status: event.status,
            fetchedAt: new Date(fetched.fetched_at).toISOString() } });
      }
    }
    return result.sort((a, b) => ({ live: 0, upcoming: 1, result: 2, postponed: 2, cancelled: 2, update: 3 })[a.phase] -
      ({ live: 0, upcoming: 1, result: 2, postponed: 2, cancelled: 2, update: 3 })[b.phase] ||
      (Date.parse(a.startTime ?? a.changedAt) - Date.parse(b.startTime ?? b.changedAt))).slice(0, limit);
  }
  claim(candidate, { accountId, groupId, ownerKey, now = Date.now() }) {
    scope(accountId, groupId);
    if (!validId(ownerKey)) throw new Error('Invalid subscription claim owner');
    return this.transaction(() => {
      const current = this.candidates({ accountId, groupId, now, limit: 20 })
        .find(item => item.deliveryKey === candidate?.deliveryKey && item.revision === candidate?.revision);
      if (!current) return false;
      return this.db.prepare(`INSERT OR IGNORE INTO interest_deliveries
        (account_id,group_id,delivery_key,event_id,revision,state,owner_key,claimed_at,updated_at,outbox_key)
        VALUES(?,?,?,?,?,?,?,?,?,NULL)`)
        .run(accountId, groupId, current.deliveryKey, current.id, current.revision, 'claimed', ownerKey, now, now).changes === 1;
    });
  }
  settle(deliveryKey, { accountId, groupId, state, ownerKey, outboxKey = null, now = Date.now() }) {
    scope(accountId, groupId);
    if (!['sent', 'skipped', 'unknown', 'pending_receipt', 'needs_review'].includes(state) || !validId(ownerKey) || !finiteTime(now) ||
        (outboxKey !== null && !validId(outboxKey))) throw new Error('Invalid subscription settlement');
    return this.db.prepare(`UPDATE interest_deliveries SET state=?,updated_at=?,outbox_key=COALESCE(?,outbox_key)
      WHERE account_id=? AND group_id=? AND delivery_key=? AND owner_key=?
        AND state IN ('claimed','pending_receipt','needs_review','unknown') AND updated_at<=?
        AND COALESCE(last_receipt_check_at,updated_at)<=?`)
      .run(state, now, outboxKey, accountId, groupId, deliveryKey, ownerKey, now, now).changes === 1;
  }
  pendingReceipts({ accountId, groupId, now = Date.now(), limit = 1 }) {
    scope(accountId, groupId);
    if (!finiteTime(now) || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid receipt check query');
    // Claim a bounded read attempt before network I/O, so exceptions cannot create a hot loop.
    // Default one at a time also prevents one failed RPC starving a whole preclaimed batch.
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT delivery_key AS deliveryKey,owner_key AS ownerKey,outbox_key AS outboxKey,
        updated_at AS updatedAt,receipt_checks AS receiptChecks,last_receipt_check_at AS lastReceiptCheckAt
        FROM interest_deliveries WHERE account_id=? AND group_id=?
          AND state IN ('pending_receipt','needs_review','unknown') AND outbox_key IS NOT NULL
          AND receipt_checks<8 AND claimed_at>=? AND updated_at<=?
        ORDER BY COALESCE(last_receipt_check_at,0),updated_at LIMIT 200`)
        .all(accountId, groupId, now - 7 * DAY, now - 60000)
        .filter(row => row.lastReceiptCheckAt === null ||
          now - row.lastReceiptCheckAt >= Math.min(6 * HOUR, 60000 * 2 ** row.receiptChecks)).slice(0, limit);
      const claim = this.db.prepare(`UPDATE interest_deliveries SET receipt_checks=receipt_checks+1,last_receipt_check_at=?
        WHERE account_id=? AND group_id=? AND delivery_key=? AND receipt_checks=?`);
      return rows.filter(row => claim.run(now, accountId, groupId, row.deliveryKey, row.receiptChecks).changes === 1);
    });
  }
  validateClaim(candidate, { accountId, groupId, ownerKey, now = Date.now() }) {
    scope(accountId, groupId);
    if (!finiteTime(now) || !validId(ownerKey)) return false;
    const row = this.db.prepare(`SELECT d.*,e.source_id,e.event_json,e.last_seen_at,e.revision AS current_revision
      FROM interest_deliveries d JOIN interest_events e ON e.id=d.event_id
      WHERE d.account_id=? AND d.group_id=? AND d.delivery_key=? AND d.owner_key=? AND d.state='claimed'`)
      .get(accountId, groupId, candidate?.deliveryKey ?? '', ownerKey);
    if (!row || row.revision !== row.current_revision || row.revision !== candidate.revision) return false;
    const subscription = this.db.prepare(`SELECT * FROM interest_subscriptions WHERE account_id=? AND group_id=? AND source_id=? AND enabled=1`)
      .get(accountId, groupId, row.source_id);
    const source = OFFICIAL_SOURCES[row.source_id], fetched = this.source(row.source_id);
    if (!subscription || !source || !fetched?.fetched_at || fetched.fetched_at > now + 60000 ||
        now - fetched.fetched_at > source.pollMs * 2 ||
        (row.last_seen_at < fetched.fetched_at && fetched.status !== 'unchanged')) return false;
    const event = JSON.parse(row.event_json);
    if (event.kind === 'match') {
      if (!event.teams.some(team => JSON.parse(subscription.teams_json).includes(team.code))) return false;
      const start = Date.parse(event.startTime);
      if (event.status === 'scheduled') return start >= now && start - now <= 48 * HOUR;
      if (event.status === 'live') return start <= now + HOUR && now - start < 12 * HOUR;
      if (event.status === 'completed') return start <= now && now - start < DAY;
      return ['cancelled', 'postponed'].includes(event.status) && Math.abs(now - start) < 48 * HOUR;
    }
    return Date.parse(event.publishedAt) <= now + 60000 && now - Date.parse(event.publishedAt) <= 7 * DAY;
  }
  status() {
    return this.db.prepare(`SELECT source_id,checked_at,fetched_at,next_at,status,error FROM interest_sources ORDER BY source_id`).all();
  }
}

async function boundedText(response, maxBytes = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('Official source too large');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Official source has no body');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error('Official source too large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function refreshSubscriptions({ store, config, now = Date.now(), fetchImpl = fetch, force = false } = {}) {
  const configured = store.configure(config, now);
  const results = [];
  for (const sourceId of [...new Set(configured.filter(item => item.enabled).map(item => item.sourceId))]) {
    const source = OFFICIAL_SOURCES[sourceId], prior = store.source(sourceId);
    if (!force && prior?.next_at > now && prior.checked_at <= now) { results.push({ sourceId, status: 'waiting' }); continue; }
    try {
      const headers = { 'User-Agent': 'SocioMem/0.1 (public official interest feeds)',
        Accept: source.form ? 'application/json' : 'text/html' };
      if (source.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers.Referer = source.pageUrl;
        headers.Origin = new URL(source.pageUrl).origin;
      }
      if (prior?.etag) headers['If-None-Match'] = prior.etag;
      if (prior?.last_modified) headers['If-Modified-Since'] = prior.last_modified;
      const response = await fetchImpl(source.url, { headers, redirect: 'error', credentials: 'omit',
        ...(source.form ? { method: source.method, body: new URLSearchParams(source.form).toString() } : {}),
        signal: AbortSignal.timeout(20000) });
      if (response.status === 304) {
        store.recordFetch(sourceId, { status: 'unchanged', now });
        results.push({ sourceId, status: 'unchanged', inserted: 0, updated: 0 });
        continue;
      }
      if (!response.ok) throw new Error(`Official source HTTP ${response.status}`);
      if (response.url && response.url !== source.url) throw new Error('Unexpected official source URL');
      const body = await boundedText(response, source.maxBytes);
      const items = parseOfficialSource(sourceId, body);
      const counts = store.recordFetch(sourceId, { status: 'ok', now, items,
        etag: response.headers.get('etag')?.slice(0, 500) ?? null,
        lastModified: response.headers.get('last-modified')?.slice(0, 200) ?? null });
      results.push({ sourceId, status: 'ok', fetched: items.length, ...counts });
    } catch (error) {
      // Do not put source HTML or external error bodies in logs.
      const message = error.name === 'TimeoutError' ? 'timeout' : String(error.message ?? 'fetch_failed').slice(0, 120);
      store.recordFetch(sourceId, { status: 'error', now, error: message });
      results.push({ sourceId, status: 'error', error: message });
    }
  }
  return results;
}
