import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const required = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
};

export function memoryScope(accountId, groupId) {
  required(accountId, 'accountId');
  if (!required(groupId, 'groupId').endsWith('@chatroom')) throw new Error('Memory group must be a chatroom');
  return `sociomem-${createHash('sha256').update(JSON.stringify([accountId, groupId])).digest('hex')}`;
}

export class MemoryLedger {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.lockPath = `${filename}.owner`;
    this.lock = openSync(this.lockPath, 'wx');
    writeFileSync(this.lock, `${process.pid}\n`);
    try {
      this.db = new DatabaseSync(filename);
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS proposals (
        key TEXT PRIMARY KEY, account_id TEXT NOT NULL, group_id TEXT NOT NULL,
        subject_id TEXT NOT NULL, source_message_id TEXT NOT NULL, fact TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','approved','rejected')),
        memory_id TEXT, created_at TEXT NOT NULL, decided_at TEXT
      );`);
    } catch (error) {
      this.db?.close();
      closeSync(this.lock);
      unlinkSync(this.lockPath);
      throw error;
    }
  }
  close() { this.db.close(); closeSync(this.lock); unlinkSync(this.lockPath); }
  get(key) { return this.db.prepare('SELECT * FROM proposals WHERE key=?').get(key) ?? null; }
  list() { return this.db.prepare('SELECT * FROM proposals ORDER BY created_at,key').all(); }
  propose({ accountId, groupId, subjectId, sourceMessageId, fact }) {
    memoryScope(accountId, groupId);
    for (const [value, label] of [[subjectId, 'subjectId'], [sourceMessageId, 'sourceMessageId'], [fact, 'fact']]) required(value, label);
    const text = fact.trim();
    if (text.length > 1000) throw new Error('Fact exceeds 1000 characters');
    const key = createHash('sha256').update(JSON.stringify([accountId, groupId, subjectId, sourceMessageId, text])).digest('hex');
    this.db.prepare(`INSERT OR IGNORE INTO proposals
      (key,account_id,group_id,subject_id,source_message_id,fact,state,created_at)
      VALUES (?,?,?,?,?,?,'pending',?)`).run(key, accountId, groupId, subjectId, sourceMessageId, text, new Date().toISOString());
    return this.get(key);
  }
  reject(key) {
    const result = this.db.prepare("UPDATE proposals SET state='rejected',decided_at=? WHERE key=? AND state='pending'").run(new Date().toISOString(), key);
    if (result.changes !== 1) throw new Error('Pending proposal not found');
    return this.get(key);
  }
  markApproved(key, memoryId) {
    const result = this.db.prepare("UPDATE proposals SET state='approved',memory_id=?,decided_at=? WHERE key=? AND state='pending'").run(memoryId, new Date().toISOString(), key);
    if (result.changes !== 1) throw new Error('Pending proposal not found');
    return this.get(key);
  }
}

export function memoryConfig(env = process.env) {
  const baseURL = required(env.SOCIOMEM_EMBEDDING_BASE_URL, 'SOCIOMEM_EMBEDDING_BASE_URL');
  const model = required(env.SOCIOMEM_EMBEDDING_MODEL, 'SOCIOMEM_EMBEDDING_MODEL');
  const dimension = Number(env.SOCIOMEM_EMBEDDING_DIMENSION);
  if (!Number.isSafeInteger(dimension) || dimension <= 0) throw new Error('SOCIOMEM_EMBEDDING_DIMENSION must be a positive integer');
  const root = env.SOCIOMEM_MEMORY_ROOT ?? join(process.cwd(), '.runtime', 'memory');
  return {
    root,
    config: {
      llm: { provider: 'deepseek', config: { apiKey: env.DEEPSEEK_API_KEY ?? 'unused-for-reviewed-facts', model: env.SOCIOMEM_DEEPSEEK_MODEL ?? 'deepseek-v4-flash' } },
      embedder: { provider: 'openai', config: { apiKey: env.SOCIOMEM_EMBEDDING_API_KEY ?? 'local-no-key', baseURL, model, embeddingDims: dimension } },
      vectorStore: { provider: 'memory', config: { collectionName: 'sociomem', dimension, dbPath: join(root, 'vectors.db') } },
      historyStore: { provider: 'sqlite', config: { historyDbPath: join(root, 'history.db') } },
    },
  };
}

export async function openMem0(env = process.env) {
  const { root, config } = memoryConfig(env);
  mkdirSync(root, { recursive: true });
  process.env.MEM0_DIR = root;
  process.env.MEM0_TELEMETRY = 'false';
  const { Memory } = await import('mem0ai/oss');
  return new Memory(config);
}

export async function searchMemories(memory, { accountId, groupId, query, limit = 5 }) {
  const scope = memoryScope(accountId, groupId);
  required(query, 'query');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('limit must be 1..20');
  const result = await memory.search(query, { filters: { agent_id: scope }, topK: Math.min(20, limit * 3), threshold: 0 });
  return result.results.filter(item => item.metadata?.accountId === accountId &&
    item.metadata?.groupId === groupId && item.metadata?.status !== 'retired').slice(0, limit)
    .map(item => ({ id: item.id, fact: item.memory, subjectId: item.metadata.subjectId,
      sourceMessageId: item.metadata.sourceMessageId, score: item.score ?? null }));
}

export async function approveProposal(ledger, memory, key) {
  const proposal = ledger.get(required(key, 'key'));
  if (!proposal || proposal.state !== 'pending') throw new Error('Pending proposal not found');
  const scope = memoryScope(proposal.account_id, proposal.group_id);
  // Reconcile a crash after Mem0 wrote the fact but before the ledger was updated.
  const prior = await memory.getAll({ filters: { agent_id: scope, proposalKey: key }, topK: 1 });
  let item = prior.results.find(value => value.metadata?.proposalKey === key);
  if (!item) {
    const added = await memory.add(proposal.fact, { agentId: scope, infer: false,
      metadata: { accountId: proposal.account_id, groupId: proposal.group_id,
        subjectId: proposal.subject_id, sourceMessageId: proposal.source_message_id, proposalKey: key } });
    item = added.results.find(value => value.metadata?.proposalKey === key) ?? added.results[0];
  }
  if (!item?.id) throw new Error('Mem0 did not return a memory ID');
  return ledger.markApproved(key, item.id);
}
