import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { GROUP_TOPIC_CATEGORIES, matchTopics } from '../topics/lexicon.mjs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
export const TREND_CATEGORIES = ['游戏', '电竞', '旅游', '美食', '科技', '社会', '娱乐', '体育', '财经', '生活', '其他'];
const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—' };

function decodeEntities(value) {
  return String(value ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, code) => {
    if (code[0] === '#') {
      const hex = code[1]?.toLowerCase() === 'x';
      const number = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isInteger(number) ? String.fromCodePoint(number) : match;
    }
    return entityMap[code.toLowerCase()] ?? match;
  });
}

function clean(value, max) {
  return decodeEntities(String(value ?? '').replace(/<[^>]*>/gu, ' '))
    .replace(/[\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, max);
}

export function trendId(source, sourceId) {
  return createHash('sha256').update(`${source}\0${sourceId}`).digest('hex');
}

export async function fetchZhihuHot({ limit = 30, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trend limit');
  const response = await fetchImpl('https://api.zhihu.com/topstory/hot-list?limit=50&reverse_order=0', {
    headers: { 'user-agent': UA, accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Zhihu hot list HTTP ${response.status}`);
  const payload = await response.json();
  return (payload.data ?? []).slice(0, limit).flatMap(item => {
    const target = item.target ?? {};
    const exactId = typeof target.url === 'string'
      ? target.url.match(/\/questions?\/(\d+)/u)?.[1] : null;
    const sourceId = exactId ?? String(target.id ?? item.card_id ?? '').trim();
    const title = clean(target.title, 200);
    if (!sourceId || !title) return [];
    const created = Number(target.created);
    return [{ source: 'zhihu', sourceId, title,
      excerpt: clean(target.excerpt, 600),
      url: `https://www.zhihu.com/question/${encodeURIComponent(sourceId)}`,
      heat: clean(item.detail_text, 60),
      publishedAt: Number.isFinite(created) && created > 0
        ? new Date(created * 1000).toISOString() : null,
      raw: item }];
  });
}

export async function fetchTiebaHot({ limit = 30, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trend limit');
  const response = await fetchImpl('https://tieba.baidu.com/hottopic/browse/topicList?res_type=1', {
    headers: { 'user-agent': UA, accept: 'text/html', referer: 'https://tieba.baidu.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Tieba hot list HTTP ${response.status}`);
  const html = await response.text();
  const blocks = [...html.matchAll(/<li class="topic-top-item">([\s\S]*?)<\/li>/gu)].map(match => match[1]);
  const items = [];
  for (const block of blocks) {
    const link = [...block.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)]
      .find(match => /hottopic\/browse\/hottopic/u.test(match[1]));
    if (!link) continue;
    let url;
    try { url = new URL(decodeEntities(link[1])); } catch { continue; }
    const sourceId = url.searchParams.get('topic_id');
    const title = clean(link[2], 200);
    if (!sourceId || !title || url.protocol !== 'https:' && url.protocol !== 'http:') continue;
    const description = block.match(/<p class="topic-top-item-desc">([\s\S]*?)<\/p>/u);
    const heat = block.match(/<span class="topic-num">([\s\S]*?)<\/span>/u);
    items.push({ source: 'tieba', sourceId, title,
      excerpt: clean(description?.[1] ?? '', 600),
      url: `https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=${encodeURIComponent(sourceId)}`,
      heat: clean(heat?.[1] ?? '', 60), publishedAt: null,
      raw: { block: block.slice(0, 4000) } });
    if (items.length >= limit) break;
  }
  return items;
}

export async function fetchWeiboHot({ limit = 30, fetchImpl = fetch } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trend limit');
  const response = await fetchImpl('https://weibo.com/ajax/side/hotSearch', {
    headers: { 'user-agent': UA, accept: 'application/json', referer: 'https://weibo.com/' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`Weibo hot search HTTP ${response.status}`);
  const payload = await response.json();
  const items = [];
  for (const item of (payload.data?.realtime ?? [])) {
    if (items.length >= limit) break;
    if (!item || item.is_ad === 1 || item.adid) continue;
    const word = clean(item.word, 200);
    if (!word || word.startsWith('广告')) continue;
    const note = clean(item.note, 600);
    const label = clean(item.label_name, 20);
    const num = Number(item.num);
    const heat = [Number.isFinite(num) && num > 0 ? String(num) : '', label].filter(Boolean).join(' ');
    const query = item.word_scheme || word;
    items.push({ source: 'weibo', sourceId: word, title: word,
      excerpt: note && note !== word ? note : '',
      url: `https://s.weibo.com/weibo?q=${encodeURIComponent(query)}`,
      heat, publishedAt: null, raw: item });
  }
  return items;
}

export async function fetchHotLists({ limit = 30, fetchImpl = fetch } = {}) {
  const [zhihu, tieba, weibo] = await Promise.allSettled([
    fetchZhihuHot({ limit, fetchImpl }),
    fetchTiebaHot({ limit, fetchImpl }),
    fetchWeiboHot({ limit, fetchImpl }),
  ]);
  const errors = [];
  if (zhihu.status === 'rejected') errors.push({ source: 'zhihu', message: zhihu.reason?.message ?? 'failed' });
  if (tieba.status === 'rejected') errors.push({ source: 'tieba', message: tieba.reason?.message ?? 'failed' });
  if (weibo.status === 'rejected') errors.push({ source: 'weibo', message: weibo.reason?.message ?? 'failed' });
  return {
    items: [...(zhihu.status === 'fulfilled' ? zhihu.value : []),
      ...(tieba.status === 'fulfilled' ? tieba.value : []),
      ...(weibo.status === 'fulfilled' ? weibo.value : [])],
    errors,
  };
}

export class TrendStore {
  constructor(filename) {
    mkdirSync(dirname(filename), { recursive: true });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS trends (
        id TEXT PRIMARY KEY, source TEXT NOT NULL, source_id TEXT NOT NULL,
        title TEXT NOT NULL, excerpt TEXT NOT NULL DEFAULT '',
        summary TEXT NOT NULL DEFAULT '', keywords_json TEXT NOT NULL DEFAULT '[]',
        category TEXT NOT NULL DEFAULT '其他', url TEXT NOT NULL,
        heat TEXT NOT NULL DEFAULT '', published_at TEXT,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL,
        seen_count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'new',
        safety TEXT NOT NULL DEFAULT 'safe', model TEXT NOT NULL DEFAULT '',
        reason TEXT NOT NULL DEFAULT '', raw_json TEXT,
        detail_text TEXT NOT NULL DEFAULT '', detail_status TEXT NOT NULL DEFAULT '',
        detail_reason TEXT NOT NULL DEFAULT '', detail_read_at TEXT);
      CREATE INDEX IF NOT EXISTS trends_status_time ON trends(status,last_seen_at);
      CREATE INDEX IF NOT EXISTS trends_source ON trends(source,last_seen_at);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    const columns = new Set(this.db.prepare('PRAGMA table_info(trends)').all().map(column => column.name));
    for (const [name, ddl] of [
      ['detail_text', "TEXT NOT NULL DEFAULT ''"],
      ['detail_status', "TEXT NOT NULL DEFAULT ''"],
      ['detail_reason', "TEXT NOT NULL DEFAULT ''"],
      ['detail_read_at', 'TEXT'],
    ]) if (!columns.has(name)) this.db.exec(`ALTER TABLE trends ADD COLUMN ${name} ${ddl}`);
  }
  close() { this.db.close(); }
  getMeta(key) { return this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value ?? null; }
  setMeta(key, value) {
    this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(key, value);
  }
  upsert(items, now = new Date().toISOString()) {
    if (!Array.isArray(items)) throw new Error('Invalid trend items');
    let inserted = 0, updated = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const item of items) {
        if (!item || !['zhihu', 'tieba', 'weibo'].includes(item.source) ||
            typeof item.sourceId !== 'string' || !item.sourceId || item.sourceId.length > 200 ||
            typeof item.title !== 'string' || !item.title.trim() || item.title.length > 300) continue;
        let url;
        try { url = new URL(item.url); } catch { continue; }
        if (!['http:', 'https:'].includes(url.protocol)) continue;
        const id = trendId(item.source, item.sourceId);
        const exists = this.db.prepare('SELECT 1 AS present FROM trends WHERE id=?').get(id);
        const raw = item.raw === undefined ? null : JSON.stringify(item.raw).slice(0, 8000);
        if (exists) {
          this.db.prepare(`UPDATE trends SET title=?,excerpt=?,url=?,heat=?,
            published_at=COALESCE(?,published_at),last_seen_at=?,seen_count=seen_count+1,raw_json=?
            WHERE id=?`).run(item.title.trim(), clean(item.excerpt, 600), url.toString(),
            clean(item.heat, 60), typeof item.publishedAt === 'string' ? item.publishedAt : null,
            now, raw, id);
          updated++;
        } else {
          this.db.prepare(`INSERT INTO trends
            (id,source,source_id,title,excerpt,url,heat,published_at,first_seen_at,last_seen_at,raw_json)
            VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, item.source, item.sourceId, item.title.trim(),
            clean(item.excerpt, 600), url.toString(), clean(item.heat, 60),
            typeof item.publishedAt === 'string' ? item.publishedAt : null, now, now, raw);
          inserted++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { inserted, updated };
  }
  pending(limit = 20) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid trend limit');
    return this.db.prepare(`SELECT id,source,title,excerpt FROM trends
      WHERE status='new' ORDER BY last_seen_at DESC LIMIT ?`).all(limit);
  }
  markSummarized(id, { summary, keywords, category, safety, reason, model } = {}) {
    const text = clean(summary, 240);
    const list = (Array.isArray(keywords) ? keywords : [])
      .map(value => clean(value, 24)).filter(Boolean).slice(0, 8);
    const safe = ['safe', 'uncertain', 'unsafe'].includes(safety) ? safety : 'uncertain';
    const status = safe === 'safe' && text ? 'approved' : 'needs_review';
    this.db.prepare(`UPDATE trends SET summary=?,keywords_json=?,category=?,safety=?,model=?,
      reason=?,status=? WHERE id=?`).run(text, JSON.stringify(list),
      TREND_CATEGORIES.includes(category) ? category : '其他', safe,
      clean(model, 60), clean(reason, 160), status, id);
    return status;
  }
  markFallback(id, model = 'fallback') {
    this.db.prepare(`UPDATE trends SET summary=CASE WHEN summary='' THEN excerpt ELSE summary END,
      keywords_json=CASE WHEN keywords_json='[]' THEN ? ELSE keywords_json END,
      category=CASE WHEN category='其他' THEN '其他' ELSE category END,
      safety='uncertain',model=?,reason='summarizer unavailable',status='needs_review' WHERE id=?`)
      .run(JSON.stringify([]), model, id);
  }
  markDeepRead(id, { text = '', status, reason = '' } = {}) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid trend ID');
    if (!['ok', 'blocked', 'empty', 'text_only', 'error'].includes(status)) throw new Error('Invalid deep read status');
    this.db.prepare(`UPDATE trends SET detail_text=?,detail_status=?,detail_reason=?,detail_read_at=?
      WHERE id=?`).run(clean(text, 48000), status, clean(reason, 160), new Date().toISOString(), id);
  }
  deepCandidates(limit = 5, { retryBlocked = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('Invalid deep read limit');
    const where = retryBlocked ? "detail_status IN ('','blocked')" : "detail_status=''";
    return this.db.prepare(`SELECT id,source,source_id,title,excerpt,url FROM trends
      WHERE status IN ('approved','needs_review') AND ${where}
      ORDER BY last_seen_at DESC LIMIT ?`).all(limit);
  }
  list({ status = 'approved', limit = 20 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid trend limit');
    return this.db.prepare(`SELECT * FROM trends WHERE status=? ORDER BY last_seen_at DESC LIMIT ?`)
      .all(status, limit).map(row => this.present(row));
  }
  review(id, status) {
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('Invalid trend ID');
    if (!['approved', 'needs_review', 'rejected'].includes(status)) throw new Error('Invalid trend status');
    const result = this.db.prepare('UPDATE trends SET status=? WHERE id=?').run(status, id);
    if (result.changes !== 1) throw new Error('Trend not found');
    return this.present(this.db.prepare('SELECT * FROM trends WHERE id=?').get(id));
  }
  stats() {
    return {
      total: this.db.prepare('SELECT COUNT(*) AS n FROM trends').get().n,
      bySource: this.db.prepare('SELECT source,COUNT(*) AS n FROM trends GROUP BY source').all(),
      byStatus: this.db.prepare('SELECT status,COUNT(*) AS n FROM trends GROUP BY status').all(),
      firstSeenAt: this.db.prepare('SELECT MIN(first_seen_at) AS at FROM trends').get().at,
      lastSeenAt: this.db.prepare('SELECT MAX(last_seen_at) AS at FROM trends').get().at,
    };
  }
  present(row) {
    return { id: row.id, source: row.source, sourceId: row.source_id, title: row.title,
      excerpt: row.excerpt, summary: row.summary,
      keywords: JSON.parse(row.keywords_json || '[]'), category: row.category,
      url: row.url, heat: row.heat, publishedAt: row.published_at,
      firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at,
      seenCount: row.seen_count, status: row.status, safety: row.safety,
      model: row.model, reason: row.reason,
      detailText: row.detail_text, detailStatus: row.detail_status,
      detailReason: row.detail_reason, detailReadAt: row.detail_read_at };
  }
}

const GENERIC_KEYWORDS = new Set(['游戏', '社会', '体育', '娱乐', '科技', '财经', '生活', '其他',
  '网络', '新闻', '讨论', '热议', '比赛', '政策', '教育', '消费', '健康', '日常', '分享',
  '争议', '反思', '热度', '热点', '网红', '明星', '事件', '网友', '话题', '内容']);

const normalizeTerm = value => String(value ?? '').normalize('NFKC').toLowerCase().trim();

function isSpecificKeyword(keyword) {
  return keyword.length >= 3 || !GENERIC_KEYWORDS.has(keyword);
}

export function searchTrends(db, { query, context = [], limit = 3, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid trend limit');
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='trends'").get();
  if (!table) return [];
  const text = normalizeTerm(query);
  const contextText = normalizeTerm((Array.isArray(context) ? context : [context]).join(' '));
  if (!text && !contextText) return [];
  const asciiWords = text.match(/[a-z0-9]{3,}/gu) ?? [];
  const shortQuery = text.length >= 3 && text.length <= 20;
  const rows = db.prepare(`SELECT id,source,title,summary,keywords_json,category,url,
    last_seen_at FROM trends WHERE status='approved' ORDER BY last_seen_at DESC LIMIT 5000`).all();
  const scored = [];
  for (const row of rows) {
    const keywords = JSON.parse(row.keywords_json || '[]')
      .map(normalizeTerm).filter(keyword => keyword.length >= 2);
    const inTarget = keywords.filter(keyword => text && text.includes(keyword));
    const inContext = keywords.filter(keyword => keyword.length >= 3 && contextText.includes(keyword));
    const matched = [...new Set([...inTarget, ...inContext])];
    const specific = matched.filter(isSpecificKeyword);
    let score;
    if (specific.length) {
      const weak = matched.length - specific.length;
      score = specific.length * 10 + weak * 4 + Math.min(specific.length, 3);
    } else {
      const title = normalizeTerm(row.title);
      const titleHit = (shortQuery && title.includes(text)) ||
        asciiWords.some(word => title.includes(word));
      if (!titleHit) continue;
      score = 6;
    }
    const age = now - Date.parse(row.last_seen_at);
    if (Number.isFinite(age)) score += age < 7 * 86400000 ? 2 : age < 30 * 86400000 ? 1 : 0;
    scored.push({ id: row.id, source: row.source, title: row.title, summary: row.summary,
      keywords, matchedKeywords: specific, category: row.category, url: row.url,
      lastSeenAt: row.last_seen_at, score });
  }
  return scored.sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, limit);
}

const TOPIC_PRIORITY = { 游戏: 0, 电竞: 1, 旅游: 2, 美食: 3 };

export function isGroupRelevant({ category, title, keywords } = {}) {
  if (GROUP_TOPIC_CATEGORIES.has(category)) return true;
  // 摘要里偶尔提到「旅游」不代表这条热点是旅游内容，只看标题和关键词。
  return matchTopics([title, ...(Array.isArray(keywords) ? keywords : [])].join(' ')).length > 0;
}

export function listGroupTopics(db, { now = Date.now(), days = 7, limit = 6 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error('Invalid trend limit');
  const table = db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name='trends'").get();
  if (!table) return [];
  const since = new Date(now - days * 86400000).toISOString();
  const rows = db.prepare(`SELECT id,source,title,summary,keywords_json,category,url,last_seen_at
    FROM trends WHERE status='approved' AND last_seen_at>=? ORDER BY last_seen_at DESC LIMIT 300`)
    .all(since);
  const scored = [];
  for (const row of rows) {
    const keywords = JSON.parse(row.keywords_json || '[]');
    const text = [row.title, row.summary, ...keywords].join(' ');
    if (!isGroupRelevant({ category: row.category, title: row.title, keywords })) continue;
    const topics = new Set([row.category, ...matchTopics(text).map(hit => hit.topic)]
      .filter(topic => GROUP_TOPIC_CATEGORIES.has(topic)));
    const topic = [...topics].sort((a, b) => (TOPIC_PRIORITY[a] ?? 9) - (TOPIC_PRIORITY[b] ?? 9))[0];
    scored.push({ id: row.id, source: row.source, title: row.title, summary: row.summary,
      category: row.category, topic, keywords, url: row.url, lastSeenAt: row.last_seen_at,
      priority: TOPIC_PRIORITY[topic] ?? 9 });
  }
  const pools = new Map([...GROUP_TOPIC_CATEGORIES].map(topic => [topic, []]));
  for (const item of scored.sort((a, b) => a.priority - b.priority ||
    b.lastSeenAt.localeCompare(a.lastSeenAt))) {
    pools.get(item.topic)?.push(item);
  }
  // 轮转取样：游戏/电竞再多也不会把旅游、美食挤掉。
  const ordered = [...pools.keys()].filter(topic => pools.get(topic).length);
  const picked = [];
  while (picked.length < limit && ordered.some(topic => pools.get(topic).length)) {
    for (const topic of ordered) {
      const pool = pools.get(topic);
      if (picked.length >= limit) break;
      if (pool.length) picked.push(pool.shift());
    }
  }
  return picked.map(({ priority, ...item }) => item);
}
