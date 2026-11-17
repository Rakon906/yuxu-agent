import { createHash } from 'node:crypto';
import { readInbox } from '../diary/index.mjs';
import { selectChatContext } from '../memory/context-policy.mjs';
import { validateToolRequest, readTaskEvidence } from './tools.mjs';
import { isNeedlesslyCruel } from './tone.mjs';
import { chooseVoiceReply } from '../voice/selection.mjs';

const questionPattern = /[?？]|(?:吗|么|呢)[。！!]*$|(?:有没有|要不要|能不能|可不可以|想不想|几(?:点|个|人)|多少|什么时候)|(?:[有是要该能会问想])(?:谁|什么|怎么|咋|如何|为何|为什么|哪(?:个|里|儿))|(?:^|[\s，,。！？!?])(?:谁|什么|怎么|咋|如何|为何|为什么|哪(?:个|里|儿))/u;
const planPattern = /(?:改到|改成|取消|延期|提前|定在|约在|集合|出发|聚会|碰头).{0,16}(?:[\d一二两三四五六七八九十]{1,3}[点时:：]|周[一二三四五六日天]|明天|后天|今晚|上午|下午|晚上)|(?:周[一二三四五六日天]|明天|后天|今晚|上午|下午|晚上).{0,16}(?:集合|出发|聚会|碰头|定了)/u;
const defaultAliases = ['肥鱼不肥', '肥鱼', 'SocioMem', 'agent', '机器人'];
const escapeRegExp = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const age = (message, now) => now - Date.parse(message.at);

export function classifyParticipation(message, aliases = defaultAliases) {
  if (['sticker', 'image', 'video', 'share', 'forwarded'].includes(message.interaction)) {
    return message.mentions?.self === true ? 'mention' : 'ordinary';
  }
  if (message.interaction === 'voice' && message.voiceState !== 'done') return 'ordinary';
  const text = message.text.trim();
  const named = aliases.some(alias => {
    if (typeof alias !== 'string' || !alias.trim()) return false;
    return new RegExp(`(?:^|[\\s，。！？,])@?${escapeRegExp(alias.trim())}(?=$|[\\s，。！？?,])`, 'iu').test(text);
  });
  if (message.mentions?.self === true || named) return 'mention';
  if (questionPattern.test(text)) return 'question';
  if (planPattern.test(text)) return 'plan';
  return 'ordinary';
}

export class ParticipationLedger {
  constructor(adapterStore) {
    this.store = adapterStore;
    this.db = adapterStore.db;
    this.db.exec(`CREATE TABLE IF NOT EXISTS participation_cursor (
        group_id TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS participation_tasks (
        source_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
        rowid INTEGER NOT NULL, latest_rowid INTEGER NOT NULL, source_ids_json TEXT NOT NULL,
        last_event_at INTEGER NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
        observed_at INTEGER NOT NULL, due_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL,
        outbox_key TEXT, reason TEXT);
      CREATE INDEX IF NOT EXISTS participation_due ON participation_tasks(group_id,state,due_at);
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY, group_id TEXT NOT NULL, kind TEXT NOT NULL,
        summary TEXT NOT NULL, evidence_id TEXT NOT NULL, evidence_quote TEXT NOT NULL,
        status TEXT NOT NULL, source_rowid INTEGER NOT NULL, last_seen_rowid INTEGER NOT NULL,
        rechecks INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS agent_tasks_open ON agent_tasks(group_id,kind,status,last_seen_rowid);
      CREATE TABLE IF NOT EXISTS participation_messages (
        source_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, group_id TEXT NOT NULL,
        sender_id TEXT NOT NULL, kind TEXT NOT NULL, observed_at INTEGER NOT NULL,
        state TEXT NOT NULL, reason TEXT, outbox_key TEXT);
      CREATE INDEX IF NOT EXISTS participation_messages_recent
        ON participation_messages(group_id,observed_at);
      CREATE TABLE IF NOT EXISTS participation_judgments (
        id INTEGER PRIMARY KEY, task_id TEXT NOT NULL, at TEXT NOT NULL,
        step INTEGER NOT NULL, context_ids_json TEXT NOT NULL, decision_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS participation_judgments_task
        ON participation_judgments(task_id,id);
      CREATE TABLE IF NOT EXISTS participation_feedback (
        source_id TEXT PRIMARY KEY, label TEXT NOT NULL,
        preferred_reply TEXT, note TEXT, labeled_at TEXT NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(agent_tasks)').all().some(row => row.name === 'closure_reason')) {
      this.db.exec('ALTER TABLE agent_tasks ADD COLUMN closure_reason TEXT');
    }
    this.db.prepare(`INSERT OR IGNORE INTO participation_messages
      (source_id,task_id,group_id,sender_id,kind,observed_at,state,reason,outbox_key)
      SELECT CAST(j.value AS TEXT),p.source_id,p.group_id,p.sender_id,p.kind,
        p.observed_at,p.state,p.reason,p.outbox_key
      FROM participation_tasks p,json_each(p.source_ids_json) j`).run();
  }
  cursor(groupId) { return this.db.prepare('SELECT last_rowid FROM participation_cursor WHERE group_id=?').get(groupId)?.last_rowid; }
  seed(groupId, rowid) {
    this.db.prepare('INSERT OR IGNORE INTO participation_cursor(group_id,last_rowid) VALUES (?,?)').run(groupId, rowid);
  }
  observe(message, kind, now) {
    return this.store.transaction(() => {
    const due = now + (['mention', 'followup'].includes(kind) ? 15000 :
      ['question', 'plan'].includes(kind) ? 45000 : 90000);
    const eventAt = Date.parse(message.at);
    if (!Number.isFinite(eventAt)) throw new Error('Participation message has invalid event time');
    const last = this.db.prepare('SELECT * FROM participation_tasks WHERE group_id=? ORDER BY latest_rowid DESC LIMIT 1')
      .get(message.groupId);
    const ids = last ? JSON.parse(last.source_ids_json) : [];
    const contiguous = last?.state === 'pending' && last.sender_id === message.senderId &&
      Number.isFinite(eventAt) && eventAt >= last.last_event_at && eventAt - last.last_event_at <= 90000 && ids.length < 10;
    let taskKind = kind;
    if (contiguous) {
      ids.push(message.id);
      const priority = { ordinary: 0, plan: 1, followup: 2, question: 3, mention: 4 };
      const nextKind = priority[kind] > priority[last.kind] ? kind : last.kind;
      taskKind = nextKind;
      this.db.prepare(`UPDATE participation_tasks SET latest_rowid=?,source_ids_json=?,last_event_at=?,
        kind=?,due_at=?,deadline_at=? WHERE source_id=? AND state='pending'`)
        .run(message.rowid, JSON.stringify(ids), eventAt, nextKind,
          ['mention', 'followup'].includes(nextKind) ? Math.min(last.due_at, now + 15000)
            : ['question', 'plan'].includes(nextKind) ? now + 45000 : due,
          now + 300000, last.source_id);
      this.db.prepare('UPDATE participation_messages SET kind=? WHERE task_id=?')
        .run(nextKind, last.source_id);
    } else {
      this.db.prepare(`INSERT OR IGNORE INTO participation_tasks
        (source_id,group_id,sender_id,rowid,latest_rowid,source_ids_json,last_event_at,
          kind,state,observed_at,due_at,deadline_at)
        VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)`)
        .run(message.id, message.groupId, message.senderId, message.rowid, message.rowid,
          JSON.stringify([message.id]), eventAt, kind, now, due, now + 300000);
    }
    this.db.prepare(`INSERT OR IGNORE INTO participation_messages
      (source_id,task_id,group_id,sender_id,kind,observed_at,state)
      VALUES (?,?,?,?,?,?,'pending')`)
      .run(message.id, contiguous ? last.source_id : message.id, message.groupId,
        message.senderId, taskKind, now);
    this.db.prepare('UPDATE participation_cursor SET last_rowid=? WHERE group_id=? AND last_rowid<?')
      .run(message.rowid, message.groupId, message.rowid);
    this.store.trace('participation.observed', { sourceId: message.id, groupId: message.groupId,
      kind, taskId: contiguous ? last.source_id : message.id });
    });
  }
  due(groupId, now) {
    return this.db.prepare(`SELECT * FROM participation_tasks WHERE group_id=? AND state='pending' AND due_at<=?
      ORDER BY CASE kind WHEN 'mention' THEN 0 WHEN 'question' THEN 1 WHEN 'followup' THEN 2 ELSE 3 END, due_at, rowid LIMIT 1`)
      .get(groupId, now) ?? null;
  }
  recentAgentQuestion(groupId, at) {
    const row = this.db.prepare(`SELECT text,attempted_at FROM outbox WHERE group_id=? AND
      state='accepted' AND attempted_at<=? ORDER BY attempted_at DESC LIMIT 1`).get(groupId, at);
    return row && at - row.attempted_at <= 2 * 60000 && /[?？]/u.test(row.text)
      ? { text: row.text, at: row.attempted_at } : null;
  }
  recentAgentReplies(groupId, now) {
    return this.db.prepare(`SELECT text FROM outbox WHERE group_id=? AND state='accepted'
      AND attempted_at>=? AND attempted_at<=? ORDER BY attempted_at DESC LIMIT 6`)
      .all(groupId, now - 2 * 3600000, now).map(row => row.text);
  }
  recentAgentMessages(groupId, now) {
    return this.db.prepare(`SELECT text,attempted_at,mentions_json FROM outbox WHERE group_id=? AND state='accepted'
      AND attempted_at>=? AND attempted_at<=? ORDER BY attempted_at DESC LIMIT 999`)
      .all(groupId, now - 24 * 3600000, now).reverse()
      .map(row => ({ text: row.text, at: new Date(row.attempted_at).toISOString(),
        mentionUserIds: JSON.parse(row.mentions_json ?? '[]') }));
  }
  prioritizeFollowups(groupId, now) {
    for (const task of this.db.prepare(`SELECT source_id,observed_at FROM participation_tasks
      WHERE group_id=? AND state='pending' AND kind='ordinary'`).all(groupId)) {
      if (!this.recentAgentQuestion(groupId, task.observed_at)) continue;
      this.db.prepare(`UPDATE participation_tasks SET kind='followup',due_at=?,reason='possible_answer_to_agent'
        WHERE source_id=? AND state='pending' AND kind='ordinary'`)
        .run(Math.max(now, task.observed_at + 15000), task.source_id);
      this.db.prepare("UPDATE participation_messages SET kind='followup',reason='possible_answer_to_agent' WHERE task_id=?")
        .run(task.source_id);
      this.store.trace('participation.followup_prioritized', { sourceId: task.source_id });
    }
  }
  receiptTask(groupId) {
    return this.db.prepare(`SELECT * FROM participation_tasks WHERE group_id=? AND state='pending_receipt'
      ORDER BY rowid LIMIT 1`).get(groupId) ?? null;
  }
  transition(sourceId, state, reason, outboxKey = null) {
    return this.store.transaction(() => {
    this.db.prepare(`UPDATE participation_tasks SET state=?,reason=?,outbox_key=COALESCE(?,outbox_key)
      WHERE source_id=? AND state IN ('pending','pending_receipt')`).run(state, reason, outboxKey, sourceId);
    this.db.prepare(`UPDATE participation_messages SET state=?,reason=?,
      outbox_key=COALESCE(?,outbox_key) WHERE task_id=?`)
      .run(state, reason, outboxKey, sourceId);
    this.store.trace('participation.decision', { sourceId, state, reason, outboxKey });
    });
  }
  defer(sourceId, dueAt, reason) {
    return this.store.transaction(() => {
    this.db.prepare("UPDATE participation_tasks SET due_at=?,reason=? WHERE source_id=? AND state='pending'")
      .run(dueAt, reason, sourceId);
    this.db.prepare('UPDATE participation_messages SET reason=? WHERE task_id=?')
      .run(reason, sourceId);
    this.store.trace('participation.deferred', { sourceId, dueAt, reason });
    });
  }
  task(sourceId) { return this.db.prepare('SELECT * FROM participation_tasks WHERE source_id=?').get(sourceId) ?? null; }
  recordJudgment(taskId, step, contextIds, decision) {
    this.db.prepare(`INSERT INTO participation_judgments
      (task_id,at,step,context_ids_json,decision_json) VALUES (?,?,?,?,?)`)
      .run(taskId, new Date().toISOString(), step, JSON.stringify(contextIds), JSON.stringify(decision));
  }
  openTasks(groupId) {
    return this.db.prepare(`SELECT id,kind,summary,evidence_id,evidence_quote,created_at
      FROM agent_tasks WHERE group_id=? AND status='open' ORDER BY updated_at DESC LIMIT 3`).all(groupId);
  }
  /** Explicit, idempotent maintenance; safe to invoke once after a backup or each cycle. */
  maintainTasks({ groupId, inboxPath, now = Date.now() }) {
    if (typeof groupId !== 'string' || !groupId || !Number.isSafeInteger(now) || now < 0) throw new Error('Invalid task maintenance scope');
    const rows = this.db.prepare(`SELECT a.*,p.state AS participation_state FROM agent_tasks a
      LEFT JOIN participation_tasks p ON p.source_id=a.id AND p.group_id=a.group_id
      WHERE a.group_id=? AND a.status='open' ORDER BY a.created_at LIMIT 1000`).all(groupId);
    if (!rows.length) return { inspected: 0, backfilled: 0, expired: 0, invalidated: 0, settled: 0 };
    const evidence = readTaskEvidence(inboxPath, { accountId: this.store.accountId, groupId,
      ids: rows.map(row => row.evidence_id || row.id) });
    return this.store.transaction(() => {
      const result = { inspected: rows.length, backfilled: 0, expired: 0, invalidated: 0, settled: 0 };
      for (const row of rows) {
        const source = evidence.get(row.evidence_id || row.id);
        if (source && row.kind === 'question' && (!row.summary || !row.evidence_quote)) {
          this.db.prepare('UPDATE agent_tasks SET summary=?,evidence_quote=? WHERE id=? AND status=?')
            .run(source.text.trim().slice(0, 180), source.text.slice(0, 200), row.id, 'open');
          result.backfilled++;
        }
        let status = null, reason = null;
        if (row.participation_state === 'sent' || row.participation_state === 'answered') {
          status = row.participation_state === 'sent' ? 'resolved' : 'answered'; reason = 'participation_completed'; result.settled++;
        } else if (!source) {
          status = 'invalidated'; reason = 'source_missing_or_recalled'; result.invalidated++;
        } else if (row.kind === 'question' && row.created_at < now - 20 * 60000 && row.participation_state !== 'pending_receipt') {
          status = 'expired'; reason = 'question_window_elapsed'; result.expired++;
        } else if (row.kind === 'question' && row.rechecks >= 2 && row.participation_state === 'skipped') {
          status = 'expired'; reason = 'question_recheck_budget_exhausted'; result.expired++;
        }
        if (!status) continue;
        this.db.prepare("UPDATE agent_tasks SET status=?,closure_reason=?,updated_at=? WHERE id=? AND status='open'")
          .run(status, reason, now, row.id);
        // Do not alter sent/ambiguous outbox outcomes. Only unsubmitted old work ends.
        if (['pending', 'skipped'].includes(row.participation_state)) {
          this.db.prepare('UPDATE participation_tasks SET state=?,reason=? WHERE source_id=?').run(status, reason, row.id);
          this.db.prepare('UPDATE participation_messages SET state=?,reason=? WHERE task_id=?').run(status, reason, row.id);
        }
        this.store.trace('agent_task.closed', { sourceId: row.id, groupId, status, reason });
      }
      if (result.backfilled) this.store.trace('agent_task.evidence_backfilled', { groupId, count: result.backfilled });
      return result;
    });
  }
  keepQuestionOpen(task, lastSeenRowid, now, source = null) {
    const quote = typeof source?.text === 'string' ? source.text.slice(0, 200) : '';
    const summary = typeof source?.text === 'string' ? source.text.trim().slice(0, 180) : '';
    this.db.prepare(`INSERT INTO agent_tasks
      (id,group_id,kind,summary,evidence_id,evidence_quote,status,source_rowid,last_seen_rowid,created_at,updated_at)
      VALUES (?,?, 'question',?,?,?,'open',?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET last_seen_rowid=excluded.last_seen_rowid,updated_at=excluded.updated_at
      WHERE agent_tasks.status='open'`)
      .run(task.source_id, task.group_id, summary, task.source_id, quote, task.rowid, lastSeenRowid, now, now);
    this.store.trace('agent_task.unresolved', { sourceId: task.source_id, groupId: task.group_id });
  }
  reopenQuestion(groupId, latestRowid, now) {
    const row = this.db.prepare(`SELECT a.id FROM agent_tasks a JOIN participation_tasks p ON p.source_id=a.id
      WHERE a.group_id=? AND a.kind='question' AND a.status='open' AND
      a.last_seen_rowid<? AND a.rechecks<2 AND a.created_at>=? AND p.state='skipped'
      ORDER BY a.created_at LIMIT 1`).get(groupId, latestRowid, now - 20 * 60000);
    if (!row) return null;
    this.db.prepare(`UPDATE agent_tasks SET last_seen_rowid=?,rechecks=rechecks+1,updated_at=? WHERE id=?`)
      .run(latestRowid, now, row.id);
    this.db.prepare("UPDATE participation_tasks SET state='pending',due_at=?,reason='unresolved_recheck' WHERE source_id=?")
      .run(now, row.id);
    this.db.prepare("UPDATE participation_messages SET state='pending',reason='unresolved_recheck' WHERE task_id=?")
      .run(row.id);
    this.store.trace('agent_task.reopened', { sourceId: row.id, groupId });
    return row.id;
  }
  settleTask(sourceId, status, now) {
    this.db.prepare('UPDATE agent_tasks SET status=?,updated_at=? WHERE id=? AND status=?')
      .run(status, now, sourceId, 'open');
  }
  notePlan({ sourceId, groupId, rowid, summary, evidenceId, evidenceQuote, resolvesTaskId, status }, now) {
    if (resolvesTaskId) {
      const updated = this.db.prepare(`UPDATE agent_tasks SET summary=?,evidence_id=?,evidence_quote=?,
        status=?,updated_at=? WHERE id=? AND group_id=? AND kind='plan' AND status='open'`)
        .run(summary, evidenceId, evidenceQuote, status, now, resolvesTaskId, groupId).changes;
      if (!updated) throw new Error('Plan update target is outside the open group tasks');
      this.store.trace('agent_task.plan_updated', { sourceId, resolvesTaskId, groupId, status });
      return;
    }
    this.db.prepare(`INSERT OR IGNORE INTO agent_tasks
      (id,group_id,kind,summary,evidence_id,evidence_quote,status,source_rowid,last_seen_rowid,created_at,updated_at)
      VALUES (?,?,'plan',?,?,?,?,?,?,?,?)`)
      .run(sourceId, groupId, summary, evidenceId, evidenceQuote, status, rowid, rowid, now, now);
    this.store.trace('agent_task.plan_noted', { sourceId, groupId });
  }
}

function latestRowid(inboxPath, accountId, groupId) {
  return readInbox(inboxPath, { accountId, groupId, recent: true, limit: 1 })[0]?.rowid ?? 0;
}

export function selectConversationContext(items, now, options = {}) {
  // Age is context, not an expiry rule. Consolidated history is replaced by
  // retrieved diaries at the shared model boundary; keep a continuity tail.
  return selectChatContext(items, options);
}

export function observeNewMessages({ ledger, inboxPath, accountId, groupId, now = Date.now(),
  aliases = defaultAliases, startAtLatest = true }) {
  if (ledger.cursor(groupId) === undefined) ledger.seed(groupId,
    startAtLatest ? latestRowid(inboxPath, accountId, groupId) : 0);
  let observed = 0;
  while (true) {
    const rows = readInbox(inboxPath, { accountId, groupId, afterRowid: ledger.cursor(groupId), limit: 256 });
    if (!rows.length) break;
    for (const item of rows) {
      ledger.observe({ ...item, groupId }, classifyParticipation(item, aliases), now);
      observed++;
    }
    if (rows.length < 256) break;
  }
  return observed;
}

function validateDecision(value, target, stickerCandidates = []) {
  if (!value || typeof value !== 'object' || typeof value.shouldReply !== 'boolean' ||
      typeof value.answeredByHuman !== 'boolean' || typeof value.reply !== 'string' ||
      typeof value.reason !== 'string' || typeof value.isQuestion !== 'boolean' ||
      typeof value.isAddressed !== 'boolean' || typeof value.isFollowup !== 'boolean') {
    throw new Error('Invalid participation decision');
  }
  const reply = trimGenericSuggestion(value.reply.replaceAll('😂', '')
    .replace(/\s+([，。！？?])/gu, '$1').trim(), target.text);
  if (reply.length > 300 || /[\u0000-\u001f]/u.test(reply)) throw new Error('Invalid participation reply');
  let toolRequest = null;
  let invalidToolRequest = false;
  if (value.toolRequest != null) {
    const fallbackName = /(?:上次|之前|以前|当时|过去|那天)/u.test(target.text)
      ? 'diary_search' : 'memory_search';
    try { toolRequest = validateToolRequest(value.toolRequest, fallbackName); }
    catch { invalidToolRequest = true; }
  }
  const evidenceIds = value.evidenceIds ?? [];
  if (!Array.isArray(evidenceIds) || evidenceIds.length > 8 ||
      evidenceIds.some(id => typeof id !== 'string' || !id || id.length > 200)) {
    throw new Error('Invalid participation evidence IDs');
  }
  const focusMessageId = value.focusMessageId ?? null;
  if (focusMessageId !== null && (typeof focusMessageId !== 'string' ||
      !focusMessageId || focusMessageId.length > 200)) {
    throw new Error('Invalid participation focus message ID');
  }
  const note = value.task ?? null;
  if (note !== null && (typeof note !== 'object' || note.kind !== 'plan' ||
      typeof note.summary !== 'string' || !note.summary.trim() || note.summary.length > 300 ||
      typeof note.evidenceId !== 'string' || !note.evidenceId ||
      typeof note.evidenceQuote !== 'string' || !note.evidenceQuote || note.evidenceQuote.length > 200 ||
      (note.status != null && !['open', 'resolved'].includes(note.status)) ||
      (note.resolvesTaskId != null && typeof note.resolvesTaskId !== 'string'))) {
    throw new Error('Invalid participation task note');
  }
  const candidateIds = new Set(stickerCandidates.map(item => item?.stickerId).filter(Boolean));
  const sourceIds = new Set(Array.isArray(target.sourceIds) && target.sourceIds.length
    ? target.sourceIds : [target.id]);
  const stickers = [];
  for (const item of Array.isArray(value.stickers) ? value.stickers : []) {
    if (!item || typeof item !== 'object') continue;
    const stickerId = typeof item.stickerId === 'string' ? item.stickerId : null;
    const sourceId = typeof item.sourceId === 'string' ? item.sourceId : null;
    const stickerReason = typeof item.reason === 'string' ? item.reason.trim().slice(0, 160) : '';
    if (!stickerId || !candidateIds.has(stickerId) || !sourceId || !sourceIds.has(sourceId) ||
        !stickerReason || stickers.some(choice => choice.sourceId === sourceId)) continue;
    stickers.push({ stickerId, sourceId, reason: stickerReason });
  }
  const selfie = value.selfie && typeof value.selfie === 'object' &&
    typeof value.selfie.scene === 'string' && value.selfie.scene.trim() &&
    value.selfie.scene.length <= 200 && !/[\u0000-\u001f]/u.test(value.selfie.scene)
    ? { scene: value.selfie.scene.trim(),
      reason: typeof value.selfie.reason === 'string' ? value.selfie.reason.trim().slice(0, 160) : '' }
    : null;
  const image = value.image && typeof value.image === 'object' &&
    typeof value.image.prompt === 'string' && value.image.prompt.trim() &&
    value.image.prompt.length <= 300 && !/[\u0000-\u001f]/u.test(value.image.prompt)
    ? { prompt: value.image.prompt.trim().slice(0, 300),
      reason: typeof value.image.reason === 'string' ? value.image.reason.trim().slice(0, 160) : '' }
    : null;
  const recalledImageId = typeof value.recalledImageId === 'string' && /^IMG_[a-f0-9]{24}$/u.test(value.recalledImageId) ? value.recalledImageId : null;
  return { shouldReply: value.shouldReply, answeredByHuman: value.answeredByHuman,
    isQuestion: value.isQuestion, isAddressed: value.isAddressed, isFollowup: value.isFollowup,
    reply, reason: value.reason.slice(0, 160), focusMessageId,
    toolRequest, invalidToolRequest, evidenceIds, stickers: recalledImageId ? [] : stickers,
    selfie: recalledImageId ? null : selfie, image: recalledImageId ? null : image, recalledImageId,
    lifeEvents: Array.isArray(value.lifeEvents) ? value.lifeEvents.slice(0, 4) : [],
    socialUpdates: Array.isArray(value.socialUpdates) ? value.socialUpdates.slice(0, 6) : [],
    quoteMessageId: typeof value.quoteMessageId === 'string' && value.quoteMessageId.length <= 200 ? value.quoteMessageId : null,
    voice: value.voice === true,
    pat: !recalledImageId && value.pat === true,
    task: note && { kind: 'plan', summary: note.summary.trim(), evidenceId: note.evidenceId,
      evidenceQuote: note.evidenceQuote, resolvesTaskId: note.resolvesTaskId ?? null,
      status: note.status ?? 'open' } };
}

function trimGenericSuggestion(reply, targetText) {
  if (/(?:建议|推荐|怎么办|怎么做|有没有办法|帮我想|该如何)/u.test(targetText)) return reply;
  const withoutTail = reply.replace(/(?:^|[，,。；;])\s*(?:你(?:可以|要不|不如)?|要不|不然)?\s*(?:翻翻|查查|看看)(?:群里|之前的|以前的)?(?:聊天)?记录(?:吧|呀|呢)?[？?。！!]*$/u, '')
    .replace(/(?:^|[，,。；;])\s*(?:你(?:可以|要不)?|要不)?\s*问问(?:别人|群友|其他人|大家)(?:吧|呀|呢)?[？?。！!]*$/u, '').trim();
  if (withoutTail === reply || !withoutTail) return withoutTail;
  return /[。！？!?]$/u.test(withoutTail) ? withoutTail : `${withoutTail}。`;
}

function isCannedFillerReply(reply) {
  // Short acknowledgements and honest uncertainty are valid in context. The model
  // decides relevance; this guard only rejects established canned deflections.
  return /谁来补一嘴|懂[，,]?接着说[，,]?后来呢/u.test(reply) ||
    /^本公主也来凑个热闹[，,。！？!?\s]*$/u.test(reply) ||
    /(?:不知道|不清楚|不确定|没概念|没头绪)[^。！？!?]{0,30}(?:谁(?:知道|来)|有人(?:知道|懂)|大家(?:知道|来))/u.test(reply);
}
const replyFingerprint = reply => reply.normalize('NFKC').toLowerCase()
  .replace(/[\p{P}\p{S}\s]/gu, '');
const BODY_STATE_REPLY = /(困|饿|躺|眯|刚醒|没醒|没睡|睡(?:觉|了|醒|着|一会|会儿|哪门子|多久|不着|午觉|懒觉|回笼觉))/u;
const repeatsBodyState = (reply, recent) => BODY_STATE_REPLY.test(reply) &&
  recent.some(item => BODY_STATE_REPLY.test(item));

function uniqueFocusTypo(focusId, messages) {
  if (!focusId?.startsWith('msg_')) return null;
  const matches = [...new Set(messages.map(item => item.id))].filter(id => {
    if (!id.startsWith('msg_') || id.length !== focusId.length) return false;
    let differences = 0;
    for (let index = 0; index < id.length; index++) {
      if (id[index] !== focusId[index] && ++differences > 1) return false;
    }
    return differences === 1;
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function runParticipationCycle({ ledger, adapter, model, inboxPath, accountId, groupId,
  now = Date.now(), aliases = defaultAliases, startAtLatest = true, sendEnabled = false,
  coreFacts = [], latestDiary = null, lookupDiary, lookupMemberProfile,
  lookupRelatedProfiles, lookupMemberIdentity, useTool, stickerCandidates = [],
  sendStickers = null, stickerShadow = false, lookupTrends = null, sendSelfie = null,
  sendImage = null, lookupLifeEvents = null, recordLifeEvents = null,
  resolveQuote = null, sendVoice = null, lookupSocialContext = null, recordSocialUpdates = null,
  sendRecalledImage = null, sendPat = null, lookupInteractionPreferences = () => ({}),
  enrichModelInput = input => input,
  voiceRandomProbability = Number(process.env.SOCIOMEM_VOICE_RANDOM_RATE ?? 0.15) }) {
  if (!adapter.allowed.has(groupId) || adapter.client.accountId !== accountId ||
      ledger.store.accountId !== accountId) throw new Error('Participation scope mismatch');
  ledger.maintainTasks({ groupId, inboxPath, now });
  const observed = observeNewMessages({ ledger, inboxPath, accountId, groupId, now, aliases, startAtLatest });
  ledger.prioritizeFollowups(groupId, now);
  if (observed) ledger.reopenQuestion(groupId, ledger.cursor(groupId), now);
  const awaiting = ledger.receiptTask(groupId);
  if (awaiting) {
    const result = await adapter.reconcile(awaiting.outbox_key, AbortSignal.timeout(30000));
    const state = result.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(result.state) ? 'pending_receipt' : 'needs_review';
    ledger.transition(awaiting.source_id, state, result.state, awaiting.outbox_key);
    if (state === 'sent') ledger.settleTask(awaiting.source_id, 'resolved', now);
    return { status: state, sourceId: awaiting.source_id, kind: awaiting.kind, key: awaiting.outbox_key };
  }
  const task = ledger.due(groupId, now);
  if (!task) return { status: 'waiting', observed };
  const key = `sociomem-auto-${createHash('sha256').update(JSON.stringify([accountId, groupId, task.source_id])).digest('hex')}`;
  const existing = ledger.store.sendRecord(key);
  if (existing && existing.state !== 'draft') {
    const result = await adapter.reconcile(key, AbortSignal.timeout(30000));
    const state = result.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(result.state) ? 'pending_receipt' : 'needs_review';
    ledger.transition(task.source_id, state, `existing_outbox_${result.state}`, key);
    if (state === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
    return { status: state, sourceId: task.source_id, kind: task.kind, key };
  }
  const sourceIds = JSON.parse(task.source_ids_json);
  const sourceRows = readInbox(inboxPath, { accountId, groupId, afterRowid: task.rowid - 1, limit: 256 })
    .filter(item => sourceIds.includes(item.id));
  const first = sourceRows[0];
  if (!first || first.id !== task.source_id || sourceRows.length !== sourceIds.length) {
    throw new Error('Participation source changed');
  }
  const target = { ...first, text: sourceRows.map(item => item.text.slice(0, 180)).join('\n'), sourceIds,
    mentions: { state: 'known', self: sourceRows.some(item => item.mentions?.self === true),
      userIds: [...new Set(sourceRows.flatMap(item => item.mentions?.userIds ?? []))] } };
  if (age(target, now) > 20 * 60000) {
    ledger.transition(task.source_id, 'expired', 'conversation_too_old');
    ledger.settleTask(task.source_id, 'expired', now);
    return { status: 'expired', sourceId: task.source_id };
  }
  const hardMandatory = task.kind === 'mention';
  const previousAgentMessage = ledger.recentAgentQuestion(groupId, task.observed_at);
  const recentAgentReplies = ledger.recentAgentReplies(groupId, now);
  const recentAgentMessages = ledger.recentAgentMessages(groupId, now);
  const openTasks = ledger.openTasks(groupId);
  let personProfile = null;
  if (typeof lookupMemberProfile === 'function') {
    try { personProfile = await lookupMemberProfile(target.senderId); }
    catch (error) { ledger.store.trace('participation.member_profile_error', {
      sourceId: task.source_id, errorType: error.name }); }
  }
  let decision, context, relevantDiary = [];
  const toolResults = [];
  const momentsEvidenceIds = new Set();
  const requested = new Set();
  let invalidRequests = 0;
  let trendContext = [];
  if (typeof lookupTrends === 'function') {
    try {
      trendContext = await lookupTrends(target,
        readInbox(inboxPath, { accountId, groupId, recent: true, limit: 20 }));
      if (!Array.isArray(trendContext)) trendContext = [];
    } catch (error) {
      ledger.store.trace('participation.trends_error', {
        sourceId: task.source_id, errorType: error.name });
    }
  }
  const preferenceSubjects = new Set(sourceRows.map(item => item.senderId));
  for (let step = 0; step < 4; step++) {
    const following = readInbox(inboxPath, { accountId, groupId,
      afterRowid: task.latest_rowid, limit: 10 });
    const recent = readInbox(inboxPath, { accountId, groupId, recent: true, limit: 999 });
    context = selectConversationContext([...new Map([...following, ...recent]
      .map(item => [item.id, item])).values()].sort((a, b) => a.rowid - b.rowid), now);
    const speakerIds = [...new Set(context.map(item => item.senderId))];
    const identities = new Map();
    if (typeof lookupMemberIdentity === 'function') {
      for (const senderId of speakerIds) {
        try { identities.set(senderId, await lookupMemberIdentity(senderId)); }
        catch (error) { ledger.store.trace('participation.member_identity_error', {
          sourceId: task.source_id, errorType: error.name }); }
      }
    }
    const namedContext = context.map(item => ({ ...item,
      speaker: identities.get(item.senderId) ?? null }));
    relevantDiary = [];
    if (typeof lookupDiary === 'function') {
      try { relevantDiary = await lookupDiary(target, namedContext); }
      catch (error) { ledger.store.trace('participation.memory_error', { sourceId: task.source_id,
        errorType: error.name }); }
    }
    let relatedProfiles = [];
    if (typeof lookupRelatedProfiles === 'function') {
      try { relatedProfiles = await lookupRelatedProfiles(target, namedContext, relevantDiary); }
      catch (error) { ledger.store.trace('participation.member_profile_error', {
        sourceId: task.source_id, errorType: error.name }); }
    }
    const currentTime = { utc: new Date(now).toISOString(), timezone: 'Asia/Shanghai',
      local: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric',
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
        hourCycle: 'h23' }).format(new Date(now)) };
    let socialContext = { activities: [], relationships: [] };
    if (typeof lookupSocialContext === 'function') {
      try { socialContext = await lookupSocialContext(target, namedContext); }
      catch (error) { ledger.store.trace('social_context.lookup_error', { errorType: error.name }); }
    }
    for (const userId of [...context.map(item => item.senderId), ...relatedProfiles.map(item => item.userId),
      ...(socialContext.members ?? []).map(item => item.userId)].filter(Boolean)) preferenceSubjects.add(userId);
    const modelInput = await enrichModelInput({ target, context: namedContext, kind: task.kind, currentTime, now,
      mustReply: hardMandatory, previousAgentMessage,
      coreFacts, latestDiary, relevantDiary, relatedProfiles,
      recentAgentReplies, recentAgentMessages,
      openTasks, personProfile, stickers: stickerCandidates, trendContext,
      futureEvents: typeof lookupLifeEvents === 'function' ? lookupLifeEvents() : [],
      socialContext,
      actions: { pat: typeof sendPat === 'function', imageRecall: typeof sendRecalledImage === 'function' },
      toolResults, remainingToolCalls: Math.max(0, 2 - toolResults.length) });
    for (const item of modelInput.momentsContext?.matches ?? []) momentsEvidenceIds.add(item.id);
    const proposed = validateDecision(await model(modelInput), target,
      stickerCandidates);
    const visibleMessages = [...sourceRows, ...context];
    if (proposed.lifeEvents.length && typeof recordLifeEvents === 'function') {
      try { await recordLifeEvents(proposed.lifeEvents, sourceRows); }
      catch (error) { ledger.store.trace('life_events.proposal_rejected', { errorType: error.name }); }
    }
    if (proposed.socialUpdates.length && typeof recordSocialUpdates === 'function') {
      try { await recordSocialUpdates(proposed.socialUpdates, sourceRows); }
      catch (error) { ledger.store.trace('social_context.proposal_rejected', { errorType: error.name }); }
    }
    let originalFocusMessageId = null;
    if (proposed.reply && proposed.focusMessageId &&
        !visibleMessages.some(item => item.id === proposed.focusMessageId)) {
      const corrected = uniqueFocusTypo(proposed.focusMessageId, visibleMessages);
      if (corrected) {
        originalFocusMessageId = proposed.focusMessageId;
        proposed.focusMessageId = corrected;
        ledger.store.trace('participation.reply_focus_corrected', {
          sourceId: task.source_id, focusMessageId: corrected, reason: 'unique_one_character_typo' });
      }
    }
    const focus = proposed.focusMessageId
      ? visibleMessages.find(item => item.id === proposed.focusMessageId) : null;
    ledger.recordJudgment(task.source_id, step + 1, context.map(item => item.id), {
      ...proposed, originalFocusMessageId, targetSenderId: target.senderId,
      focusSenderId: focus?.senderId ?? null });
    if (proposed.invalidToolRequest) {
      ledger.store.trace('agent_tool.rejected', { sourceId: task.source_id,
        reason: 'invalid_format' });
      if (++invalidRequests > 1) break;
      toolResults.push({ name: 'invalid_request', error:
        'Use toolRequest={name:"recent_messages"}, {name:"history_search",query:"keyword",senderId:"M_ speakerKey (optional)",from:"YYYY-MM-DD (optional)",to:"YYYY-MM-DD (optional)"}, or {name:"memory_search"|"diary_search",query:"short search"}.' });
      continue;
    }
    if (proposed.toolRequest) {
      const request = proposed.toolRequest;
      const signature = JSON.stringify(request);
      if (!useTool || toolResults.length >= 2 || requested.has(signature)) {
        ledger.store.trace('agent_tool.rejected', { sourceId: task.source_id, name: request.name,
          reason: !useTool ? 'unavailable' : toolResults.length >= 2 ? 'budget' : 'duplicate' });
        if (toolResults.length >= 2 || requested.has(signature)) break;
        toolResults.push({ name: request.name, error: 'unavailable' });
        continue;
      }
      requested.add(signature);
      try {
        const result = await useTool(request, { task, target,
          ...(request.name === 'moments_search' ? { context: namedContext, relatedProfiles, now } : {}) });
        if (!result || result.name !== request.name) throw new Error('Tool result mismatch');
        toolResults.push(result);
        ledger.store.trace('agent_tool.called', { sourceId: task.source_id, name: request.name,
          count: result.matches?.length ?? result.messages?.length ?? 0 });
      } catch (error) {
        toolResults.push({ name: request.name, error: 'unavailable' });
        ledger.store.trace('agent_tool.error', { sourceId: task.source_id, name: request.name,
          errorType: error.name });
      }
      continue;
    }
    const newest = latestRowid(inboxPath, accountId, groupId);
    if (newest !== (recent.at(-1)?.rowid ?? 0)) continue;
    decision = proposed;
    break;
  }
  if (!decision) {
    if (hardMandatory) ledger.transition(task.source_id, 'needs_review', 'agent_step_budget_exhausted');
    else {
      ledger.transition(task.source_id, 'skipped', 'agent_step_budget_exhausted');
      if (task.kind === 'question') ledger.keepQuestionOpen(task, latestRowid(inboxPath, accountId, groupId), now, sourceRows[0]);
    }
    return { status: hardMandatory ? 'needs_review' : 'skipped', sourceId: task.source_id };
  }
  const replyPersonId = [...sourceRows, ...context].find(item => item.id === decision.focusMessageId)?.senderId ?? target.senderId;
  const preferenceAllowsText = () => ![...preferenceSubjects].some(userId =>
    (lookupInteractionPreferences(userId).blockedNames ?? []).some(name => name &&
      decision.reply.normalize('NFKC').toLowerCase().includes(name.normalize('NFKC').toLowerCase())));
  if (!preferenceAllowsText()) {
    ledger.defer(task.source_id, now + 15000, 'interaction_preference_changed');
    return { status: 'deferred', sourceId: task.source_id };
  }
  if (isNeedlesslyCruel(decision.reply)) {
    ledger.store.trace('participation.reply_rejected', {
      sourceId: task.source_id, reason: 'needlessly_cruel_tone' });
    decision.reply = '';
    decision.shouldReply = false;
  }
  if (decision.reply && [...new Set([...sourceRows, ...context].map(item => item.senderId))]
    .some(senderId => senderId && decision.reply.includes(senderId))) {
    ledger.store.trace('participation.reply_rejected', {
      sourceId: task.source_id, reason: 'internal_sender_id_in_reply' });
    decision.reply = '';
  }
  const messageEvidence = new Map([...sourceRows, ...context].map(item => [item.id, item]));
  if (decision.reply && decision.focusMessageId &&
      !messageEvidence.has(decision.focusMessageId)) {
    const state = hardMandatory ? 'needs_review' : 'skipped';
    ledger.transition(task.source_id, state, 'unknown_reply_focus');
    return { status: state, sourceId: task.source_id };
  }
  // The invitation claim requires an actual source; an @ mention is no evidence of it.
  const claimsInviter = /(?:(?:拉|邀请)(?:了)?(?:我|本公主)进(?:来|(?:这个)?群)|(?:我|本公主)是[^，。！？]{1,24}(?:拉|邀请)进(?:来|(?:这个)?群)的)/u
    .test(decision.reply);
  const invitationSource = [...messageEvidence.values()].some(item =>
    (!item.interaction || item.interaction === 'text') && !item.quote &&
    !/[?？]|谁(?:拉|邀请)/u.test(item.text) &&
    /(?:拉|邀请)(?:了)?(?:你|肥鱼|肥鱼不肥|本公主)进(?:来|(?:这个)?群)/u.test(item.text));
  if (claimsInviter && !invitationSource) {
    const state = hardMandatory ? 'needs_review' : 'skipped';
    ledger.transition(task.source_id, state, 'unsupported_group_inviter_claim');
    return { status: state, sourceId: task.source_id };
  }
  const evidenceIds = new Set(messageEvidence.keys());
  for (const id of momentsEvidenceIds) evidenceIds.add(id);
  for (const item of relevantDiary) {
    evidenceIds.add(item.id);
    for (const id of item.sourceMessageIds ?? []) evidenceIds.add(id);
  }
  for (const result of toolResults) {
    for (const item of result.messages ?? []) evidenceIds.add(item.id);
    for (const item of result.images ?? []) evidenceIds.add(item.sourceMessageId);
    if (result.name === 'article_read' && result.status === 'ok') evidenceIds.add(result.sourceMessageId);
    for (const item of result.matches ?? []) {
      evidenceIds.add(item.id);
      if (item.sourceMessageId) evidenceIds.add(item.sourceMessageId);
      for (const id of item.sourceMessageIds ?? []) evidenceIds.add(id);
    }
  }
  if (decision.task) {
    const note = decision.task;
    const source = sourceRows.find(item => item.id === note.evidenceId);
    if (!source?.text.includes(note.evidenceQuote)) {
      ledger.store.trace('agent_task.plan_rejected', {
        sourceId: task.source_id, errorType: 'EvidenceMismatch' });
      decision.task = null;
    }
  }
  const toolHadEvidence = toolResults.some(result => (result.matches?.length ?? result.messages?.length ?? result.images?.length ?? 0) > 0 ||
    (result.name === 'article_read' && result.status === 'ok'));
  if (decision.evidenceIds.some(id => !evidenceIds.has(id)) ||
      (toolHadEvidence && decision.reply && decision.evidenceIds.length === 0)) {
    const state = hardMandatory ? 'needs_review' : 'skipped';
    ledger.transition(task.source_id, state, 'unverifiable_tool_answer');
    if (task.kind === 'question') ledger.keepQuestionOpen(task, latestRowid(inboxPath, accountId, groupId), now, sourceRows[0]);
    return { status: state, sourceId: task.source_id };
  }
  if (decision.task) {
    const note = decision.task;
    try { ledger.notePlan({ sourceId: task.source_id, groupId, rowid: task.rowid,
      summary: note.summary, evidenceId: note.evidenceId,
      evidenceQuote: note.evidenceQuote, resolvesTaskId: note.resolvesTaskId, status: note.status }, now); }
    catch (error) { ledger.store.trace('agent_task.plan_rejected', {
      sourceId: task.source_id, errorType: error.name }); }
  }
  if (task.kind === 'plan' && !decision.reply && !decision.shouldReply) {
    ledger.transition(task.source_id, 'skipped', decision.task ? 'plan_recorded_without_reply' : 'plan_candidate_ignored');
    return { status: 'skipped', sourceId: task.source_id };
  }
  const trueFollowup = task.kind === 'followup' && Boolean(previousAgentMessage) && decision.isFollowup;
  const mandatory = hardMandatory || trueFollowup ||
    (task.kind === 'question' && decision.isQuestion && decision.shouldReply);
  const laterHuman = context.some(item => item.rowid > target.rowid && item.senderId !== target.senderId);
  const stickerRequested = /(?:发|来|给|整|甩|要|看).{0,8}(?:个|张|一个|一张)?表情包?|表情包(?:呢|拿来|发我|给我)/u
    .test(target.text);
  let stickerChoices = decision.stickers;
  if ((task.kind !== 'ordinary' && !stickerRequested) || (hardMandatory && !stickerRequested)) {
    if (stickerChoices.length) ledger.store.trace('participation.stickers_rejected', {
      sourceId: task.source_id, reason: 'task_kind' });
    stickerChoices = [];
  }
  let hasSticker = stickerChoices.length > 0;
  if (hasSticker && stickerRequested) ledger.store.trace('participation.sticker_requested', {
    sourceId: task.source_id, stickers: stickerChoices.map(choice => choice.stickerId) });
  const selfiePattern = /(?:发|来|给|拍|整|看看?|瞧瞧).{0,12}(?:自拍|你自己的?照片|你的照片|图片|照片|你长什么样|你长啥样)|自拍(?:呢|来一张|一张|发我|给我|看看)|看看你长(?:什么|啥)样/u;
  const selfieRequested = selfiePattern.test(target.text) &&
    (task.kind === 'mention' || target.mentions?.self === true || /你|肥鱼/u.test(target.text));
  let selfieChoice = decision.selfie;
  if (selfieChoice && !selfieRequested) {
    ledger.store.trace('participation.selfie_rejected', { sourceId: task.source_id, reason: 'not_requested' });
    selfieChoice = null;
  }
  if (selfieChoice) ledger.store.trace('participation.selfie_requested', {
    sourceId: task.source_id, scene: selfieChoice.scene });
  const hasSelfie = Boolean(selfieChoice);
  const imagePattern = /(?:画|绘制|生成|做|整|来|发|看看?|瞧瞧|看一下|想看).{0,12}(?:一张|张|个)?(?:图|图片|画|照片)|(?:画|绘制)(?:一|个|张|碗|只|条|朵|座|杯|盘)/u;
  const addressedToAgent = text => /你|肥鱼/u.test(text);
  const recentImageRequest = context.some(item => {
    const at = Date.parse(item.at);
    return Number.isFinite(at) && now - at <= 5 * 60000 && imagePattern.test(item.text) &&
      (item.mentions?.self === true || addressedToAgent(item.text));
  });
  const imageRequested = recentImageRequest || (imagePattern.test(target.text) &&
    (task.kind === 'mention' || target.mentions?.self === true || addressedToAgent(target.text)));
  let imageChoice = decision.image;
  if (imageChoice && (!imageRequested || hasSelfie)) {
    ledger.store.trace('participation.image_rejected', { sourceId: task.source_id,
      reason: hasSelfie ? 'selfie_preferred' : 'not_requested' });
    imageChoice = null;
  }
  if (imageChoice) ledger.store.trace('participation.image_requested', {
    sourceId: task.source_id, prompt: imageChoice.prompt });
  const hasRecall = Boolean(decision.recalledImageId && typeof sendRecalledImage === 'function');
  const patSource = sourceRows.find(item => item.interaction === 'pat') ?? target;
  const hasPat = decision.pat && typeof sendPat === 'function' && !lookupInteractionPreferences(patSource.senderId).patDisabled && !decision.isQuestion &&
    (patSource.interaction === 'pat' || task.kind === 'ordinary') && !hasRecall && !hasSelfie && !imageChoice && !hasSticker;
  const hasImage = hasSelfie || Boolean(imageChoice) || hasRecall || hasPat;
  if (!mandatory && laterHuman && decision.answeredByHuman && !decision.shouldReply && !hasSticker &&
      !hasSelfie) {
    ledger.transition(task.source_id, 'answered', 'human_replied');
    ledger.settleTask(task.source_id, 'answered', now);
    return { status: 'answered', sourceId: task.source_id };
  }
  if (!hardMandatory && repeatsBodyState(decision.reply, recentAgentReplies)) {
    ledger.store.trace('participation.body_state_repeat', { sourceId: task.source_id,
      reply: decision.reply });
    decision.reply = '';
    decision.shouldReply = false;
  }
  const repeatedReply = recentAgentReplies.some(reply => replyFingerprint(reply) === replyFingerprint(decision.reply));
  // Choosing to answer an unaddressed question does not waive repetition checks.
  const repeatedOptionalReply = repeatedReply && !hardMandatory && !trueFollowup;
  if ((hasSticker || hasImage) &&
      (!decision.reply || isCannedFillerReply(decision.reply) || repeatedOptionalReply)) {
    decision.reply = '';
  }
  if ((!decision.reply && !hasSticker && !hasImage) || (decision.reply && isCannedFillerReply(decision.reply)) ||
      (repeatedOptionalReply && !hasSticker && !hasImage)) {
    if (hardMandatory || trueFollowup) {
      if (task.reason === 'empty_mention_retry') {
        ledger.transition(task.source_id, 'needs_review', 'direct_mention_without_substantive_reply');
        return { status: 'needs_review', sourceId: task.source_id };
      }
      ledger.defer(task.source_id, now + 30000, 'empty_mention_retry');
      return { status: 'deferred', sourceId: task.source_id };
    }
    if (!mandatory && !decision.isQuestion && now < task.deadline_at) {
      ledger.defer(task.source_id, task.deadline_at, 'waiting_for_human_reply');
      return { status: 'deferred', sourceId: task.source_id };
    }
    ledger.transition(task.source_id, 'skipped', 'no_substantive_reply');
    if (task.kind === 'question' && decision.isQuestion) {
      ledger.keepQuestionOpen(task, latestRowid(inboxPath, accountId, groupId), now, sourceRows[0]);
    }
    return { status: 'skipped', sourceId: task.source_id };
  }
  if (!mandatory && !decision.shouldReply && !hasSticker && !hasImage) {
    if (decision.isQuestion) {
      ledger.transition(task.source_id, 'skipped', 'question_without_useful_reply');
      if (task.kind === 'question') ledger.keepQuestionOpen(task, latestRowid(inboxPath, accountId, groupId), now, sourceRows[0]);
      return { status: 'skipped', sourceId: task.source_id };
    }
    if (now < task.deadline_at) {
      ledger.defer(task.source_id, task.deadline_at, 'waiting_for_human_reply');
      return { status: 'deferred', sourceId: task.source_id };
    }
    ledger.transition(task.source_id, 'skipped', 'ordinary_no_reply_needed');
    return { status: 'skipped', sourceId: task.source_id };
  }
  if (!hardMandatory && task.kind !== 'question' && !hasSticker && !hasImage) {
    const lastAgentAt = ledger.db.prepare(`SELECT MAX(attempted_at) AS at FROM outbox
      WHERE group_id=? AND state='accepted'`).get(groupId).at;
    if (lastAgentAt !== null && lastAgentAt > task.observed_at) {
      ledger.transition(task.source_id, 'covered', 'agent_already_joined_conversation');
      return { status: 'covered', sourceId: task.source_id };
    }
    const cooldown = trueFollowup ? 30000 : 180000;
    if (lastAgentAt !== null && now < lastAgentAt + cooldown) {
      ledger.defer(task.source_id, lastAgentAt + cooldown, 'optional_reply_cooldown');
      return { status: 'deferred', sourceId: task.source_id };
    }
  }
  if (sendEnabled && ((!hasSticker && !hasImage) || hasRecall || hasPat)) {
    const last = ledger.db.prepare('SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=?').get(groupId).at;
    if (last !== null && now < last + adapter.cooldownMs) {
      ledger.defer(task.source_id, last + adapter.cooldownMs + 1, 'group_cooldown');
      return { status: 'deferred', sourceId: task.source_id };
    }
  }
  const reply = decision.reply;
  if (!sendEnabled) {
    ledger.transition(task.source_id, 'shadowed', decision.reason);
    return { status: 'shadowed', sourceId: task.source_id, kind: task.kind, reply,
      stickers: stickerChoices.map(choice => choice.stickerId) };
  }
  if (hasRecall) {
    let recalled;
    try { recalled = await sendRecalledImage({ task, target, groupId, imageId: decision.recalledImageId,
      key, authorize: () => sendEnabled && latestRowid(inboxPath, accountId, groupId) === (context.at(-1)?.rowid ?? target.rowid),
      signal: AbortSignal.timeout(90000) }); }
    catch (error) {
      ledger.store.trace('participation.image_recall_error', { sourceId: task.source_id, errorType: error.name });
      recalled = { state: 'needs_review', safeToFallback: false };
    }
    // Never replace a missing/ambiguous original with a generated image or resend after an uncertain receipt.
    if (!recalled.safeToFallback || !reply || /(?:发|传|给).{0,4}(?:了|过去|你了)|这(?:张|个|里)(?:就是|是)|找到了/u.test(reply)) {
      const state = recalled.state === 'sent' ? 'sent' : recalled.safeToFallback ? 'skipped' : 'needs_review';
      ledger.transition(task.source_id, state, `image_recall_${recalled.state}`, recalled.outboxKey ?? key);
      if (state === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
      return { status: state, sourceId: task.source_id, kind: task.kind, key: recalled.outboxKey ?? key, recalledImage: recalled.state };
    }
    if (latestRowid(inboxPath, accountId, groupId) !== (context.at(-1)?.rowid ?? target.rowid)) {
      ledger.defer(task.source_id, now + 15000, 'image_recall_context_changed');
      return { status: 'deferred', sourceId: task.source_id };
    }
  }
  if (hasPat) {
    const patted = await sendPat({ task, target: patSource, groupId, signal: AbortSignal.timeout(30000) });
    ledger.store.trace('participation.pat', { sourceId: task.source_id, state: patted.state, reason: patted.reason });
    if (['accepted', 'needs_review', 'submitting'].includes(patted.state)) {
      const state = patted.state === 'accepted' ? 'sent' : 'needs_review';
      const patKey = patted.key ?? key;
      ledger.db.prepare(`INSERT OR IGNORE INTO outbox(key,group_id,text,state,receipt,approved,attempted_at,mentions_json)
        VALUES (?,?,?,?,?,1,?,'[]')`).run(patKey, groupId, '[拍了拍群友]', state === 'sent' ? 'accepted' : 'needs_review', JSON.stringify({ ...patted, channel: 'pat' }), now);
      ledger.transition(task.source_id, state, `pat_${patted.state}`, patKey);
      if (state === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
      return { status: state, sourceId: task.source_id, key: patKey, pat: patted.state };
    }
    // An unavailable/cooldown-rejected action is never presented as a successful pat.
    if (!reply) { ledger.transition(task.source_id, 'needs_review', `pat_${patted.state}`);
      return { status: 'needs_review', sourceId: task.source_id, pat: patted.state }; }
  }
  let textState = null;
  let voiceChoice = { selected: false, reason: 'unavailable' };
  if (reply && typeof sendVoice === 'function' && !lookupInteractionPreferences(replyPersonId).voiceDisabled && !hasSticker && !hasImage) {
    try {
      voiceChoice = chooseVoiceReply({ text: reply, sourceRows,
        addressed: hardMandatory || decision.isAddressed || /肥鱼|本公主/u.test(target.text),
        kind: task.kind, isQuestion: decision.isQuestion, key,
        probability: decision.quoteMessageId ? 0 : voiceRandomProbability });
    } catch (error) {
      voiceChoice = { selected: false, reason: 'invalid_config' };
      ledger.store.trace('participation.voice_selection_error', { errorType: error.name });
    }
    ledger.store.trace('participation.voice_selection', { sourceId: task.source_id, ...voiceChoice });
  }
  if (voiceChoice.selected) {
    let voice;
    try { voice = await sendVoice({ task, target, recipientId: replyPersonId, authorizeText: preferenceAllowsText,
      groupId, text: reply, key, signal: AbortSignal.timeout(90000) }); }
    catch (error) {
      ledger.store.trace('participation.voice_error', { errorType: error.name });
      voice = { state: 'needs_review', safeToFallback: false };
    }
    if (!voice.safeToFallback) {
      const state = voice.state === 'sent' ? 'sent' : 'needs_review';
      ledger.transition(task.source_id, state, `voice_${voice.state}`, key);
      if (state === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
      return { status: state, sourceId: task.source_id, kind: task.kind, key, voice: voice.state };
    }
  }
  if (reply) {
    const text = reply;
    let quote = null;
    const quoteId = decision.quoteMessageId ?? (decision.focusMessageId &&
      context.at(-1)?.id !== decision.focusMessageId && new Set(context.slice(-6).map(x => x.senderId)).size > 1
      ? decision.focusMessageId : null);
    if (quoteId && typeof resolveQuote === 'function' && [...sourceRows, ...context].some(x => x.id === quoteId)) {
      try { quote = await resolveQuote(quoteId); }
      catch (error) { ledger.store.trace('participation.quote_unavailable', { errorType: error.name }); }
    }
    const draft = existing && (existing.text !== text || existing.quote_json !== JSON.stringify(quote))
      ? ledger.store.reviseUnsentDraft(key, text, quote)
      : existing ?? adapter.propose({ key, groupId, text, quote });
    if (draft.state === 'draft') ledger.store.approve(key);
    const result = await adapter.sendApproved(key, AbortSignal.timeout(30000), { authorize: preferenceAllowsText });
    textState = result.state === 'accepted' ? 'sent' :
      ['queued', 'submitting'].includes(result.state) ? 'pending_receipt' : 'needs_review';
    ledger.transition(task.source_id, textState, result.state, key);
    if (textState === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
  }
  let shadowedStickerIds = [];
  if (hasSticker && stickerShadow) {
    shadowedStickerIds = stickerChoices.map(choice => choice.stickerId);
    ledger.store.trace('participation.sticker_shadow', { sourceId: task.source_id,
      stickers: shadowedStickerIds });
    stickerChoices = [];
    hasSticker = false;
    if (!hasImage) {
      if (!reply) {
        ledger.transition(task.source_id, 'shadowed', 'sticker_shadow', null);
        return { status: 'shadowed', sourceId: task.source_id, kind: task.kind,
          stickers: shadowedStickerIds };
      }
      return { status: textState, sourceId: task.source_id, kind: task.kind, key,
        stickers: shadowedStickerIds };
    }
  }
  let stickerOutcome = null;
  if (hasSticker) {
    if (typeof sendStickers !== 'function') {
      ledger.store.trace('participation.stickers_unavailable', { sourceId: task.source_id });
      stickerOutcome = { results: [], sent: 0, pending: 0, failed: stickerChoices.length };
    } else {
      stickerOutcome = await sendStickers({ task, target, groupId, stickers: stickerChoices,
        signal: AbortSignal.timeout(30000) });
    }
  }
  let selfieOutcome = null;
  if (hasSelfie) {
    if (typeof sendSelfie !== 'function') {
      ledger.store.trace('participation.selfie_unavailable', { sourceId: task.source_id });
      selfieOutcome = { state: 'needs_review' };
    } else {
      try {
        selfieOutcome = await sendSelfie({ task, target, groupId, selfie: selfieChoice,
          signal: AbortSignal.timeout(180000) });
      } catch (error) {
        ledger.store.trace('participation.selfie_failed', { sourceId: task.source_id,
          errorType: error.name });
        selfieOutcome = { state: 'needs_review', errorType: error.name };
      }
    }
  }
  let imageOutcome = null;
  if (imageChoice) {
    if (typeof sendImage !== 'function') {
      ledger.store.trace('participation.image_unavailable', { sourceId: task.source_id });
      imageOutcome = { state: 'needs_review' };
    } else {
      try {
        imageOutcome = await sendImage({ task, target, groupId, image: imageChoice,
          signal: AbortSignal.timeout(180000) });
      } catch (error) {
        ledger.store.trace('participation.image_failed', { sourceId: task.source_id,
          errorType: error.name });
        imageOutcome = { state: 'needs_review', errorType: error.name };
      }
    }
  }
  if (!reply && (hasSticker || hasImage)) {
    const stickerOk = (stickerOutcome?.sent ?? 0) + (stickerOutcome?.pending ?? 0) > 0;
    const selfieOk = ['sent', 'pending_receipt'].includes(selfieOutcome?.state);
    const imageOk = ['sent', 'pending_receipt'].includes(imageOutcome?.state);
    const state = (hasSticker && !stickerOk) || (hasSelfie && !selfieOk) ||
      (imageChoice && !imageOk) ? 'needs_review' : 'sent';
    const reason = hasSticker && hasImage ? 'media_only' : hasSticker ? 'sticker_only'
      : hasSelfie ? 'selfie_only' : 'image_only';
    ledger.transition(task.source_id, state, reason, null);
    if (state === 'sent') ledger.settleTask(task.source_id, 'resolved', now);
    return { status: state, sourceId: task.source_id, kind: task.kind, key: null,
      stickers: stickerChoices.length ? stickerChoices.map(choice => choice.stickerId) : shadowedStickerIds,
      selfie: hasSelfie ? selfieChoice.scene : null,
      image: imageChoice?.prompt ?? null };
  }
  if (reply && hasSticker && (stickerOutcome?.failed ?? 0) > 0) {
    ledger.store.trace('participation.stickers_partial', { sourceId: task.source_id,
      sent: stickerOutcome.sent ?? 0, failed: stickerOutcome.failed });
  }
  if (reply && hasSelfie && selfieOutcome?.state !== 'sent' &&
      selfieOutcome?.state !== 'pending_receipt') {
    ledger.store.trace('participation.selfie_partial', { sourceId: task.source_id,
      state: selfieOutcome?.state ?? 'missing' });
  }
  if (reply && imageChoice && imageOutcome?.state !== 'sent' &&
      imageOutcome?.state !== 'pending_receipt') {
    ledger.store.trace('participation.image_partial', { sourceId: task.source_id,
      state: imageOutcome?.state ?? 'missing' });
  }
  return { status: textState,
    sourceId: task.source_id, kind: task.kind, key,
    stickers: stickerChoices.length ? stickerChoices.map(choice => choice.stickerId) : shadowedStickerIds,
    selfie: hasSelfie ? selfieChoice.scene : null,
    image: imageChoice?.prompt ?? null };
}
