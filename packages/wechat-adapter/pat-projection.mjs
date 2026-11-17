import { createDecipheriv, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

const MAX_BATCH = 2 * 1024 * 1024;

function varint(buffer, start) {
  let value = 0n;
  for (let index = start; index < Math.min(buffer.length, start + 10); index++) {
    const byte = buffer[index];
    value |= BigInt(byte & 127) << BigInt((index - start) * 7);
    if (!(byte & 128)) return [value, index + 1];
  }
  throw new Error('Invalid protobuf varint');
}

function fields(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length;) {
    const [tag, next] = varint(buffer, offset);
    offset = next;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid protobuf field');
    if (wire === 0) {
      const [value, end] = varint(buffer, offset);
      result.push([number, value]); offset = end;
    } else if (wire === 2) {
      const [length, end] = varint(buffer, offset);
      if (length > BigInt(buffer.length - end)) throw new Error('Invalid protobuf length');
      const finish = end + Number(length);
      result.push([number, buffer.subarray(end, finish)]); offset = finish;
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > buffer.length) throw new Error('Invalid protobuf fixed field');
    } else throw new Error('Unsupported protobuf wire type');
  }
  return result;
}

function one(items, number, type) {
  const matching = items.filter(item => item[0] === number);
  if (matching.length !== 1 || typeof matching[0][1] !== type) throw new Error('Missing or duplicate protobuf field');
  return matching[0][1];
}

function nestedText(items, number) {
  const outer = one(items, number, 'object');
  return new TextDecoder('utf-8', { fatal: true }).decode(one(fields(outer), 1, 'object'));
}

function tag(xml, name) {
  const matches = [...xml.matchAll(new RegExp(`<${name}>([^<>]*)</${name}>`, 'gu'))];
  return matches.length === 1 ? matches[0][1] : null;
}

const identity = text => typeof text === 'string' && /^[a-zA-Z0-9_@.-]{1,128}$/u.test(text);

export function decodePatBatch({ record, key, accountId, batchId, allowedGroups, selfUserId }) {
  if (!(record instanceof Uint8Array) || record.length < 29 || record.length > MAX_BATCH || record[0] !== 1 ||
      !Buffer.isBuffer(key) || key.length !== 32 || !identity(accountId) ||
      !/^[a-f0-9]{64}$/u.test(batchId) || !identity(selfUserId)) throw new Error('Invalid sealed batch identity');
  record = Buffer.from(record);
  const decipher = createDecipheriv('aes-256-gcm', key, record.subarray(1, 13));
  decipher.setAAD(Buffer.from(`agent-wechat:1:${accountId}:apply:${batchId}`));
  decipher.setAuthTag(record.subarray(13, 29));
  const plain = Buffer.concat([decipher.update(record.subarray(29)), decipher.final()]);
  if (plain.length > MAX_BATCH) throw new Error('Sync batch too large');
  const batch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  if (!Array.isArray(batch.commands) || batch.commands.length > 200) throw new Error('Invalid sync commands');
  const result = [];
  for (const [index, command] of batch.commands.entries()) {
    if (!command || command.id !== 5) continue;
    if (!Array.isArray(command.payload) || command.payload.length > 256 * 1024) continue;
    try {
      const message = fields(Buffer.from(command.payload));
      if (one(message, 4, 'bigint') !== 10002n) continue;
      const from = nestedText(message, 2);
      const to = nestedText(message, 3);
      if (!allowedGroups.has(from) || to !== selfUserId) continue;
      const content = nestedText(message, 5);
      if (content.length > 8192 || /<!DOCTYPE|<!ENTITY/iu.test(content) ||
          !content.startsWith(`${from}:\n`)) continue;
      const xml = content.slice(from.length + 2);
      if (!/^<sysmsg type="pat">\s*<pat>\s*/u.test(xml) || !/<\/pat>\s*<\/sysmsg>\s*$/u.test(xml)) continue;
      const actor = tag(xml, 'fromusername');
      const group = tag(xml, 'chatusername');
      const target = tag(xml, 'pattedusername');
      const createdAt = Number(one(message, 9, 'bigint')) * 1000;
      if (!identity(actor) || actor === selfUserId || group !== from || target !== selfUserId ||
          !Number.isSafeInteger(createdAt) || createdAt <= 0) continue;
      const sourceMessageId = `pat:${createHash('sha256').update(`${accountId}\0${batchId}\0${index}`).digest('hex')}`;
      result.push({ platform: 'wechat', accountId, groupId: group, userId: actor,
        sourceMessageId, serverId: null, text: '拍了拍肥鱼', interaction: 'pat',
        eventTime: new Date(createdAt).toISOString(), recordedAt: new Date().toISOString(),
        mentions: { state: 'known', self: true, userIds: [] } });
    } catch { /* A malformed command does not discard other commands in the batch. */ }
  }
  return result;
}

export class PatProjector {
  constructor({ dataDir, accountId, groupIds, selfUserId, store }) {
    const path = join(dataDir, 'accounts', accountId, 'agent', 'control.sqlite');
    this.control = new DatabaseSync(path, { readOnly: true });
    this.key = readFileSync(join(dataDir, 'storage-key'));
    this.accountId = accountId;
    this.groupIds = new Set(groupIds);
    this.selfUserId = selfUserId;
    this.store = store;
    // Start at the latest batch on first installation; old pats are not late-replied.
    const latest = this.control.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM apply_intents').get().n;
    store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
      .run('pat_projection_rowid', String(latest));
  }
  scan(now = Date.now()) {
    let cursor = Number(this.store.db.prepare('SELECT value FROM meta WHERE key=?')
      .get('pat_projection_rowid').value);
    let captured = 0;
    const rows = this.control.prepare(`SELECT rowid,id,payload,state FROM apply_intents
      WHERE rowid>? ORDER BY rowid LIMIT 100`).all(cursor);
    for (const row of rows) {
      if (row.state === 'pending') break;
      let pats = [];
      if (row.state === 'blocked') {
        try { pats = decodePatBatch({ record: row.payload, key: this.key,
          accountId: this.accountId, batchId: row.id,
          allowedGroups: this.groupIds, selfUserId: this.selfUserId }); }
        catch { /* Other blocked controls stay sealed and are never projected. */ }
      }
      this.store.transaction(() => {
        for (const pat of pats) {
          if (Math.abs(now - Date.parse(pat.eventTime)) > 5 * 60000) continue;
          const inserted = this.store.db.prepare('INSERT OR IGNORE INTO inbox(id,message) VALUES (?,?)')
            .run(pat.sourceMessageId, JSON.stringify(pat)).changes;
          if (inserted) captured++;
        }
        this.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
          .run(String(row.rowid), 'pat_projection_rowid');
      });
      cursor = row.rowid;
    }
    return captured;
  }
  close() { this.control.close(); this.key.fill(0); }
}
