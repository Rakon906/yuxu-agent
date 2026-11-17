import { modelUsageSources, readModelUsage, summarizeModelUsage } from '../packages/telemetry/model-usage.mjs';

const args = process.argv.slice(2);
let minutes = null;
let last = 20;
for (let index = 0; index < args.length; index++) {
  const flag = args[index];
  if (flag === '--minutes' && minutes === null) {
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('--minutes requires a positive integer');
    minutes = value;
  } else if (flag === '--last') {
    const value = Number(args[++index]);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('--last requires a positive integer');
    last = value;
  } else if (flag === '--all') last = 'all';
  else throw new Error('Usage: node scripts/api-usage.mjs [--minutes N] [--last N | --all]');
}
const since = minutes === null ? -Infinity : Date.now() - minutes * 60000;
const data = summarizeModelUsage(readModelUsage(), { since, last });
console.log(JSON.stringify({
  sources: modelUsageSources(),
  windowMinutes: minutes,
  ...data,
  note: 'Covers recorded DeepSeek, Ollama, Anthropic-compatible (including OpenCode) and image-generation requests. Provider names describe request channels, not model vendors. Local means self-hosted Ollama or an explicitly recorded loopback endpoint. Tokens are measured subtotals, not prices; missing usage stays unknown. Old Harness requests and image calls before image logging began cannot be reconstructed. Actual fallback attempts each count as a request; image tool results are not additional HTTP requests.',
}, null, 2));
