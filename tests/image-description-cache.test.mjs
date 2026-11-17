import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { initializeImageDescriptionCache, imageDescriptionPromptVersion, readImageDescription,
  readVerifiedImageDescription, saveImageDescription, deleteVerifiedImageDescription,
  describeImageWithCache } from '../packages/shared-media/image-description-cache.mjs';

const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const prompt = '只描述可见内容', promptVersion = imageDescriptionPromptVersion(prompt);
const accountId = 'test-account', scope = { accountId, sha256, promptVersion };
const description = { summary: '一张名字卡片', visibleText: '原识别', tone: '', safety: 'safe', model: 'test-vision' };
const corrected = { ...description, visibleText: '已核实文字' };
const verified = { ...scope, promptVersion: 'verified', description: corrected,
  verification: 'local_image_inspection', correctionId: 'ocr-test-1', describedAt: '2026-11-15T10:00:00.000Z' };

function fixture(t, initialize = true) {
  const dir = mkdtempSync(join(tmpdir(), 'sociomem-image-description-'));
  const filename = join(dir, 'inbox.sqlite'), db = new DatabaseSync(filename);
  if (initialize) initializeImageDescriptionCache(db);
  t.after(() => {
    db.close();
    if (dirname(resolve(dir)) !== resolve(tmpdir())) throw new Error('Test cleanup path escaped temporary root');
    rmSync(dir, { recursive: true, force: true });
  });
  return { db, filename };
}

test('read-only old Inbox lookup returns no cache and never creates the table', t => {
  const { db, filename } = fixture(t, false), readonly = new DatabaseSync(filename, { readOnly: true });
  try {
    assert.equal(readImageDescription(readonly, scope), null);
    assert.equal(readVerifiedImageDescription(readonly, scope), null);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n, 0);
  } finally { readonly.close(); }
});

test('actual bytes reuse one scoped content description across requests and restart', async t => {
  const { db, filename } = fixture(t); let calls = 0;
  const vision = async () => { calls++; return { ...description, sourceId: 'untrusted', groupId: 'not-content' }; };
  const first = await describeImageWithCache({ db, accountId, bytes, prompt, vision });
  const second = await describeImageWithCache({ db, accountId, bytes: Buffer.from(bytes), prompt, vision });
  assert.equal(first.cacheHit, false); assert.equal(second.cacheHit, true); assert.equal(calls, 1);
  assert.equal(first.sha256, sha256); assert.deepEqual(first.description, description);
  const readonly = new DatabaseSync(filename, { readOnly: true });
  try { assert.deepEqual(readImageDescription(readonly, scope).description, description); }
  finally { readonly.close(); }
  assert.equal(readImageDescription(db, { ...scope, accountId: 'another-account' }), null);
  assert.equal(readImageDescription(db, { ...scope, sha256: 'a'.repeat(64) }), null);
  assert.equal(readImageDescription(db, { ...scope, promptVersion: imageDescriptionPromptVersion('new prompt') }), null);
  assert.equal(JSON.stringify(first).includes('untrusted'), false);
});

test('account, changed bytes and changed prompt each require separate vision evidence', async t => {
  const { db } = fixture(t); let calls = 0;
  const vision = async () => { calls++; return description; };
  const input = { db, accountId, bytes, prompt, vision };
  for (const change of [{}, { accountId: 'second-account' }, { bytes: Buffer.concat([bytes, Buffer.from('other')]) }, { prompt: 'different prompt' }]) {
    await describeImageWithCache({ ...input, ...change });
  }
  assert.equal(calls, 4);
});

test('description provenance binds actual image bytes and the final sanitized or corrected OCR text', async t => {
  const { db } = fixture(t);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const input = { db, accountId, bytes, prompt,
    vision: async () => ({ ...description, visibleText: '  原识别\n文字  ',
      imageSha256: 'f'.repeat(64), visibleTextSha256: 'a'.repeat(64) }) };
  const initial = await describeImageWithCache(input);
  assert.equal(initial.description.visibleText, '原识别 文字');
  assert.equal(initial.imageDescriptionProvenance.imageSha256, hash(bytes));
  assert.equal(initial.imageDescriptionProvenance.visibleTextSha256, hash(initial.description.visibleText));
  assert.equal(initial.imageDescriptionProvenance.verification, 'model');
  assert.equal(initial.imageDescriptionProvenance.correctionId, null);
  const cached = await describeImageWithCache({ ...input, vision: null });
  assert.equal(cached.imageDescriptionProvenance.cacheHit, true);
  assert.equal(cached.imageDescriptionProvenance.visibleTextSha256, initial.imageDescriptionProvenance.visibleTextSha256);
  saveImageDescription(db, verified);
  const local = await describeImageWithCache({ ...input, prompt: 'another prompt version', vision: null });
  assert.equal(local.imageDescriptionProvenance.imageSha256, hash(bytes));
  assert.equal(local.imageDescriptionProvenance.visibleTextSha256, hash(corrected.visibleText));
  assert.notEqual(local.imageDescriptionProvenance.visibleTextSha256, initial.imageDescriptionProvenance.visibleTextSha256);
  assert.equal(local.imageDescriptionProvenance.verification, 'local_image_inspection');
  assert.equal(local.imageDescriptionProvenance.correctionId, verified.correctionId);
});

test('verified OCR overrides every prompt version without being overwritten by model cache', t => {
  const { db } = fixture(t);
  saveImageDescription(db, { ...scope, description });
  saveImageDescription(db, verified);
  saveImageDescription(db, { ...scope, description: { ...description, visibleText: 'later model guess' } });
  for (const version of [promptVersion, imageDescriptionPromptVersion('next prompt')]) {
    const row = readImageDescription(db, { ...scope, promptVersion: version });
    assert.deepEqual(row.description, corrected); assert.equal(row.verification, 'local_image_inspection');
    assert.equal(row.correctionId, 'ocr-test-1');
  }
  assert.equal(deleteVerifiedImageDescription(db, { ...scope, correctionId: 'wrong-id' }), 0);
  assert.equal(deleteVerifiedImageDescription(db, { ...scope, accountId: 'another-account', correctionId: 'ocr-test-1' }), 0);
  assert.equal(deleteVerifiedImageDescription(db, { ...scope, correctionId: 'ocr-test-1' }), 1);
  assert.equal(readImageDescription(db, scope).description.visibleText, 'later model guess');
});

test('cache helpers participate in the caller transaction for atomic correction and rollback', t => {
  const { db } = fixture(t);
  db.exec('BEGIN IMMEDIATE'); saveImageDescription(db, verified); db.exec('ROLLBACK');
  assert.equal(readVerifiedImageDescription(db, scope), null);
  db.exec('BEGIN IMMEDIATE'); saveImageDescription(db, verified); db.exec('COMMIT');
  const previous = readVerifiedImageDescription(db, scope);
  db.exec('BEGIN IMMEDIATE');
  deleteVerifiedImageDescription(db, { ...scope, correctionId: 'ocr-test-1' });
  saveImageDescription(db, { ...scope, ...previous });
  db.exec('COMMIT');
  assert.deepEqual(readVerifiedImageDescription(db, scope), previous);
});

test('model cannot populate verified provenance or inject transport identity into cached content', t => {
  const { db } = fixture(t);
  assert.throws(() => saveImageDescription(db, { ...scope, promptVersion: 'verified', description }), /provenance/u);
  assert.throws(() => saveImageDescription(db, { ...scope, description, correctionId: 'pretend-verified' }), /provenance/u);
  assert.throws(() => saveImageDescription(db, { ...verified, correctionId: null }), /correction/u);
  assert.throws(() => saveImageDescription(db, { ...scope, description: { ...description, groupId: 'foreign' } }), /description/u);
  assert.throws(() => saveImageDescription(db, { ...scope, description, describedAt: 'yesterday' }), /description/u);
  assert.throws(() => readImageDescription(db, { ...scope, sha256: 'unverified' }), /scope/u);
});

test('malformed stored descriptions are ignored without forwarding arbitrary payloads', t => {
  const { db } = fixture(t);
  saveImageDescription(db, { ...scope, description });
  const update = db.prepare('UPDATE image_description_cache SET description_json=?');
  update.run(JSON.stringify({ ...description, userId: 'foreign-identity' }));
  assert.equal(readImageDescription(db, scope), null);
  update.run('{broken'); assert.equal(readImageDescription(db, scope), null);
});

test('concurrent same-image requests share vision and the committed corrected result wins an in-flight model', async t => {
  const { db } = fixture(t); let release, calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const vision = async () => { calls++; await waiting; return description; };
  const input = { db, accountId, bytes, prompt, vision };
  const first = describeImageWithCache(input), second = describeImageWithCache(input);
  assert.equal(calls, 1);
  saveImageDescription(db, verified); release();
  const results = await Promise.all([first, second]);
  for (const result of results) {
    assert.deepEqual(result.description, corrected); assert.equal(result.correctionId, 'ocr-test-1');
    assert.equal(result.imageDescriptionProvenance.visibleTextSha256,
      createHash('sha256').update(corrected.visibleText).digest('hex'));
  }
  assert.deepEqual((await describeImageWithCache({ ...input, vision: null })).description, corrected);
  assert.equal(calls, 1);
});

test('failed vision does not poison retries or create a cache entry', async t => {
  const { db } = fixture(t), input = { db, accountId, bytes, prompt };
  await assert.rejects(describeImageWithCache({ ...input, vision: async () => { throw new Error('offline failure'); } }), /offline/u);
  assert.equal(readImageDescription(db, scope), null);
  assert.deepEqual((await describeImageWithCache({ ...input, vision: async () => description })).description, description);
});

test('malformed and empty vision output is never cached and a later valid retry succeeds', async t => {
  const { db } = fixture(t);
  for (const [index, raw] of [null, undefined, [], 'not an object', 42, {},
    { summary: '\n\u0000 ', visibleText: '\t', safety: 'safe' },
    { summary: 42, visibleText: {}, tone: 'warm' }].entries()) {
    const input = { db, accountId: `retry-account-${index}`, bytes, prompt };
    await assert.rejects(describeImageWithCache({ ...input, vision: async () => raw }), /image vision/u);
    assert.equal(readImageDescription(db, { ...scope, accountId: input.accountId }), null);
    const retry = await describeImageWithCache({ ...input, vision: async () => description });
    assert.deepEqual(retry.description, description); assert.equal(retry.cacheHit, false);
  }
});
