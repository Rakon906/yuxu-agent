import { ensureVoiceSendTable, reconcileVoiceSend, sendVoiceReply, voiceSendKey } from './output.mjs';

function ensure(db) {
  ensureVoiceSendTable(db);
  db.exec(`CREATE TABLE IF NOT EXISTS voice_participation (
    voice_key TEXT PRIMARY KEY, outbox_key TEXT NOT NULL UNIQUE, task_id TEXT NOT NULL,
    source_id TEXT NOT NULL, group_id TEXT NOT NULL, text TEXT NOT NULL,
    state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);`);
}
function assertScope(ledger, adapter, client, groupId) {
  if (!ledger?.store || ledger.store !== adapter?.store || ledger.store.accountId !== client?.accountId ||
      typeof groupId !== 'string' || !groupId.endsWith('@chatroom') || !adapter.allowed?.has(groupId)) {
    throw new Error('Voice participation scope mismatch');
  }
}
function recordOutcome(ledger, mapping, result, now) {
  return ledger.store.transaction(() => {
    const accepted = result.state === 'sent';
    const outboxState = accepted ? 'accepted' : 'needs_review';
    const taskState = accepted ? 'sent' : 'needs_review';
    const receipt = { channel: 'voice', voiceKey: mapping.voice_key,
      id: result.jobId ?? null, accountId: ledger.store.accountId, destination: mapping.group_id,
      state: outboxState, job: result.receipt ?? null };
    const prior = ledger.store.sendRecord(mapping.outbox_key);
    if (prior && (prior.group_id !== mapping.group_id || prior.text !== mapping.text ||
        JSON.parse(prior.receipt ?? 'null')?.voiceKey !== mapping.voice_key)) {
      throw new Error('Voice outbox identity conflict');
    }
    ledger.db.prepare(`INSERT INTO outbox (key,group_id,text,state,receipt,approved,attempted_at,mentions_json)
      VALUES (?,?,?,?,?,1,?,'[]') ON CONFLICT(key) DO UPDATE SET state=excluded.state,receipt=excluded.receipt`)
      .run(mapping.outbox_key, mapping.group_id, mapping.text, outboxState, JSON.stringify(receipt), mapping.created_at);
    ledger.db.prepare('UPDATE voice_participation SET state=?,updated_at=? WHERE voice_key=?')
      .run(result.state, now, mapping.voice_key);
    // Deliberately terminal needs_review: the ordinary text receipt loop must never resend this task.
    ledger.db.prepare(`UPDATE participation_tasks SET state=?,reason=?,outbox_key=?
      WHERE source_id=? AND group_id=? AND state IN ('pending','pending_receipt','needs_review')`)
      .run(taskState, `voice_${result.state}`, mapping.outbox_key, mapping.task_id, mapping.group_id);
    ledger.db.prepare(`UPDATE participation_messages SET state=?,reason=?,outbox_key=?
      WHERE task_id=? AND group_id=?`)
      .run(taskState, `voice_${result.state}`, mapping.outbox_key, mapping.task_id, mapping.group_id);
    if (accepted) ledger.settleTask(mapping.task_id, 'resolved', now);
    ledger.store.trace('participation.voice_receipt', { sourceId: mapping.task_id,
      state: result.state, outboxKey: mapping.outbox_key, voiceKey: mapping.voice_key });
    return { ...result, outboxKey: mapping.outbox_key, status: taskState };
  });
}

/** Persist spoken text for history/cooldown; this function never submits a text message. */
export async function sendParticipationVoice({ ledger, adapter, client, task, target, groupId, text, key,
  authorize = async () => true, signal, now = Date.now(), synthesizer, transport, pollAttempts, pollMs }) {
  assertScope(ledger, adapter, client, groupId);
  if (!task || task.group_id !== groupId || !target || target.senderId !== task.sender_id ||
      !JSON.parse(task.source_ids_json).includes(target.id) || typeof key !== 'string' || !key ||
      typeof text !== 'string' || !text.trim()) throw new Error('Invalid voice participation task');
  ensure(ledger.db);
  const voiceKey = voiceSendKey(client.accountId, groupId, task.source_id, target.id);
  const old = ledger.db.prepare('SELECT * FROM voice_participation WHERE voice_key=?').get(voiceKey);
  if (old && (old.outbox_key !== key || old.group_id !== groupId || old.task_id !== task.source_id || old.source_id !== target.id)) {
    throw new Error('Voice participation attempt conflict');
  }
  const existingOutbox = ledger.store.sendRecord(key);
  if (existingOutbox && JSON.parse(existingOutbox.receipt ?? 'null')?.voiceKey !== voiceKey) {
    throw new Error('Task already has another outbound message');
  }
  if (!old) ledger.db.prepare(`INSERT INTO voice_participation
    (voice_key,outbox_key,task_id,source_id,group_id,text,state,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'preparing',?,?)`).run(voiceKey, key, task.source_id, target.id, groupId, text, now, now);
  const mapping = ledger.db.prepare('SELECT * FROM voice_participation WHERE voice_key=?').get(voiceKey);
  const guard = async () => {
    if (!adapter.sendingEnabled || !adapter.allowed.has(groupId)) return false;
    const prior = ledger.db.prepare('SELECT MAX(attempted_at) AS at FROM outbox WHERE group_id=? AND key<>?').get(groupId, key)?.at;
    if (prior !== null && prior !== undefined && now - prior < adapter.cooldownMs) return false;
    return authorize();
  };
  const result = await sendVoiceReply({ db: ledger.db, client, groupId, taskId: task.source_id, sourceId: target.id,
    text: mapping.text, key: voiceKey, authorize: guard, signal, now,
    ...(synthesizer ? { synthesizer } : {}), ...(transport ? { transport } : {}),
    ...(pollAttempts === undefined ? {} : { pollAttempts }), ...(pollMs === undefined ? {} : { pollMs }) });
  if (result.safeToFallback) {
    ledger.db.prepare('UPDATE voice_participation SET state=?,updated_at=? WHERE voice_key=?').run(result.state, now, voiceKey);
    return { ...result, status: 'fallback', outboxKey: null };
  }
  return recordOutcome(ledger, mapping, result, now);
}

/** Reconcile unknown voice outcomes only; never POST, synthesize, upload, or text-fallback. */
export async function reconcileVoiceReplies({ ledger, adapter, client, groupId, signal, now = Date.now(),
  transport, limit = 10 }) {
  assertScope(ledger, adapter, client, groupId);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid voice reconciliation limit');
  ensure(ledger.db);
  const mappings = ledger.db.prepare(`SELECT p.* FROM voice_participation p JOIN voice_sends v ON v.key=p.voice_key
    WHERE p.group_id=? AND p.state NOT IN ('sent','not_sent','failed','cancelled')
    ORDER BY p.updated_at LIMIT ?`).all(groupId, limit);
  const results = [];
  for (const mapping of mappings) {
    const voice = ledger.db.prepare('SELECT state,updated_at FROM voice_sends WHERE key=?').get(mapping.voice_key);
    // Do not mark a concurrent live generator not_sent.
    if (['synthesizing', 'prepared', 'uploading'].includes(voice.state) && now - voice.updated_at < 120000) continue;
    const result = await reconcileVoiceSend({ db: ledger.db, client, key: mapping.voice_key, signal, now,
      ...(transport ? { transport } : {}) });
    if (result.safeToFallback) {
      // If delivery was once ambiguous, later confirmed failure remains terminal; no late fallback.
      if (ledger.store.sendRecord(mapping.outbox_key)) results.push(recordOutcome(ledger, mapping, result, now));
      else {
        ledger.db.prepare('UPDATE voice_participation SET state=?,updated_at=? WHERE voice_key=?')
          .run(result.state, now, mapping.voice_key);
        results.push({ ...result, outboxKey: null, status: 'not_sent' });
      }
    } else results.push(recordOutcome(ledger, mapping, result, now));
  }
  return results;
}
