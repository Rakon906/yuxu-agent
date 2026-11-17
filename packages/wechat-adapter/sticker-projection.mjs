import { createDecipheriv, createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const MAX_BATCH = 2 * 1024 * 1024;
const MAX_IMAGE = 16 * 1024 * 1024;
const HOSTS = new Set(['vweixinf.tc.qq.com', 'wxapp.tc.qq.com']);
export const STICKER_CONTEXTS = ['开心/笑', '无语/尴尬', '生气/炸毛', '委屈/难过', '惊讶/震惊',
  '得意/炫耀', '困/累/懒', '赞同/认可', '拒绝/嫌弃', '疑惑/问号', '安慰/抱抱',
  '挑衅/嘲讽', '庆祝/加油', '打招呼/告别', '其他'];
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_@.-]{1,128}$/u.test(value);
const digest = (algorithm, bytes) => createHash(algorithm).update(bytes).digest('hex');

function varint(bytes, start) {
  let value = 0n;
  for (let index = start; index < Math.min(bytes.length, start + 10); index++) {
    value |= BigInt(bytes[index] & 127) << BigInt(7 * (index - start));
    if (!(bytes[index] & 128)) return [value, index + 1];
  }
  throw new Error('Invalid sticker protobuf varint');
}

function fields(bytes) {
  const found = [];
  for (let offset = 0; offset < bytes.length;) {
    const [tag, afterTag] = varint(bytes, offset);
    offset = afterTag;
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error('Invalid sticker protobuf field');
    if (wire === 0) {
      const [value, end] = varint(bytes, offset);
      found.push([number, value]); offset = end;
    } else if (wire === 2) {
      const [length, end] = varint(bytes, offset);
      if (length > BigInt(bytes.length - end)) throw new Error('Invalid sticker protobuf length');
      found.push([number, bytes.subarray(end, end + Number(length))]); offset = end + Number(length);
    } else if (wire === 1 || wire === 5) {
      offset += wire === 1 ? 8 : 4;
      if (offset > bytes.length) throw new Error('Invalid sticker protobuf fixed field');
    } else throw new Error('Unsupported sticker protobuf wire type');
  }
  return found;
}

function one(items, number, type) {
  const matching = items.filter(item => item[0] === number);
  if (matching.length !== 1 || typeof matching[0][1] !== type) throw new Error('Missing sticker protobuf field');
  return matching[0][1];
}

function nestedText(items, number) {
  return new TextDecoder('utf-8', { fatal: true }).decode(one(fields(one(items, number, 'object')), 1, 'object'));
}

function attributes(xml) {
  if (xml.length > 16384 || /<!DOCTYPE|<!ENTITY/iu.test(xml)) throw new Error('Invalid sticker XML');
  const tag = xml.match(/<emoji\b([^>]*)>/u)?.[1];
  if (!tag) throw new Error('Sticker XML has no emoji');
  return Object.fromEntries([...tag.matchAll(/([a-zA-Z][a-zA-Z0-9]*)\s*=\s*(['"])(.*?)\2/gu)]
    .map(match => [match[1], match[3].replaceAll('&amp;', '&')]));
}

export function decodeStickerBatch({ record, key, accountId, batchId, allowedGroups, selfUserId }) {
  if (!(record instanceof Uint8Array) || record.length < 29 || record.length > MAX_BATCH || record[0] !== 1 ||
      !Buffer.isBuffer(key) || key.length !== 32 || !identity(accountId) ||
      !/^[a-f0-9]{64}$/u.test(batchId) || !identity(selfUserId)) throw new Error('Invalid sticker batch identity');
  const bytes = Buffer.from(record);
  const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
  cipher.setAAD(Buffer.from(`agent-wechat:1:${accountId}:apply:${batchId}`));
  cipher.setAuthTag(bytes.subarray(13, 29));
  const plain = Buffer.concat([cipher.update(bytes.subarray(29)), cipher.final()]);
  if (plain.length > MAX_BATCH) throw new Error('Sticker batch too large');
  const batch = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  if (!Array.isArray(batch.commands) || batch.commands.length > 200) throw new Error('Invalid sticker commands');
  const result = [];
  for (const [index, command] of batch.commands.entries()) {
    if (command?.id !== 5 || !Array.isArray(command.payload) || command.payload.length > 256 * 1024) continue;
    try {
      const message = fields(Buffer.from(command.payload));
      if (one(message, 4, 'bigint') !== 47n) continue;
      const groupId = nestedText(message, 2);
      if (!allowedGroups.has(groupId) || nestedText(message, 3) !== selfUserId) continue;
      const content = nestedText(message, 5);
      const split = content.indexOf(':\n');
      if (split < 1 || split > 128) continue;
      const senderId = content.slice(0, split);
      if (!identity(senderId) || senderId === selfUserId ||
          !content.slice(split + 2).startsWith('<msg>')) continue;
      const attrs = attributes(content.slice(split + 2));
      const xml = content.slice(split + 2);
      const serverId = one(message, 12, 'bigint').toString();
      const at = Number(one(message, 9, 'bigint')) * 1000;
      if (serverId === '0' || !Number.isSafeInteger(at) || at <= 0) continue;
      const sourceMessageId = `sticker:${digest('sha256', `${accountId}\0${groupId}\0${serverId}`)}`;
      result.push({ sourceMessageId, groupId, senderId, serverId,
        eventTime: new Date(at).toISOString(), batchId, commandIndex: index,
        md5: /^[a-f0-9]{32}$/iu.test(attrs.md5 ?? '') ? attrs.md5.toLowerCase() : null,
        length: Number(attrs.len) || null, url: attrs.cdnurl ?? null, xml });
    } catch { /* Ignore unrelated or malformed commands. */ }
  }
  return result;
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'png';
  if (bytes.subarray(0, 6).toString('ascii').match(/^GIF8[79]a$/u)) return 'gif';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
      bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return null;
}

function publicV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a >= 1 && a <= 223 && a !== 10 && a !== 127 && a !== 169 &&
    !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && b === 168) &&
    !(a === 100 && b >= 64 && b <= 127);
}

export async function downloadSticker({ url: rawUrl, length, md5 },
  { fetchImpl = fetch, lookupImpl = lookup } = {}) {
  const url = new URL(rawUrl);
  if (!['http:', 'https:'].includes(url.protocol) || !HOSTS.has(url.hostname) ||
      url.username || url.password || url.port || url.hash ||
      !Number.isSafeInteger(length) || length < 1 || length > MAX_IMAGE ||
      !/^[a-f0-9]{32}$/iu.test(md5 ?? '')) throw new Error('Sticker descriptor rejected');
  const addresses = await lookupImpl(url.hostname, { all: true, family: 4 });
  if (!addresses.some(item => item.family === 4 && publicV4(item.address))) {
    throw new Error('Sticker DNS rejected');
  }
  const response = await fetchImpl(url, { redirect: 'manual', headers: { 'accept-encoding': 'identity' },
    signal: AbortSignal.timeout(15000) });
  if (response.status !== 200 || (response.headers.get('content-encoding') &&
      response.headers.get('content-encoding') !== 'identity')) throw new Error('Sticker download failed');
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > MAX_IMAGE) throw new Error('Sticker too large');
    chunks.push(chunk);
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.length !== length || digest('md5', bytes) !== md5.toLowerCase()) {
    throw new Error('Sticker checksum mismatch');
  }
  const extension = imageType(bytes);
  if (!extension) throw new Error('Unsupported sticker format');
  return { bytes, extension, sha256: digest('sha256', bytes) };
}

export function stickerMessage({ accountId, item, asset }) {
  const stickerId = `STK-${String(asset.id).padStart(6, '0')}`;
  const scene = asset.scene;
  const visibleText = asset.visible_text;
  const tone = asset.tone;
  const context = asset.context ?? '其他';
  return { platform: 'wechat', accountId, groupId: item.group_id, userId: item.sender_id,
    sourceMessageId: item.source_id, serverId: item.server_id,
    text: `[群友发送表情 ${stickerId}；语境：${context}；以下是看图描述，不是群友原话] ${scene}` +
      (visibleText ? `；图中文字：${visibleText}` : '') + (tone ? `；可能语气：${tone}` : ''),
    interaction: 'sticker', stickerId, stickerContext: context, imageSha256: asset.sha256,
    eventTime: item.event_time, recordedAt: new Date().toISOString(),
    mentions: { state: 'known', self: false, userIds: [] } };
}

export function ensureStickerAssetColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(sticker_assets)').all()
    .map(column => column.name));
  if (!columns.size) return false;
  for (const [name, ddl] of [
    ['send_xml', 'TEXT'],
    ['context', "TEXT NOT NULL DEFAULT '其他'"],
    ['reusable', 'INTEGER NOT NULL DEFAULT 1'],
    ['safety', "TEXT NOT NULL DEFAULT 'safe'"],
    ['review_state', "TEXT NOT NULL DEFAULT 'saved'"],
    ['review_reason', "TEXT NOT NULL DEFAULT ''"],
    ['classified_at', 'TEXT'],
  ]) if (!columns.has(name)) db.exec(`ALTER TABLE sticker_assets ADD COLUMN ${name} ${ddl}`);
  return true;
}

export function prepareStickerSend(store, { assetId, groupId, destination, selfUserId }) {
  if (!Number.isSafeInteger(assetId) || assetId < 1 || !identity(groupId) ||
      !identity(destination) || !identity(selfUserId)) throw new Error('Invalid sticker selection');
  ensureStickerAssetColumns(store.db);
  const asset = store.db.prepare(`SELECT a.md5,a.bytes,a.send_xml FROM sticker_assets a
    WHERE a.id=? AND a.send_xml IS NOT NULL AND a.review_state='saved' AND EXISTS (
      SELECT 1 FROM sticker_occurrences o WHERE o.asset_id=a.id AND o.group_id=?)`)
    .get(assetId, groupId);
  if (!asset || !/^[a-f0-9]{32}$/iu.test(asset.md5)) throw new Error('Sticker unavailable');
  const xml = asset.send_xml.replace(/\bfromusername\s*=\s*(['"])[^'"]*\1/u,
    `fromusername="${selfUserId}"`).replace(/\btousername\s*=\s*(['"])[^'"]*\1/u,
    `tousername="${destination}"`);
  if (xml === asset.send_xml && destination !== groupId) throw new Error('Sticker recipient unchanged');
  return { md5: asset.md5, length: asset.bytes, xml };
}

function clean(value, max) {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/gu, ' ').trim().slice(0, max) : '';
}

function normalizeVision(described) {
  const scene = clean(described.summary ?? described.scene, 180);
  const visibleText = clean(described.visibleText, 120);
  const tone = clean(described.tone, 100);
  const rawContext = typeof described.context === 'string' ? described.context.trim() : '';
  const context = STICKER_CONTEXTS.includes(rawContext) ? rawContext : '其他';
  const reusable = !(described.reusable === false || described.reusable === 'false' ||
    described.reusable === 0);
  const rawSafety = typeof described.safety === 'string' ? described.safety.trim().toLowerCase() : '';
  const safety = ['safe', 'uncertain', 'unsafe'].includes(rawSafety) ? rawSafety : 'safe';
  const reviewState = safety === 'unsafe' || !reusable ? 'rejected' :
    safety === 'uncertain' ? 'needs_review' : 'saved';
  const reviewReason = clean(described.reason, 160);
  if (!scene) throw new Error('Empty sticker visual description');
  return { scene, visibleText, tone, context, reusable, safety, reviewState, reviewReason };
}

export class StickerProjector {
  constructor({ dataDir, accountId, groupIds, selfUserId, store, describe,
    fetchImpl = fetch, lookupImpl = lookup }) {
    this.control = new DatabaseSync(join(dataDir, 'accounts', accountId, 'agent', 'control.sqlite'),
      { readOnly: true });
    this.key = readFileSync(join(dataDir, 'storage-key'));
    this.accountId = accountId;
    this.groupIds = new Set(groupIds);
    this.selfUserId = selfUserId;
    this.store = store;
    this.describe = describe;
    this.fetchImpl = fetchImpl;
    this.lookupImpl = lookupImpl;
    this.imageDir = join(dataDir, '..', 'stickers');
    store.db.exec(`CREATE TABLE IF NOT EXISTS sticker_pending (
      source_id TEXT PRIMARY KEY, group_id TEXT NOT NULL, sender_id TEXT NOT NULL,
      server_id TEXT NOT NULL, event_time TEXT NOT NULL, batch_rowid INTEGER NOT NULL,
      command_index INTEGER NOT NULL, md5 TEXT, state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sticker_assets (
      id INTEGER PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, md5 TEXT NOT NULL,
      bytes INTEGER NOT NULL, filename TEXT NOT NULL, scene TEXT NOT NULL,
      visible_text TEXT NOT NULL, tone TEXT NOT NULL, model TEXT NOT NULL,
      described_at TEXT NOT NULL, send_xml TEXT,
      context TEXT NOT NULL DEFAULT '其他', reusable INTEGER NOT NULL DEFAULT 1,
      safety TEXT NOT NULL DEFAULT 'safe', review_state TEXT NOT NULL DEFAULT 'saved',
      review_reason TEXT NOT NULL DEFAULT '', classified_at TEXT);
    CREATE INDEX IF NOT EXISTS sticker_assets_md5 ON sticker_assets(md5,bytes);
    CREATE TABLE IF NOT EXISTS sticker_occurrences (
      source_id TEXT PRIMARY KEY, asset_id INTEGER NOT NULL REFERENCES sticker_assets(id),
      group_id TEXT NOT NULL, sender_id TEXT NOT NULL, event_time TEXT NOT NULL);`);
    ensureStickerAssetColumns(store.db);
    store.db.prepare(`UPDATE sticker_pending SET state='pending',retry_at=0
      WHERE state='waiting_asset' AND attempts<3`).run();
    store.db.prepare(`UPDATE sticker_pending SET state='pending',retry_at=0,attempts=0
      WHERE state='pending' AND attempts>0`).run();
    const tail = this.control.prepare('SELECT rowid,state FROM apply_intents ORDER BY rowid DESC LIMIT 1').get();
    const latest = tail?.state === 'pending' ? tail.rowid - 1 : tail?.rowid ?? 0;
    store.db.prepare('INSERT OR IGNORE INTO meta(key,value) VALUES (?,?)')
      .run('sticker_projection_rowid', String(latest));
  }

  decode(row) {
    return decodeStickerBatch({ record: row.payload, key: this.key, accountId: this.accountId,
      batchId: row.id, allowedGroups: this.groupIds, selfUserId: this.selfUserId });
  }

  scan() {
    let cursor = Number(this.store.db.prepare('SELECT value FROM meta WHERE key=?')
      .get('sticker_projection_rowid').value);
    let found = 0;
    const rows = this.control.prepare(`SELECT rowid,id,payload,state FROM apply_intents
      WHERE rowid>? ORDER BY rowid LIMIT 100`).all(cursor);
    for (const row of rows) {
      if (row.state === 'pending') break;
      let items = [];
      if (row.state === 'projected') {
        try { items = this.decode(row); } catch { /* Other batches are unrelated. */ }
      }
      this.store.transaction(() => {
        for (const item of items) {
          found += this.store.db.prepare(`INSERT OR IGNORE INTO sticker_pending
            (source_id,group_id,sender_id,server_id,event_time,batch_rowid,command_index,md5)
            VALUES (?,?,?,?,?,?,?,?)`).run(item.sourceMessageId, item.groupId, item.senderId,
            item.serverId, item.eventTime, row.rowid, item.commandIndex, item.md5).changes;
        }
        this.store.db.prepare('UPDATE meta SET value=? WHERE key=?')
          .run(String(row.rowid), 'sticker_projection_rowid');
      });
      cursor = row.rowid;
    }
    return found;
  }

  async processNext(now = Date.now()) {
    const item = this.store.db.prepare(`SELECT * FROM sticker_pending
      WHERE state='pending' AND retry_at<=? ORDER BY batch_rowid,command_index LIMIT 1`).get(now);
    if (!item) return null;
    try {
      const row = this.control.prepare('SELECT rowid,id,payload,state FROM apply_intents WHERE rowid=?')
        .get(item.batch_rowid);
      const descriptor = row && this.decode(row).find(found => found.sourceMessageId === item.source_id);
      if (!descriptor) throw new Error('Sticker source missing');
      let asset = descriptor.md5 && descriptor.length
        ? this.store.db.prepare('SELECT * FROM sticker_assets WHERE md5=? AND bytes=? LIMIT 1')
          .get(descriptor.md5, descriptor.length) : null;
      if (!asset) {
        if (!descriptor.url) {
          this.store.db.prepare("UPDATE sticker_pending SET state='waiting_asset' WHERE source_id=?")
            .run(item.source_id);
          return { status: 'waiting_asset', sourceId: item.source_id };
        }
        const image = await downloadSticker(descriptor,
          { fetchImpl: this.fetchImpl, lookupImpl: this.lookupImpl });
        asset = this.store.db.prepare('SELECT * FROM sticker_assets WHERE sha256=?').get(image.sha256);
        if (!asset) {
          const filename = join(this.imageDir, `${image.sha256}.${image.extension}`);
          mkdirSync(this.imageDir, { recursive: true });
          if (!existsSync(filename)) writeFileSync(filename, image.bytes, { flag: 'wx', mode: 0o600 });
          const described = await this.describe({ bytes: image.bytes, sha256: image.sha256 });
          const { scene, visibleText, tone, context, reusable, safety, reviewState,
            reviewReason } = normalizeVision(described);
          const describedAt = new Date().toISOString();
          this.store.db.prepare(`INSERT OR IGNORE INTO sticker_assets
            (sha256,md5,bytes,filename,scene,visible_text,tone,model,described_at,
              context,reusable,safety,review_state,review_reason,classified_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(image.sha256, descriptor.md5,
            image.bytes.length, filename, scene, visibleText, tone, described.model ?? 'local-ollama',
            describedAt, context, reusable ? 1 : 0, safety, reviewState, reviewReason, describedAt);
          asset = this.store.db.prepare('SELECT * FROM sticker_assets WHERE sha256=?').get(image.sha256);
        }
      }
      if (asset && descriptor.xml && !asset.send_xml) {
        this.store.db.prepare('UPDATE sticker_assets SET send_xml=? WHERE id=? AND send_xml IS NULL')
          .run(descriptor.xml, asset.id);
      }
      this.store.db.prepare("UPDATE sticker_pending SET state='pending' WHERE state='waiting_asset' AND md5=?")
        .run(asset.md5);
      this.store.transaction(() => {
        this.store.db.prepare(`INSERT OR IGNORE INTO sticker_occurrences
          (source_id,asset_id,group_id,sender_id,event_time) VALUES (?,?,?,?,?)`)
          .run(item.source_id, asset.id, item.group_id, item.sender_id, item.event_time);
        const message = stickerMessage({ accountId: this.accountId, item, asset });
        this.store.db.prepare('INSERT OR IGNORE INTO inbox(id,message) VALUES (?,?)')
          .run(item.source_id, JSON.stringify(message));
        this.store.db.prepare("UPDATE sticker_pending SET state='done' WHERE source_id=?")
          .run(item.source_id);
      });
      return { status: 'captured', sourceId: item.source_id,
        stickerId: `STK-${String(asset.id).padStart(6, '0')}` };
    } catch (error) {
      const attempts = item.attempts + 1;
      this.store.db.prepare(`UPDATE sticker_pending SET attempts=?,retry_at=?,state=? WHERE source_id=?`)
        .run(attempts, now + Math.min(attempts * 10 * 60000, 3600000),
          attempts >= 3 ? 'needs_review' : 'pending', item.source_id);
      return { status: 'error', sourceId: item.source_id, errorType: error.name,
        errorMessage: String(error.message ?? '').slice(0, 120) };
    }
  }

  async reclassifyNext() {
    const asset = this.store.db.prepare(`SELECT * FROM sticker_assets
      WHERE classified_at IS NULL AND review_state IN ('saved','needs_review')
      ORDER BY id LIMIT 1`).get();
    if (!asset) return null;
    const stickerId = `STK-${String(asset.id).padStart(6, '0')}`;
    try {
      if (!existsSync(asset.filename)) throw new Error('Sticker image missing');
      const described = await this.describe({ bytes: readFileSync(asset.filename), sha256: asset.sha256 });
      const { scene, visibleText, tone, context, reusable, safety, reviewState,
        reviewReason } = normalizeVision(described);
      this.store.db.prepare(`UPDATE sticker_assets SET scene=?,visible_text=?,tone=?,model=?,
        context=?,reusable=?,safety=?,review_state=?,review_reason=?,classified_at=?
        WHERE id=?`).run(scene, visibleText, tone, described.model ?? asset.model, context,
        reusable ? 1 : 0, safety, reviewState, reviewReason, new Date().toISOString(), asset.id);
      return { status: 'reclassified', stickerId, context, reviewState };
    } catch (error) {
      this.store.db.prepare(`UPDATE sticker_assets SET review_state='needs_review',
        review_reason=?,classified_at=? WHERE id=?`)
        .run(`reclassify_failed:${error.name}`, new Date().toISOString(), asset.id);
      return { status: 'error', stickerId, errorType: error.name };
    }
  }

  close() { this.control.close(); this.key.fill(0); }
}
