import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSlangAnnotator } from '../packages/participation/slang.mjs';

test('pinyin-initial invitations are interpreted from a synthetic custom lexicon', t => {
  const dir = mkdtempSync(join(tmpdir(), 'yuxu-slang-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const url = join(dir, 'slang.json');
  writeFileSync(url, JSON.stringify({ version: 1, entries: [
    { surface: 'yyrjy', intended: '有没有人约局', variants: ['yyrj'], kind: 'pinyin-initials', status: 'confirmed' },
    { surface: 'lol', intended: '英雄联盟', kind: 'abbreviation', status: 'confirmed' },
  ] }));
  const annotate = createSlangAnnotator({ url });
  const full = annotate('yyrjy 有人吗');
  assert.equal(full[0].surface, 'yyrjy');
  assert.equal(full[0].intended, '有没有人约局');
  assert.equal(full[0].kind, 'pinyin-initials');
  assert.equal(annotate('yyrj')[0].intended, '有没有人约局');
  assert.equal(annotate('来个lol')[0].intended, '英雄联盟');
});
