import { createAgentParticipationModel } from '../packages/participation/model.mjs';

const args = process.argv.slice(2);
let provider = 'all';
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--provider' && args[index + 1]) provider = args[++index];
  else throw new Error('Usage: node scripts/model-probe.mjs [--provider ollama|deepseek|anthropic|all]');
}
if (!['ollama', 'deepseek', 'anthropic', 'all'].includes(provider)) {
  throw new Error('Provider must be ollama, deepseek, anthropic or all');
}

const target = { id: 'probe', senderId: 'probe', text: '这是一次模型连通性测试，请只输出 JSON。',
  at: new Date().toISOString() };
const input = { target, context: [], kind: 'ordinary', mustReply: false,
  coreFacts: [], latestDiary: null, stickers: [] };

async function probe(name) {
  const started = Date.now();
  try {
    const model = createAgentParticipationModel({ provider: name, fallback: 'none' });
    const result = await model({ ...input, target: { ...target, at: new Date().toISOString() } });
    return { provider: name, ok: true, elapsedMs: Date.now() - started,
      keys: result && typeof result === 'object' ? Object.keys(result) : [] };
  } catch (error) {
    return { provider: name, ok: false, elapsedMs: Date.now() - started,
      error: error.message.slice(0, 300), code: error.code ?? null };
  }
}

const names = provider === 'all' ? ['ollama', 'deepseek', 'anthropic'] : [provider];
const results = [];
for (const name of names) results.push(await probe(name));
console.log(JSON.stringify(results, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
