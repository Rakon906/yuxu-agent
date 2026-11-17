import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MomentsLedger } from '../packages/moments/ledger.mjs';
import { describeMomentMedia, downloadMomentImage, MomentImageCdnError,
  momentImageDescriptionKey } from '../packages/moments/media.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/uYQAAAAASUVORK5CYII=', 'base64');
const md5 = createHash('md5').update(png).digest('hex');
const sha256 = createHash('sha256').update(png).digest('hex');
const publicLookup = async () => [{ address: '1.1.1.1', family: 4 }];

test('moment image download validates host, checksum and signed URL fallback', async () => {
  const urls = [];
  const headers = [];
  const fetchImpl = async (url, options) => {
    urls.push(String(url));
    headers.push(options?.headers ?? {});
    if (!String(url).includes('key=')) return new Response('no', { status: 403 });
    return new Response(png, { status: 200 });
  };
  const image = await downloadMomentImage({ url: 'http://shmmsns.qpic.cn/a', key: 'k', token: 't',
    length: png.length, md5 }, { fetchImpl, lookupImpl: publicLookup });
  assert.equal(image.extension, 'png');
  assert.equal(image.sha256, sha256);
  assert.match(image.sourceUrl, /key=k/u);
  assert.equal(urls.length, 2);
  assert.equal(headers[0].referer, 'https://servicewechat.com/');
  assert.ok(headers[0]['user-agent']);
  await assert.rejects(downloadMomentImage({ url: 'http://example.com/a', length: png.length, md5 },
    { fetchImpl, lookupImpl: publicLookup }), /rejected/u);
  await assert.rejects(downloadMomentImage({ url: 'http://shmmsns.qpic.cn/a', length: png.length + 1, md5 },
    { fetchImpl: async () => new Response(png, { status: 200 }), lookupImpl: publicLookup }), /size mismatch/u);
  await assert.rejects(downloadMomentImage({ url: 'http://shmmsns.qpic.cn/a', length: png.length,
    md5: '0'.repeat(32) },
  { fetchImpl: async () => new Response(png, { status: 200 }), lookupImpl: publicLookup }), /checksum mismatch/u);
});

test('moment media description is cached by image md5', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moment-media-'));
  const ledger = new MomentsLedger(join(root, 'ledger.sqlite'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const vision = async () => { calls++; return { scene: '两只兔子', visibleText: '你好',
    tone: '轻松', safety: 'safe', model: 'fixture' }; };
  const download = async () => ({ bytes: png, extension: 'png', mediaType: 'image/png', sha256 });
  const moment = { id: 'm1', media: [{ id: 'img1', type: 2, url: 'http://shmmsns.qpic.cn/a', md5 }] };
  const first = await describeMomentMedia({ moment, ledger, vision, download,
    budget: { remaining: 2 } });
  assert.equal(first[0].vision.scene, '两只兔子');
  assert.equal(first[0].vision.safety, 'safe');
  const second = await describeMomentMedia({ moment, ledger, vision, download,
    budget: { remaining: 2 } });
  assert.equal(second[0].vision.scene, '两只兔子');
  assert.equal(calls, 1);
  assert.equal(ledger.mediaDescription(momentImageDescriptionKey(md5)).model, 'fixture');
  assert.equal(second[0].vision.visibleText, '你好');
});

test('moment image CDN rejection reports qpic illref instead of a checksum mismatch', async () => {
  const fetchImpl = async () => new Response(Buffer.alloc(0), { status: 200,
    headers: { 'x-errno': '-108', 'x-info': 'illref' } });
  await assert.rejects(downloadMomentImage({ url: 'http://shmmsns.qpic.cn/a', key: 'k', token: 't' },
    { fetchImpl, lookupImpl: publicLookup }), error => error instanceof MomentImageCdnError &&
      error.info === 'illref' && error.errNo === '-108' && /illref/u.test(error.message));
});

test('media description failure leaves the image without vision instead of failing the post', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moment-media-fail-'));
  const ledger = new MomentsLedger(join(root, 'ledger.sqlite'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const moment = { id: 'm2', media: [{ id: 'img2', type: 2, url: 'http://shmmsns.qpic.cn/a', md5 }] };
  const media = await describeMomentMedia({ moment, ledger,
    vision: async () => { throw new Error('vision unavailable'); },
    download: async () => ({ bytes: png, extension: 'png', mediaType: 'image/png', sha256 }),
    budget: { remaining: 2 } });
  assert.equal(media[0].vision, null);
});

test('media description marks a CDN-rejected image without calling the vision model', async t => {
  const root = mkdtempSync(join(tmpdir(), 'sociomem-moment-media-cdn-'));
  const ledger = new MomentsLedger(join(root, 'ledger.sqlite'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  let calls = 0;
  const moment = { id: 'm3', media: [{ id: 'img3', type: 2, url: 'http://shmmsns.qpic.cn/a', md5 }] };
  const media = await describeMomentMedia({ moment, ledger,
    vision: async () => { calls++; return {}; },
    download: async () => { throw new MomentImageCdnError('rejected', { status: 200, errNo: '-108', info: 'illref' }); },
    budget: { remaining: 1 } });
  assert.equal(media[0].vision, null);
  assert.equal(media[0].mediaError, 'illref');
  assert.equal(calls, 0);
});
