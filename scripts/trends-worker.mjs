import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fetchHotLists, TrendStore } from '../packages/trends/index.mjs';
import { deepReadItems } from '../packages/trends/deep.mjs';
import { createTrendDeepSummarizer, createTrendSummarizer, summarizePending }
  from '../packages/trends/model.mjs';
import { projectRoot } from './runtime.mjs';
import { SubscriptionStore, defaultSubscriptions, refreshSubscriptions } from '../packages/subscriptions/index.mjs';

const env = process.env;
const dbPath = env.SOCIOMEM_TRENDS_DB ?? join(projectRoot, '.runtime', 'trends', 'trends.sqlite');
const hours = [...new Set(String(env.SOCIOMEM_TRENDS_HOURS ?? env.SOCIOMEM_TRENDS_HOUR ?? '11,20')
  .split(',').map(value => Number(value.trim()))
  .filter(value => Number.isInteger(value) && value >= 0 && value <= 23))].sort((a, b) => a - b);
if (!hours.length) throw new Error('SOCIOMEM_TRENDS_HOURS must contain hours 0..23');
const limit = Number(env.SOCIOMEM_TRENDS_LIMIT ?? 30);
if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('SOCIOMEM_TRENDS_LIMIT must be 1..100');
const deepLimit = Number(env.SOCIOMEM_TRENDS_DEEP ?? 2);
if (!Number.isSafeInteger(deepLimit) || deepLimit < 0 || deepLimit > 20) {
  throw new Error('SOCIOMEM_TRENDS_DEEP must be 0..20');
}
const once = process.argv.includes('--once');
const log = (kind, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...details }));
function latestSlot(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  const year = Number(parts.year), month = Number(parts.month), day = Number(parts.day);
  const currentHour = Number(parts.hour);
  const today = hours.filter(hour => hour <= currentHour)
    .map(hour => Date.UTC(year, month - 1, day, hour) - 8 * 3600000);
  if (today.length) return Math.max(...today);
  const yesterday = new Date(Date.UTC(year, month - 1, day) - 86400000);
  return Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(),
    yesterday.getUTCDate(), hours.at(-1)) - 8 * 3600000;
}
const store = new TrendStore(dbPath);
const subscriptions = new SubscriptionStore(env.SOCIOMEM_SUBSCRIPTIONS_DB ?? join(projectRoot, '.runtime/subscriptions/subscriptions.sqlite'));
function subscriptionConfig() {
  const configured = env.SOCIOMEM_SUBSCRIPTIONS_CONFIG ?? join(projectRoot, '.runtime/subscriptions/config.json');
  if (existsSync(configured)) return JSON.parse(readFileSync(configured, 'utf8'));
  const peoplePath = env.SOCIOMEM_PEOPLE_CONFIG ?? join(projectRoot, '.runtime/people/group-people.json');
  const accountId = env.SOCIOMEM_WECHAT_ACCOUNT_ID ?? (existsSync(peoplePath) ? JSON.parse(readFileSync(peoplePath, 'utf8')).accountId : null);
  const groupIds = (env.SOCIOMEM_WECHAT_GROUPS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  return accountId && groupIds.length ? defaultSubscriptions({ accountId, groupIds }) : { subscriptions: [] };
}
async function refreshOfficial() {
  try { const result = await refreshSubscriptions({ store: subscriptions, config: subscriptionConfig() });
    if (result) log('subscriptions_refresh', result);
  } catch (error) {
    subscriptions.configure({ subscriptions: [] });
    log('subscriptions_error', { errorType: error.name, disabled: true });
  }
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());

async function fetchNow() {
  const { items, errors } = await fetchHotLists({ limit });
  const counts = store.upsert(items);
  let summarized = null;
  let deep = null;
  if (items.length) {
    try {
      summarized = await summarizePending(store, { model: createTrendSummarizer(), limit: 120 });
    } catch (error) {
      for (const item of store.pending(120)) store.markFallback(item.id);
      summarized = { error: error.name };
    }
    if (deepLimit) {
      try {
        deep = await deepReadItems(store, items, { limit: deepLimit,
          model: createTrendDeepSummarizer(), log });
      } catch (error) { deep = { error: error.name }; }
    }
    store.setMeta('last_fetch_at', new Date().toISOString());
  }
  log('trends_fetch', { fetched: items.length, ...counts, summarized, deep, errors,
    stats: store.stats() });
}

const isDue = now => {
  const last = store.getMeta('last_fetch_at');
  if (!last) return true;
  const at = Date.parse(last);
  return !Number.isFinite(at) || at < latestSlot(now);
};
try {
  log('ready', { dbPath, hours, limit, once });
  await refreshOfficial();
  if (once || isDue(new Date())) await fetchNow();
  while (!once && !abort.signal.aborted) {
    try { await delay(10 * 60000, undefined, { signal: abort.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; break; }
    await refreshOfficial();
    if (isDue(new Date())) {
      try { await fetchNow(); }
      catch (error) { log('trends_error', { errorType: error.name, message: error.message }); }
    }
  }
} finally { subscriptions.close(); store.close(); log('stopped'); }
