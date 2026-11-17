import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MomentPersonMemory, readMomentObservations } from '../packages/moments/person-memory.mjs';
const now = Date.parse('2026-11-13T06:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'moment-memory-')), path = join(dir, 'memory.sqlite');
  const store = new MomentPersonMemory(path);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  const moment = { id: '123', author: { id: 'friend' }, text: '这两天在青岛旅游', createTime: now / 1000 - 3600 };
  return { store, path, moment, read: () => readMomentObservations(path, { accountId: 'a', subjectId: 'friend', now }) };
}
test('Moments observations keep exact author/source/time without inventing stable interests', t => {
  const f = fixture(t);
  f.store.record({ accountId: 'a', moment: f.moment, now, proposals: [
    { kind: 'preference', evidenceQuote: '我长期喜欢青岛' },
    { kind: 'recent_update', evidenceQuote: '在青岛旅游', subjectId: 'different-person' }] });
  assert.equal(f.read()[0].kind, 'observed_post');
  assert.equal(f.read()[0].state, 'self_report');
  assert.equal(f.read()[0].evidence[0].quote, f.moment.text);
  assert.equal(readMomentObservations(f.path, { accountId: 'other', subjectId: 'friend' }).length, 0);
  assert.equal(readMomentObservations(f.path, { accountId: 'a', subjectId: 'same-name-different-id' }).length, 0);
});
test('same source deduplicates, edits replace evidence, withdrawal suppresses future retrieval', t => {
  const f = fixture(t);
  const save = moment => f.store.record({ accountId: 'a', moment, now });
  save(f.moment); save(f.moment); assert.equal(f.read().length, 1);
  save({ ...f.moment, text: '已经回天津了' }); assert.equal(f.read()[0].evidence[0].quote, '已经回天津了');
  save({ ...f.moment, private: true }); assert.equal(f.read().length, 0);
  save(f.moment); save({ ...f.moment, deleted: true }); assert.equal(f.read().length, 0);
  assert.throws(() => save({ ...f.moment, author: { id: 'different' } }), /author changed/);
});
test('image-only post does not establish a preference, exact text proposal needs no second model', t => {
  const f = fixture(t);
  f.store.record({ accountId: 'a', moment: { ...f.moment, text: '', media: [{ vision: { scene: '爱吃火锅' } }] }, now });
  assert.equal(f.read().length, 0);
  f.store.record({ accountId: 'a', moment: f.moment, proposals: [{ kind: 'recent_update', evidenceQuote: '在青岛旅游' }], now });
  assert.equal(f.read()[0].kind, 'recent_update');
  f.store.record({ accountId: 'a', moment: f.moment, now });
  assert.equal(f.read()[0].evidence[0].quote, '在青岛旅游');
});
test('cropped third-party quote cannot become the author preference and stale visibility is not current evidence', t => {
  const f = fixture(t);
  f.store.record({ accountId: 'a', moment: { ...f.moment, text: '我朋友说：我喜欢原神' },
    proposals: [{ kind: 'preference', evidenceQuote: '我喜欢原神' }], now });
  assert.equal(f.read()[0].kind, 'observed_post');
  assert.equal(f.read()[0].evidence[0].quote, '我朋友说：我喜欢原神');
  assert.equal(readMomentObservations(f.path, { accountId: 'a', subjectId: 'friend', now: now + 3 * 86400000 }).length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM moments_sources').get().n, 1);
});
