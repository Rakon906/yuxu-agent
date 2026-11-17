import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';

test('draft listing and approval remain separate from sending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sociomem-drafts-'));
  const dbPath = join(root, 'adapter.sqlite');
  const store = new AdapterStore(dbPath, 'account-1');
  try {
    const draft = store.draft('draft-1', 'group@chatroom', 'reply');
    assert.equal(draft.state, 'draft');
    assert.equal(draft.approved, 0);
    assert.equal(store.drafts()[0].key, 'draft-1');
    const approved = store.approve('draft-1');
    assert.equal(approved.approved, 1);
    assert.equal(approved.state, 'draft');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
