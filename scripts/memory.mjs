import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { MemoryLedger, approveProposal, openMem0, searchMemories } from '../packages/memory/index.mjs';
import { projectRoot } from './runtime.mjs';

const [command, ...args] = process.argv.slice(2);
const root = process.env.SOCIOMEM_MEMORY_ROOT ?? join(projectRoot, '.runtime', 'memory');
const ledger = new MemoryLedger(join(root, 'proposals.db'));

function sourceMessage(sourceMessageId) {
  const dbPath = process.env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value;
    const row = db.prepare('SELECT message FROM inbox WHERE id=?').get(sourceMessageId);
    if (!row) throw new Error('Source message is not in the authorized Inbox');
    const source = JSON.parse(row.message);
    if (source.sourceMessageId !== sourceMessageId || source.accountId !== accountId) throw new Error('Inbox source identity mismatch');
    return source;
  } finally { db.close(); }
}

try {
  if (command === 'propose') {
    const [sourceMessageId, ...factWords] = args;
    const source = sourceMessage(sourceMessageId);
    const row = ledger.propose({ accountId: source.accountId, groupId: source.groupId,
      subjectId: source.userId, sourceMessageId, fact: factWords.join(' ') });
    console.log(JSON.stringify(row));
  } else if (command === 'list') {
    console.log(JSON.stringify(ledger.list(), null, 2));
  } else if (command === 'reject') {
    console.log(JSON.stringify(ledger.reject(args[0])));
  } else if (command === 'approve') {
    const memory = await openMem0({ ...process.env, SOCIOMEM_MEMORY_ROOT: root });
    console.log(JSON.stringify(await approveProposal(ledger, memory, args[0])));
  } else if (command === 'search') {
    const [groupId, ...queryWords] = args;
    const dbPath = process.env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    let accountId;
    try { accountId = db.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value; }
    finally { db.close(); }
    const memory = await openMem0({ ...process.env, SOCIOMEM_MEMORY_ROOT: root });
    console.log(JSON.stringify(await searchMemories(memory, { accountId, groupId, query: queryWords.join(' ') }), null, 2));
  } else {
    throw new Error('Usage: memory.mjs propose <sourceMessageId> <fact> | list | approve <key> | reject <key> | search <groupId> <query>');
  }
} catch (error) {
  console.error(`memory: ${error.message}`);
  process.exitCode = 1;
} finally { ledger.close(); }
