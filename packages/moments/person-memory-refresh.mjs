import { commentBaseCode, commentId, parseCommentMomentDetail } from './comment-reply-native.mjs';
import { decodeMessage, encodeFields, hexToBytes } from './protobuf.mjs';
import { parseTimelineXml } from './timeline.mjs';

const DAY = 24 * 3600000;
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  !/[\u0000-\u001f\u007f]/u.test(value);

function validateXmlBinding(replyHex, expectedId, expectedAuthor, expectedTime) {
  const top = decodeMessage(hexToBytes(replyHex)).fields;
  const object = top.filter(field => field.number === 2 && field.wire === 2);
  if (object.length !== 1) throw new Error('Ambiguous Moments object');
  const fields = decodeMessage(Buffer.from(object[0].bytes, 'hex')).fields;
  const descriptors = fields.filter(field => field.number === 5 && field.wire === 2);
  if (descriptors.length !== 1) throw new Error('Missing Moments original text descriptor');
  const desc = decodeMessage(Buffer.from(descriptors[0].bytes, 'hex')).fields;
  const xmlFields = desc.filter(field => field.number === 2 && field.wire === 2);
  if (xmlFields.length !== 1) throw new Error('Missing Moments original XML');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(xmlFields[0].bytes, 'hex'));
  const parsed = parseTimelineXml(xml);
  if (parsed.id !== expectedId || parsed.username !== expectedAuthor || parsed.createTime !== expectedTime) throw new Error('Moments XML identity mismatch');
}

/** Read-only CGI 210 revalidation. A missing timeline entry is never treated as a deletion. */
export async function refreshMomentMemory({ memory, client, accountId, now = Date.now(), limit = 8 } = {}) {
  if (!memory?.db || typeof memory.record !== 'function' || typeof client?.probe !== 'function' ||
      !identity(accountId) || client.accountId !== accountId || !Number.isSafeInteger(now) || now <= 0 ||
      !Number.isSafeInteger(limit) || limit < 0 || limit > 20) throw new Error('Invalid Moments refresh scope');
  memory.db.exec(`CREATE TABLE IF NOT EXISTS moments_memory_checks (
    account_id TEXT NOT NULL, moment_id TEXT NOT NULL, attempted_at INTEGER NOT NULL,
    status TEXT NOT NULL, error_type TEXT, PRIMARY KEY(account_id,moment_id));`);
  const rows = memory.db.prepare(`SELECT s.* FROM moments_sources s LEFT JOIN moments_memory_checks c
    ON c.account_id=s.account_id AND c.moment_id=s.moment_id
    WHERE s.account_id=? AND s.state='visible' AND s.checked_at<=?
      AND (c.attempted_at IS NULL OR c.attempted_at<=?)
    ORDER BY COALESCE(c.attempted_at,0),s.checked_at,s.moment_id LIMIT ?`)
    .all(accountId, now - DAY, now - DAY, limit);
  const result = { attempted: 0, refreshed: 0, unavailable: 0, failed: 0 };
  const attempt = memory.db.prepare(`INSERT INTO moments_memory_checks VALUES(?,?,?,'checking',NULL)
    ON CONFLICT(account_id,moment_id) DO UPDATE SET attempted_at=excluded.attempted_at,status='checking',error_type=NULL
    WHERE moments_memory_checks.attempted_at<=?`);
  const finish = (momentId, status, errorType = null) => memory.db.prepare(`UPDATE moments_memory_checks
    SET status=?,error_type=? WHERE account_id=? AND moment_id=? AND attempted_at=?`)
    .run(status, errorType, accountId, momentId, now);
  for (const row of rows) {
    // Durable attempt time prevents failed items monopolizing each browse cycle and competing refreshers.
    if (attempt.run(accountId, row.moment_id, now, now - DAY).changes !== 1) continue;
    result.attempted++;
    try {
      const id = commentId(row.moment_id, 'memory moment ID');
      const requestBody = encodeFields([{ number: 2, varint: BigInt(id) }]).toString('hex');
      const reply = await client.probe(210, requestBody, { withBaseRequest: true, write: false });
      if (reply?.cgi !== 210 || typeof reply.replyHex !== 'string') throw new Error('Moments detail envelope mismatch');
      const code = commentBaseCode(reply.replyHex);
      if (reply.baseCode !== code) throw new Error('Moments detail status mismatch');
      if (code === 205) {
        // 205 is the existing SNS detail's unavailable-object response, not a network failure.
        const changed = memory.db.prepare(`UPDATE moments_sources SET state='unavailable',checked_at=?
          WHERE account_id=? AND moment_id=? AND author_id=? AND digest=? AND checked_at=? AND state='visible'`)
          .run(now, accountId, id, row.author_id, row.digest, row.checked_at).changes;
        if (changed) result.unavailable++;
        finish(id, changed ? 'unavailable' : 'source_changed');
        continue;
      }
      if (reply.ok === false || code !== 0) throw new Error('Moments detail request rejected');
      const moment = parseCommentMomentDetail(reply.replyHex, id);
      if (moment.author?.id !== row.author_id) throw new Error('Moments detail author mismatch');
      if (!Number.isSafeInteger(moment.createTime) || moment.createTime <= 0 || moment.createTime * 1000 > now + 60000) throw new Error('Invalid Moments detail timestamp');
      validateXmlBinding(reply.replyHex, id, row.author_id, moment.createTime);
      const current = memory.db.prepare('SELECT digest,checked_at,state FROM moments_sources WHERE account_id=? AND moment_id=?').get(accountId, id);
      if (!current || current.digest !== row.digest || current.checked_at !== row.checked_at || current.state !== 'visible') {
        finish(id, 'source_changed'); continue;
      }
      // Existing classifications survive only when the verified original text is identical.
      memory.record({ accountId, moment, proposals: [], now });
      const saved = memory.db.prepare('SELECT checked_at FROM moments_sources WHERE account_id=? AND moment_id=?').get(accountId, id);
      if (saved?.checked_at !== now) throw new Error('Moments original could not be revalidated');
      result.refreshed++;
      finish(id, 'verified');
    } catch (error) {
      // Network/protocol failure neither renews verified time nor declares deletion.
      result.failed++;
      finish(row.moment_id, 'failed', error.name);
    }
  }
  return result;
}
