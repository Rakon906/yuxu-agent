import { join } from 'node:path';
import { fetchHotLists, searchTrends, TrendStore } from '../packages/trends/index.mjs';
import { deepReadItems, cookieFile, probeAuth } from '../packages/trends/deep.mjs';
import { createTrendDeepSummarizer, createTrendSummarizer, summarizePending }
  from '../packages/trends/model.mjs';
import { projectRoot } from './runtime.mjs';

const env = process.env;
const dbPath = env.SOCIOMEM_TRENDS_DB ?? join(projectRoot, '.runtime', 'trends', 'trends.sqlite');
const [command, ...args] = process.argv.slice(2);
const option = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const positional = args.filter((value, index) => !value.startsWith('--') &&
  !['--limit', '--status', '--summarize-limit', '--deep-limit'].includes(args[index - 1]));

function usage() {
  console.error('Usage: node scripts/trends.mjs fetch [--limit 30] [--no-summarize] [--no-deep] [--summarize-limit 120] [--deep-limit 2]');
  console.error('       node scripts/trends.mjs deep [--limit 2] [--retry-blocked]');
  console.error('       node scripts/trends.mjs auth');
  console.error('       node scripts/trends.mjs list [--status approved] [--limit 20]');
  console.error('       node scripts/trends.mjs search <query...> [--limit 5]');
  console.error('       node scripts/trends.mjs review <id> approve|reject|needs_review');
  console.error('       node scripts/trends.mjs stats');
  process.exitCode = 2;
}

const store = new TrendStore(dbPath);
try {
  if (command === 'fetch') {
    const limit = Number(option('--limit') ?? 30);
    const { items, errors } = await fetchHotLists({ limit });
    const counts = store.upsert(items);
    if (items.length) store.setMeta('last_fetch_at', new Date().toISOString());
    let summarized = null;
    if (!args.includes('--no-summarize')) {
      try {
        const model = createTrendSummarizer();
        summarized = await summarizePending(store,
          { model, limit: Number(option('--summarize-limit') ?? 120) });
      } catch (error) {
        for (const item of store.pending(120)) store.markFallback(item.id);
        summarized = { error: error.name };
      }
    }
    let deep = null;
    if (!args.includes('--no-summarize') && !args.includes('--no-deep') && items.length) {
      try {
        deep = await deepReadItems(store, items, {
          limit: Number(option('--deep-limit') ?? 2),
          model: createTrendDeepSummarizer(),
        });
      } catch (error) { deep = { error: error.name }; }
    }
    console.log(JSON.stringify({ fetched: items.length, ...counts, summarized, deep, errors,
      stats: store.stats() }, null, 2));
  } else if (command === 'deep') {
    const limit = Number(option('--limit') ?? 2);
    const rows = store.deepCandidates(Math.max(limit * 10, 200),
      { retryBlocked: args.includes('--retry-blocked') });
    const items = rows.map(row => ({ source: row.source, sourceId: row.source_id,
      title: row.title, excerpt: row.excerpt, url: row.url }));
    try {
      const deep = await deepReadItems(store, items, { limit, force: true,
        model: createTrendDeepSummarizer() });
      console.log(JSON.stringify(deep, null, 2));
    } catch (error) {
      console.error(`trends deep: ${error.message}`);
      process.exitCode = 1;
    }
  } else if (command === 'auth') {
    const rows = store.db.prepare(`SELECT source,source_id,title,excerpt,url FROM trends
      WHERE source IN ('zhihu','weibo','tieba') GROUP BY source`).all();
    const results = [];
    for (const source of ['zhihu', 'weibo', 'tieba']) {
      const row = rows.find(item => item.source === source);
      const item = row && { source, sourceId: row.source_id, title: row.title,
        excerpt: row.excerpt, url: row.url };
      results.push(item
        ? { source, file: cookieFile(source), ...await probeAuth(source, item) }
        : { source, file: cookieFile(source), status: 'no_sample' });
    }
    console.log(JSON.stringify(results, null, 2));
  } else if (command === 'list') {
    console.log(JSON.stringify(store.list({
      status: option('--status') ?? 'approved',
      limit: Number(option('--limit') ?? 20),
    }), null, 2));
  } else if (command === 'search') {
    const query = positional.join(' ').trim();
    if (!query) usage();
    else console.log(JSON.stringify(searchTrends(store.db,
      { query, limit: Number(option('--limit') ?? 5) }), null, 2));
  } else if (command === 'review') {
    const [id, action] = positional;
    const status = { approve: 'approved', reject: 'rejected', needs_review: 'needs_review' }[action];
    if (!id || !status) usage();
    else console.log(JSON.stringify(store.review(id, status), null, 2));
  } else if (command === 'stats') {
    console.log(JSON.stringify(store.stats(), null, 2));
  } else usage();
} finally { store.close(); }
