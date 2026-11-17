import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const reviewKey = sourceMessageId => createHash('sha256').update(sourceMessageId).digest('hex').slice(0, 12);

function inboxReader(db, inboxPath) {
  const source = new DatabaseSync(inboxPath, { readOnly: true });
  const accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
  const inboxAccount = source.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
  if (!accountId || accountId !== inboxAccount) {
    source.close();
    throw new Error('Participation and Inbox account mismatch');
  }
  const find = source.prepare('SELECT message FROM inbox WHERE id=?');
  return { close: () => source.close(), get(id, groupId) {
    const row = find.get(id);
    if (!row) throw new Error('Source message is absent from the authorized Inbox');
    const message = JSON.parse(row.message);
    if (message.accountId !== accountId || message.groupId !== groupId ||
        message.sourceMessageId !== id) throw new Error('Feedback source identity mismatch');
    return message;
  } };
}

const reviewQuery = `SELECT m.source_id,m.task_id,m.group_id,m.sender_id,m.kind,m.observed_at,
  m.state,m.reason,o.text AS sent_reply,f.label,f.preferred_reply,f.note,f.labeled_at,
  (SELECT j.decision_json FROM participation_judgments j
    WHERE j.task_id=m.task_id ORDER BY j.id DESC LIMIT 1) AS decision_json,
  (SELECT j.context_ids_json FROM participation_judgments j
    WHERE j.task_id=m.task_id ORDER BY j.id DESC LIMIT 1) AS context_ids_json
  FROM participation_messages m
  LEFT JOIN outbox o ON o.key=m.outbox_key AND o.state='accepted'
  LEFT JOIN participation_feedback f ON f.source_id=m.source_id`;

function present(row, inbox, includeContext = false) {
  const source = inbox.get(row.source_id, row.group_id);
  const contextIds = row.context_ids_json ? JSON.parse(row.context_ids_json) : [];
  const decision = row.decision_json ? JSON.parse(row.decision_json) : null;
  return { reviewKey: reviewKey(row.source_id), sourceMessageId: row.source_id, taskId: row.task_id,
    groupedWithOtherMessages: row.task_id !== row.source_id,
    groupId: row.group_id, senderId: row.sender_id,
    at: source.eventTime ?? source.recordedAt,
    text: source.text, kind: row.kind, finalState: row.state, reason: row.reason,
    modelDecision: decision && { shouldReply: decision.shouldReply, isQuestion: decision.isQuestion,
      isAddressed: decision.isAddressed, answeredByHuman: decision.answeredByHuman,
      stickers: decision.stickers ?? [], proposedReply: decision.reply, reason: decision.reason },
    sentReply: row.sent_reply ?? null,
    feedback: row.label && { label: row.label, preferredReply: row.preferred_reply,
      note: row.note, labeledAt: row.labeled_at },
    ...(includeContext ? { context: contextIds.map(id => {
      const message = inbox.get(id, row.group_id);
      return { sourceMessageId: id, senderId: message.userId,
        text: message.text, at: message.eventTime ?? message.recordedAt };
    }) } : {}) };
}

export function listParticipationReview(db, inboxPath, { limit = 20 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Review limit must be 1..200');
  const inbox = inboxReader(db, inboxPath);
  try {
    return db.prepare(`${reviewQuery} ORDER BY m.observed_at DESC,m.rowid DESC LIMIT ?`)
      .all(limit).map(row => present(row, inbox));
  } finally { inbox.close(); }
}

export function labelParticipationMessage(db, inboxPath,
  { sourceMessageId, label, preferredReply = null, note = null }) {
  if (!['reply', 'skip', 'unsure'].includes(label)) throw new Error('Label must be reply, skip or unsure');
  if (typeof sourceMessageId !== 'string' || !sourceMessageId || sourceMessageId.length > 300) {
    throw new Error('Invalid source message ID');
  }
  if (preferredReply !== null && (label !== 'reply' || typeof preferredReply !== 'string' ||
      !preferredReply.trim() || preferredReply.length > 300)) throw new Error('Invalid preferred reply');
  if (note !== null && (typeof note !== 'string' || note.length > 1000)) throw new Error('Invalid feedback note');
  let row = db.prepare(`${reviewQuery} WHERE m.source_id=?`).get(sourceMessageId);
  if (!row && /^[a-f0-9]{12}$/u.test(sourceMessageId)) {
    const matches = db.prepare('SELECT source_id FROM participation_messages').all()
      .filter(item => reviewKey(item.source_id) === sourceMessageId);
    if (matches.length > 1) throw new Error('Short review key is ambiguous; use the full message ID');
    if (matches.length === 1) {
      sourceMessageId = matches[0].source_id;
      row = db.prepare(`${reviewQuery} WHERE m.source_id=?`).get(sourceMessageId);
    }
  }
  if (!row) throw new Error('Message is absent from participation records');
  const inbox = inboxReader(db, inboxPath);
  try { inbox.get(sourceMessageId, row.group_id); }
  finally { inbox.close(); }
  db.prepare(`INSERT INTO participation_feedback
    (source_id,label,preferred_reply,note,labeled_at) VALUES (?,?,?,?,?)
    ON CONFLICT(source_id) DO UPDATE SET label=excluded.label,
      preferred_reply=excluded.preferred_reply,note=excluded.note,labeled_at=excluded.labeled_at`)
    .run(sourceMessageId, label, preferredReply?.trim() ?? null, note, new Date().toISOString());
  return { sourceMessageId, label, preferredReply: preferredReply?.trim() ?? null, note };
}

export function exportLabeledParticipation(db, inboxPath) {
  const inbox = inboxReader(db, inboxPath);
  try {
    return db.prepare(`${reviewQuery} WHERE f.label IS NOT NULL ORDER BY f.labeled_at,m.rowid`)
      .all().map(row => present(row, inbox, true));
  } finally { inbox.close(); }
}
