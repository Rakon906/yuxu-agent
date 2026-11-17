import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DiaryStore, planDiary, previewDiary, readCoreFacts, readInbox, runDiary, searchDiary } from '../packages/diary/index.mjs';
import { createAgentDiaryModel } from '../packages/diary/model.mjs';
import { openMem0 } from '../packages/memory/index.mjs';
import { parseGroupAllowlist } from '../packages/wechat-adapter/real-config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [command, groupId, ...args] = process.argv.slice(2);
const inboxPath = process.env.SOCIOMEM_WECHAT_DB ?? join(root, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const diaryPath = join(process.env.SOCIOMEM_DIARY_ROOT ?? join(root, '.runtime', 'diary'), 'diary.sqlite');
let store;
try {
  const groups = parseGroupAllowlist(process.env.SOCIOMEM_WECHAT_GROUPS);
  if (!groups.includes(groupId)) throw new Error('Diary group is outside the explicit allowlist');
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  let accountId;
  try { accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value; }
  finally { db.close(); }
  if (!accountId) throw new Error('Authorized Inbox has no account ID');
  const thresholds = { triggerTokens: Number(process.env.SOCIOMEM_DIARY_TRIGGER_TOKENS ?? 120000),
    maxBatchTokens: Number(process.env.SOCIOMEM_DIARY_BATCH_TOKENS ?? 30000),
    maxAgeMs: Number(process.env.SOCIOMEM_DIARY_MAX_AGE_MS ?? 0) };
  if (command === 'plan' || command === 'preview') {
    if (args.some(arg => !['--force', '--save-cache'].includes(arg)) ||
        (command === 'plan' && args.length)) {
      throw new Error('Only preview accepts --force and --save-cache');
    }
    const options = { diaryPath, inboxPath, accountId, groupId, ...thresholds,
      force: args.includes('--force'), saveCache: args.includes('--save-cache') };
    if (command === 'plan') console.log(JSON.stringify(planDiary(options), null, 2));
    else {
      const memoryRoot = process.env.SOCIOMEM_MEMORY_ROOT ?? join(root, '.runtime', 'memory');
      const coreFacts = readCoreFacts(memoryRoot, accountId, groupId);
      const model = createAgentDiaryModel();
      console.log(JSON.stringify(await previewDiary({ ...options, coreFacts, model }), null, 2));
    }
  } else {
    store = new DiaryStore(diaryPath);
    if (command === 'status') {
      const recent = readInbox(inboxPath, { accountId, groupId, afterRowid: store.progress(accountId, groupId), limit: 257 });
      console.log(JSON.stringify({ lastRowid: store.progress(accountId, groupId), pendingAtLeast: recent.length,
        morePendingPossible: recent.length === 257,
        latest: store.latest(accountId, groupId)?.id ?? null }));
    } else if (command === 'recent') {
      console.log(JSON.stringify(readInbox(inboxPath, { accountId, groupId, recent: true, limit: 12 }), null, 2));
    } else if (command === 'segments') {
      console.log(JSON.stringify(store.segments(accountId, groupId).map(item => ({
        id: item.id, title: item.title, summary: item.summary, startAt: item.start_at,
        endAt: item.end_at, sourceMessageIds: JSON.parse(item.source_ids_json), indexed: Boolean(item.indexed),
      })), null, 2));
    } else if (command === 'run') {
      if (args.some(arg => arg !== '--force')) throw new Error('Only --force is accepted for diary run');
      const memory = await openMem0();
      const model = createAgentDiaryModel();
      console.log(JSON.stringify(await runDiary({ store, memory, model, inboxPath, accountId, groupId,
        force: args.includes('--force'), ...thresholds }), null, 2));
    } else if (command === 'search') {
      const memory = await openMem0();
      console.log(JSON.stringify(await searchDiary(memory, { accountId, groupId, query: args.join(' '),
        diaryPath, inboxPath }), null, 2));
    } else {
      throw new Error('Usage: diary plan|preview [--force]|status|recent|segments|run [--force]|search <groupId> [query]');
    }
  }
} catch (error) {
  console.error(`diary: ${error.message}`);
  process.exitCode = 1;
} finally { store?.close(); }
