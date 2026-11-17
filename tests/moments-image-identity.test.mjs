import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { matchCacheToMedia } from '../packages/moments/official-cache.mjs';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { describeMomentMedia, downloadMomentImage, momentImageDescriptionKey } from '../packages/moments/media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const other = Buffer.concat([png, Buffer.from('different-content')]);
const hash = (kind, value) => createHash(kind).update(value).digest('hex');
const md5 = hash('md5', png);
const descriptor = (delta = {}) => ({ id: 'image', url: 'https://shmmsns.qpic.cn/example', type: 2, md5, ...delta });
const moment = (delta = {}) => ({ id: 'moment', media: [descriptor(delta)] });

function fixture(t, { legacySchema = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moment-identity-'));
  const path = join(root, 'ledger.sqlite');
  if (legacySchema) {
    const db = new DatabaseSync(path);
    db.exec(`CREATE TABLE moment_media (media_key TEXT PRIMARY KEY,sha256 TEXT NOT NULL,scene TEXT NOT NULL,
      visible_text TEXT NOT NULL,tone TEXT NOT NULL,safety TEXT NOT NULL,model TEXT NOT NULL,described_at INTEGER NOT NULL)`);
    db.prepare('INSERT INTO moment_media VALUES (?,?,?,?,?,?,?,?)')
      .run(md5, hash('sha256', other), '旧的未经核实描述', '旧文字', '', 'safe', 'old', 1);
    db.close();
  }
  const ledger = new MomentsLedger(path);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return ledger;
}

test('equal dimensions cannot bind the wrong or unknown image, even with a single cache file', () => {
  const cache = [{ name: 'one', bytes: png, width: 800, height: 600 }];
  const media = [descriptor({ md5: hash('md5', other), width: 800, height: 600 }),
    descriptor({ md5: 'a'.repeat(32), width: 800, height: 600 })];
  assert.equal(matchCacheToMedia(cache, media).size, 0);
  assert.equal(matchCacheToMedia(cache, [descriptor({ md5: null, width: 800, height: 600 })]).size, 0);
  const verified = matchCacheToMedia(cache, [media[0], descriptor({ width: 800, height: 600 })]);
  assert.equal(verified.size, 1);
  assert.deepEqual(verified.get(md5).bytes, png);
});

test('the same verified bytes can serve repeated media and must satisfy descriptor lengths', () => {
  const cache = [{ name: 'one', bytes: png, width: 1, height: 1 }];
  assert.equal(matchCacheToMedia(cache, [descriptor(), descriptor({ id: 'another', md5: md5.toUpperCase() })]).size, 1);
  assert.equal(matchCacheToMedia(cache, [descriptor({ bytes: png.length + 1 })]).size, 0);
  assert.equal(matchCacheToMedia(cache, [descriptor({ length: png.length + 1 })]).size, 0);
  assert.equal(matchCacheToMedia(cache, [descriptor({ length: png.length, bytes: png.length + 1 })]).size, 0);
});

test('every injected image source is verified before vision, irrespective of claimed hashes', async t => {
  const ledger = fixture(t);
  let visionCalls = 0;
  const vision = async () => { visionCalls++; return { scene: '不应该使用' }; };
  for (const [source, input, bytes] of [
    ['official-cache', moment(), other],
    ['native', moment({ bytes: png.length + 1 }), png],
    ['https', moment({ length: png.length + 1 }), png],
  ]) {
    const budget = { remaining: 2 };
    const result = await describeMomentMedia({ moment: input, ledger, vision, budget,
      download: async () => ({ bytes, sha256: hash('sha256', png), sourceUrl: source }) });
    assert.equal(result[0].vision, null);
    assert.equal(budget.remaining, 2);
  }
  assert.equal(visionCalls, 0);
  assert.equal(ledger.mediaDescription(momentImageDescriptionKey(md5)), null);
});

test('missing checksums and conflicting descriptor length aliases fail before downloading', async t => {
  const ledger = fixture(t);
  let downloads = 0;
  let calls = 0;
  for (const delta of [{ md5: null }, { md5: 'invalid' }, { bytes: -1 },
    { bytes: png.length, length: png.length + 1 }]) {
    const result = await describeMomentMedia({ moment: moment(delta), ledger,
      download: async () => { downloads++; return { bytes: png }; },
      vision: async () => { calls++; return { scene: '不应该使用' }; } });
    assert.equal(result[0].vision, null);
  }
  assert.equal(downloads, 0);
  assert.equal(calls, 0);
});

test('legacy descriptions are isolated; verified same-image reuse preserves visible text across restart', async t => {
  const ledger = fixture(t, { legacySchema: true });
  let downloads = 0;
  let calls = 0;
  const input = { moment: moment({ bytes: png.length }), ledger,
    download: async () => { downloads++; return { bytes: png, sha256: 'forged' }; },
    vision: async () => { calls++; return { scene: '正确图片', visibleText: '明确文字', safety: 'safe' }; } };
  const first = await describeMomentMedia(input);
  assert.equal(first[0].vision.scene, '正确图片');
  assert.equal(first[0].vision.visibleText, '明确文字');
  assert.equal(ledger.mediaDescription(md5).scene, '旧的未经核实描述');
  const saved = ledger.mediaDescription(momentImageDescriptionKey(md5));
  assert.equal(saved.sha256, hash('sha256', png));
  assert.equal(saved.byteLength, png.length);
  // Reopen the same isolated file to exercise actual persisted field names.
  const secondLedger = new MomentsLedger(ledger.db.location());
  try {
    const second = await describeMomentMedia({ ...input, ledger: secondLedger,
      moment: moment({ md5: md5.toUpperCase(), length: png.length, url: 'https://shmmsns.qpic.cn/different' }),
      budget: { remaining: 0 } });
    assert.equal(second[0].vision.scene, '正确图片');
    assert.equal(second[0].vision.visibleText, '明确文字');
    assert.equal(downloads, 1);
    assert.equal(calls, 1);
  } finally { secondLedger.close(); }
  const rejected = await describeMomentMedia({ ...input, moment: moment({ bytes: png.length + 1 }) });
  assert.equal(rejected[0].vision, null);
  assert.equal(downloads, 1);
});

test('a cache record lacking validated byte length is not trusted', async t => {
  const ledger = fixture(t);
  ledger.saveMediaDescription({ mediaKey: momentImageDescriptionKey(md5), sha256: hash('sha256', png), scene: '未验证' });
  let calls = 0;
  const result = await describeMomentMedia({ moment: moment(), ledger,
    download: async () => ({ bytes: png }),
    vision: async () => { calls++; return { scene: '新验证', visibleText: '新文字' }; } });
  assert.equal(result[0].vision.scene, '新验证');
  assert.equal(calls, 1);
});

test('direct HTTP download checks the timeline bytes length field', async () => {
  const dependencies = { lookupImpl: async () => [{ address: '1.1.1.1', family: 4 }],
    fetchImpl: async () => new Response(png, { status: 200 }) };
  await assert.rejects(downloadMomentImage(descriptor({ bytes: png.length + 1 }), dependencies), /size mismatch/u);
  const verified = await downloadMomentImage(descriptor({ bytes: png.length }), dependencies);
  assert.deepEqual(verified.bytes, png);
});
