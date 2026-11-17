import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareImageDescriptionCorrection, applyImageDescriptionCorrection,
  revertImageDescriptionCorrection } from '../packages/shared-media/image-correction.mjs';
import { initializeImageDescriptionCache, readImageDescription, readVerifiedImageDescription,
  saveImageDescription } from '../packages/shared-media/image-description-cache.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6SAAAAABJRU5ErkJggg==', 'base64');
const oldText = '群昵称甲 今天一起看花', newText = '群昵称乙 今天一起看花';
const accountId = 'test-account', groupId = 'group-one@chatroom';
const at = '2026-11-15T10:00:00.000Z';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'image-correction-')), imageDir = join(root, 'images');
  mkdirSync(imageDir);
  const sha256 = digest(png), imagePath = join(imageDir, `${sha256}.png`), inboxPath = join(root, 'inbox.sqlite');
  writeFileSync(imagePath, png);
  const db = new DatabaseSync(inboxPath);
  db.exec(`CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE inbox(id TEXT PRIMARY KEY,message TEXT NOT NULL,delivered INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE outbox(id TEXT PRIMARY KEY,text TEXT NOT NULL);
    CREATE TABLE test_contacts(id TEXT PRIMARY KEY,nickname TEXT NOT NULL)`);
  db.prepare('INSERT INTO meta VALUES (?,?)').run('accountId', accountId);
  db.prepare('INSERT INTO outbox VALUES (?,?)').run('sent', '已经发送的话不能改写');
  db.prepare('INSERT INTO test_contacts VALUES (?,?)').run('self', '真实昵称');
  const message = { platform: 'wechat', accountId, groupId, userId: 'forwarder', sourceMessageId: 'image-one',
    interaction: 'image', eventTime: at, recordedAt: at, imagePath, imageSha256: sha256,
    imageSummary: '一张动态截图', imageVisibleText: oldText, imageTone: '可能在分享近况', imageSafety: 'safe', imageModel: 'offline-fixture',
    text: `[群友发送图片；以下是看图描述，不是群友原话] 一张动态截图；图中文字：${oldText}；可能语气/用途：可能在分享近况` };
  const put = value => db.prepare('INSERT OR REPLACE INTO inbox(id,message) VALUES (?,?)').run(value.sourceMessageId, JSON.stringify(value));
  const raw = id => db.prepare('SELECT message FROM inbox WHERE id=?').get(id)?.message;
  const get = (id = 'image-one') => JSON.parse(raw(id));
  put(message);
  const options = { inboxPath, imageDir, correctionId: 'fixture-correction-one', accountId,
    imageSha256: sha256, sources: [{ sourceMessageId: 'image-one', groupId }],
    expectedVisibleText: oldText, correctedVisibleText: newText,
    verification: { method: 'local_image_inspection', verifiedAt: at, note: 'Offline fixture transcription verified against the fixture image.' } };
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, db, imageDir, imagePath, inboxPath, sha256, message, put, raw, get, options,
    prepare: delta => prepareImageDescriptionCorrection({ ...options, ...delta }),
    apply: plan => applyImageDescriptionCorrection({ inboxPath, imageDir, plan, now: at }),
    revert: (correctionId = options.correctionId) => revertImageDescriptionCorrection({ inboxPath, accountId, correctionId, now: at }) };
}

test('preparation is read-only and binds image bytes, exact source digest and explicit scopes', t => {
  const f = fixture(t), before = f.raw('image-one');
  const tables = f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all();
  const plan = f.prepare();
  assert.equal(plan.sources[0].priorMessageSha256, digest(before));
  assert.equal(plan.imageSha256, digest(readFileSync(f.imagePath)));
  assert.equal(plan.priorVerifiedCache, null);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/u);
  assert.equal(f.raw('image-one'), before);
  assert.deepEqual(f.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all(), tables);
});

test('apply changes nominated image OCR and verified cache only, preserving sender, original bytes and sent history', t => {
  const f = fixture(t);
  f.put({ ...f.message, sourceMessageId: 'same-bytes-unselected', groupId: 'group-two@chatroom' });
  f.put({ ...f.message, sourceMessageId: 'foreign-account', accountId: 'other-account' });
  f.put({ ...f.message, sourceMessageId: 'plain-message', interaction: 'text' });
  const untouched = ['same-bytes-unselected', 'foreign-account', 'plain-message'].map(f.raw);
  const plan = f.prepare(), result = f.apply(plan), corrected = f.get();
  assert.equal(result.status, 'applied'); assert.equal(result.changed, 1);
  assert.equal(corrected.imageVisibleText, newText);
  assert.equal(corrected.text, f.message.text.replace(oldText, newText));
  assert.equal(corrected.userId, f.message.userId);
  assert.equal(corrected.imageModel, f.message.imageModel);
  assert.equal(corrected.imageDescriptionCorrection.previousMessageSha256, plan.sources[0].priorMessageSha256);
  assert.equal(corrected.imageDescriptionCorrection.correctedVisibleTextSha256, digest(newText));
  assert.deepEqual(['same-bytes-unselected', 'foreign-account', 'plain-message'].map(f.raw), untouched);
  assert.equal(digest(readFileSync(f.imagePath)), f.sha256);
  assert.equal(f.db.prepare('SELECT delivered FROM inbox WHERE id=?').get('image-one').delivered, 1);
  assert.equal(f.db.prepare('SELECT text FROM outbox').get().text, '已经发送的话不能改写');
  assert.equal(f.db.prepare('SELECT nickname FROM test_contacts').get().nickname, '真实昵称');
  const cached = readImageDescription(f.db, { accountId, sha256: f.sha256, promptVersion: digest('new prompt') });
  assert.equal(cached.description.visibleText, newText);
  assert.equal(cached.verification, 'local_image_inspection');
  assert.equal(cached.correctionId, plan.correctionId);
  assert.equal(readImageDescription(f.db, { accountId: 'other-account', sha256: f.sha256, promptVersion: digest('new prompt') }), null);
});

test('application is idempotent and rollback restores full prior rows while retaining immutable audit evidence', t => {
  const f = fixture(t), before = f.raw('image-one'), plan = f.prepare();
  f.apply(plan);
  assert.equal(f.apply(JSON.parse(JSON.stringify(plan))).status, 'already_applied');
  const audit = f.db.prepare('SELECT * FROM image_description_corrections').get();
  const changes = JSON.parse(audit.changes_json);
  assert.equal(changes[0].before, before);
  assert.equal(changes[0].afterSha256, digest(f.raw('image-one')));
  assert.equal(f.revert().status, 'reverted');
  assert.equal(f.raw('image-one'), before);
  assert.equal(readVerifiedImageDescription(f.db, { accountId, sha256: f.sha256 }), null);
  assert.equal(f.db.prepare('SELECT state FROM image_description_corrections').get().state, 'reverted');
  assert.equal(f.revert().status, 'already_reverted');
  assert.throws(() => f.apply(plan), /reverted/u);
});

test('wrong account, group, old OCR, revoked source and modified plan are rejected', t => {
  const f = fixture(t);
  assert.throws(() => f.prepare({ accountId: 'wrong-account' }), /account mismatch/u);
  assert.throws(() => f.prepare({ sources: [{ sourceMessageId: 'image-one', groupId: 'wrong@chatroom' }] }), /identity mismatch/u);
  assert.throws(() => f.prepare({ expectedVisibleText: '另外一张图' }), /does not match/u);
  const plan = f.prepare();
  assert.throws(() => f.apply({ ...plan, correctedVisibleText: '未经检查的替换值' }), /digest mismatch/u);
  f.put({ ...f.message, recalled: true });
  assert.throws(() => f.prepare(), /revoked/u);
  assert.throws(() => f.apply(plan), /revoked/u);
  assert.equal(f.get().imageVisibleText, oldText);
});

test('missing, changed and outside-root image bytes fail before mutation, including changes after prepare', t => {
  const f = fixture(t), plan = f.prepare();
  writeFileSync(f.imagePath, Buffer.concat([png, Buffer.from('changed')]));
  assert.throws(() => f.prepare(), /hash mismatch/u);
  assert.throws(() => f.apply(plan), /hash mismatch/u);
  assert.equal(f.get().imageVisibleText, oldText);
  assert.equal(f.db.prepare("SELECT 1 FROM sqlite_master WHERE name='image_description_corrections'").get(), undefined);
  writeFileSync(f.imagePath, png);
  const outside = join(f.root, 'outside.png'); writeFileSync(outside, png);
  f.put({ ...f.message, imagePath: outside });
  assert.throws(() => f.prepare(), /outside/u);
  f.put({ ...f.message, imagePath: join(f.imageDir, 'missing.png') });
  assert.throws(() => f.prepare(), /ENOENT/u);
});

test('multi-source application is atomic when any prepared message changes', t => {
  const f = fixture(t), second = { ...f.message, sourceMessageId: 'image-two', groupId: 'group-two@chatroom' };
  f.put(second);
  const plan = f.prepare({ sources: [...f.options.sources, { sourceMessageId: second.sourceMessageId, groupId: second.groupId }] });
  f.put({ ...second, imageTone: 'new observation' });
  assert.throws(() => f.apply(plan), /changed since preparation/u);
  assert.equal(f.get().imageVisibleText, oldText);
  assert.equal(f.get('image-two').imageVisibleText, oldText);
  assert.equal(readVerifiedImageDescription(f.db, { accountId, sha256: f.sha256 }), null);
  f.put(second);
  assert.equal(f.apply(plan).changed, 2);
  assert.equal(f.get('image-two').imageVisibleText, newText);
  assert.equal(f.revert().changed, 2);
  assert.equal(f.get('image-two').imageVisibleText, oldText);
});

test('verified cache races fail atomically and ordinary model cache never replaces a verified correction', t => {
  const f = fixture(t), plan = f.prepare();
  initializeImageDescriptionCache(f.db);
  saveImageDescription(f.db, { accountId, sha256: f.sha256, promptVersion: 'verified',
    description: { summary: 'verified', visibleText: 'a different verified result', tone: '', safety: 'safe', model: null },
    verification: 'local_image_inspection', correctionId: 'other-correction', describedAt: at });
  assert.throws(() => f.apply(plan), /cache changed/u);
  assert.equal(f.get().imageVisibleText, oldText);
  const nextPlan = f.prepare(); f.apply(nextPlan);
  saveImageDescription(f.db, { accountId, sha256: f.sha256, promptVersion: digest('prompt'),
    description: { summary: 'model', visibleText: oldText, tone: '', safety: 'safe', model: 'fixture-model' }, describedAt: at });
  assert.equal(readImageDescription(f.db, { accountId, sha256: f.sha256, promptVersion: digest('prompt') }).description.visibleText, newText);
  f.revert();
  assert.equal(readVerifiedImageDescription(f.db, { accountId, sha256: f.sha256 }).correctionId, 'other-correction');
});

test('rollback refuses subsequent source changes and preserves audit and cache', t => {
  const f = fixture(t), plan = f.prepare(); f.apply(plan);
  const after = f.get(); f.put({ ...after, text: `${after.text} 后来补充` });
  assert.throws(() => f.revert(), /subsequent changes/u);
  assert.equal(f.get().text.endsWith('后来补充'), true);
  assert.equal(f.db.prepare('SELECT state FROM image_description_corrections').get().state, 'applied');
  assert.equal(readVerifiedImageDescription(f.db, { accountId, sha256: f.sha256 }).correctionId, plan.correctionId);
});

test('dependent corrections must roll back in reverse order and restore prior verified cache', t => {
  const f = fixture(t), first = f.prepare(); f.apply(first);
  const afterFirst = f.raw('image-one');
  const second = f.prepare({ correctionId: 'fixture-correction-two', expectedVisibleText: newText, correctedVisibleText: '群昵称丙 今天一起看花' });
  f.apply(second);
  assert.throws(() => f.revert(first.correctionId), /subsequent changes/u);
  f.revert(second.correctionId);
  assert.equal(f.raw('image-one'), afterFirst);
  assert.equal(readVerifiedImageDescription(f.db, { accountId, sha256: f.sha256 }).correctionId, first.correctionId);
  assert.equal(f.revert(first.correctionId).status, 'reverted');
});
