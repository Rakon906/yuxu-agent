import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TrendStore, fetchTiebaHot, fetchWeiboHot, fetchZhihuHot, listGroupTopics, searchTrends } from '../packages/trends/index.mjs';
import { deepReadItems, readPublicPage } from '../packages/trends/deep.mjs';
import { chunkText, createTrendDeepSummarizer, summarizePending } from '../packages/trends/model.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const zhihuPayload = { data: [{ target: { id: 123, title: '测试知乎热点', excerpt: '这是摘要',
  created: 1793895601, url: 'https://api.zhihu.com/questions/2099651974094444000' },
  detail_text: '100万热度' }] };
const tiebaHtml = `<ul class="topic-top-list"><li class="topic-top-item">
  <a href="https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=42&amp;topic_name=x"
    target="_blank" class="topic-text">测试贴吧话题</a>
  <span class="topic-num">12.3W实时讨论</span>
  <p class="topic-top-item-desc">这是贴吧描述</p>
</li></ul>`;

const weiboPayload = { ok: 1, data: { realtime: [
  { word: '测试微博热搜', num: 123456, note: '这是微博说明', label_name: '热',
    word_scheme: '#测试微博热搜#', is_ad: 0 },
  { word: '广告内容', is_ad: 1 },
] } };

test('Zhihu and Tieba hot lists normalize into stable trend items', async () => {
  const zhihu = await fetchZhihuHot({ limit: 10, fetchImpl: async () =>
    ({ ok: true, status: 200, json: async () => zhihuPayload }) });
  assert.equal(zhihu.length, 1);
  assert.equal(zhihu[0].source, 'zhihu');
  assert.equal(zhihu[0].sourceId, '2099651974094444000');
  assert.equal(zhihu[0].title, '测试知乎热点');
  assert.equal(zhihu[0].url, 'https://www.zhihu.com/question/2099651974094444000');
  const tieba = await fetchTiebaHot({ limit: 10, fetchImpl: async () =>
    ({ ok: true, status: 200, text: async () => tiebaHtml }) });
  assert.equal(tieba.length, 1);
  assert.equal(tieba[0].source, 'tieba');
  assert.equal(tieba[0].sourceId, '42');
  assert.equal(tieba[0].title, '测试贴吧话题');
  assert.equal(tieba[0].excerpt, '这是贴吧描述');
  assert.equal(tieba[0].heat, '12.3W实时讨论');
});

test('Weibo hot search normalizes into trend items and skips ads', async () => {
  const weibo = await fetchWeiboHot({ limit: 10, fetchImpl: async () =>
    ({ ok: true, status: 200, json: async () => weiboPayload }) });
  assert.equal(weibo.length, 1);
  assert.equal(weibo[0].source, 'weibo');
  assert.equal(weibo[0].title, '测试微博热搜');
  assert.equal(weibo[0].heat, '123456 热');
  assert.ok(weibo[0].url.includes(encodeURIComponent('#测试微博热搜#')));
});

test('the long-term trend store dedupes without expiring and retrieves approved items', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'trend-test-'));
  const store = new TrendStore(join(root, 'trends.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const item = { source: 'zhihu', sourceId: '1', title: '有没有人打三角洲',
    excerpt: '三角洲新版本讨论', url: 'https://www.zhihu.com/question/1', heat: '10万',
    publishedAt: null, raw: {} };
  assert.deepEqual(store.upsert([item], '2026-11-01T00:00:00.000Z'), { inserted: 1, updated: 0 });
  assert.deepEqual(store.upsert([item], '2026-11-02T00:00:00.000Z'), { inserted: 0, updated: 1 });
  const [row] = store.list({ status: 'new', limit: 1 });
  assert.equal(row.seenCount, 2);
  assert.equal(row.firstSeenAt, '2026-11-01T00:00:00.000Z');
  assert.equal(row.lastSeenAt, '2026-11-02T00:00:00.000Z');
  store.markSummarized(row.id, { summary: '三角洲新版本引发讨论', keywords: ['三角洲', '游戏'],
    category: '游戏', safety: 'safe', reason: 'fixture', model: 'fixture' });
  assert.equal(store.list({ status: 'approved', limit: 1 })[0].summary, '三角洲新版本引发讨论');
  const matches = searchTrends(store.db, { query: '有人打三角洲吗', limit: 3,
    now: Date.parse('2026-11-03T00:00:00.000Z') });
  assert.equal(matches[0].id, row.id);
  store.markSummarized(row.id, { summary: '需要人工确认', keywords: [], category: '其他',
    safety: 'uncertain', reason: '不确定', model: 'fixture' });
  assert.equal(store.list({ status: 'needs_review', limit: 1 }).length, 1);
  assert.equal(searchTrends(store.db, { query: '三角洲', limit: 3 }).length, 0);
  store.review(row.id, 'approved');
  assert.equal(searchTrends(store.db, { query: '三角洲', limit: 3 }).length, 1);
});

test('trend search needs a specific keyword instead of any shared bigram', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'trend-test-'));
  const store = new TrendStore(join(root, 'trends.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const base = { source: 'weibo', url: 'https://s.weibo.com/weibo?q=', excerpt: '', heat: '',
    publishedAt: null, raw: {} };
  store.upsert([{ ...base, sourceId: 'a', title: '日常生活分享' },
    { ...base, sourceId: 'b', title: '三角洲新赛季' }], '2026-11-01T00:00:00.000Z');
  const rows = store.list({ status: 'new', limit: 10 });
  const generic = rows.find(row => row.title === '日常生活分享');
  const specific = rows.find(row => row.title === '三角洲新赛季');
  store.markSummarized(generic.id, { summary: '网友分享日常', keywords: ['生活', '日常', '分享'],
    category: '生活', safety: 'safe', reason: 'fixture', model: 'fixture' });
  store.markSummarized(specific.id, { summary: '射击游戏新赛季', keywords: ['三角洲', '游戏'],
    category: '游戏', safety: 'safe', reason: 'fixture', model: 'fixture' });
  assert.deepEqual(searchTrends(store.db, { query: '今天换个新的聊天主题怎么样' }), []);
  const matches = searchTrends(store.db, { query: '今天三角洲又更新了' });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].title, '三角洲新赛季');
  assert.deepEqual(matches[0].matchedKeywords, ['三角洲']);
});

test('group topics keep games, esports, travel and food and drop unrelated news', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'trend-test-'));
  const store = new TrendStore(join(root, 'trends.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const base = { source: 'weibo', url: 'https://s.weibo.com/weibo?q=', excerpt: '', heat: '',
    publishedAt: null, raw: {} };
  store.upsert([
    { ...base, sourceId: 'g1', title: '英雄联盟世界赛决赛' },
    { ...base, sourceId: 'g2', title: '三角洲新赛季更新' },
    { ...base, sourceId: 'f1', title: '这家火锅店排队两小时' },
    { ...base, sourceId: 's1', title: '某地暴雨预警' },
  ], '2026-11-01T00:00:00.000Z');
  const rows = new Map(store.list({ status: 'new', limit: 10 })
    .map(row => [row.title, row]));
  store.markSummarized(rows.get('英雄联盟世界赛决赛').id, { summary: 'LPL 队伍夺冠',
    keywords: ['英雄联盟', '世界赛'], category: '电竞', safety: 'safe', reason: 'fixture', model: 'fixture' });
  store.markSummarized(rows.get('三角洲新赛季更新').id, { summary: '新版本上线',
    keywords: ['三角洲'], category: '游戏', safety: 'safe', reason: 'fixture', model: 'fixture' });
  store.markSummarized(rows.get('这家火锅店排队两小时').id, { summary: '探店排队',
    keywords: ['火锅'], category: '生活', safety: 'safe', reason: 'fixture', model: 'fixture' });
  store.markSummarized(rows.get('某地暴雨预警').id, { summary: '暴雨',
    keywords: ['暴雨'], category: '社会', safety: 'safe', reason: 'fixture', model: 'fixture' });
  assert.ok(store.list({ status: 'approved', limit: 10 }).some(row => row.category === '电竞'));
  const topics = listGroupTopics(store.db, { now: Date.parse('2026-11-03T00:00:00Z'), days: 7 });
  const titles = topics.map(item => item.title);
  assert.ok(titles.includes('英雄联盟世界赛决赛'));
  assert.ok(titles.includes('三角洲新赛季更新'));
  assert.ok(titles.includes('这家火锅店排队两小时'));
  assert.ok(!titles.includes('某地暴雨预警'));
  assert.equal(topics.find(item => item.title === '这家火锅店排队两小时').topic, '美食');
  assert.equal(topics[0].topic, '游戏');
});

test('trend summaries are stored and failures fall back to reviewable rows', async t => {
  const root = await mkdtemp(join(projectRoot, '.runtime', 'trend-test-'));
  const store = new TrendStore(join(root, 'trends.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const base = { source: 'tieba', url: 'https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=',
    excerpt: '原始摘要', heat: '', publishedAt: null, raw: {} };
  store.upsert([{ ...base, sourceId: '1', title: '话题一' }, { ...base, sourceId: '2', title: '话题二' }]);
  const result = await summarizePending(store, { model: async batch => batch.map(item => ({
    id: item.id, summary: `摘要 ${item.title}`, keywords: ['测试'], category: '其他',
    safety: 'safe', reason: 'fixture',
  })) });
  assert.deepEqual(result, { processed: 2, approved: 2, needsReview: 0 });
  store.upsert([{ ...base, sourceId: '3', title: '话题三' }]);
  await summarizePending(store, { model: async () => { throw new Error('model down'); } });
  const [fallback] = store.list({ status: 'needs_review', limit: 1 });
  assert.equal(fallback.summary, '原始摘要');
  assert.equal(fallback.model, 'fallback');
});

const tiebaTopicHtml = `<html><head><meta name="description" content="贴吧专题说明：这是关于测试话题的详细背景和讨论汇总"></head>
  <body><a href="/p/111">帖子一标题与相关讨论</a><a href="/p/222">帖子二标题与更多内容</a></body></html>`;
const weiboVisitorHtml = '<html><head><title>Sina Visitor System</title></head><body></body></html>';

test('deep read extracts public Tieba topic text and records blocked sources', async t => {
  const tiebaItem = { source: 'tieba', sourceId: '42', title: '测试话题',
    excerpt: '原始摘要', url: 'https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=42' };
  const page = await readPublicPage(tiebaItem, { cookie: false, fetchImpl: async () =>
    ({ ok: true, status: 200, text: async () => tiebaTopicHtml }) });
  assert.equal(page.status, 'ok');
  assert.ok(page.text.includes('贴吧专题说明'));
  assert.ok(page.text.includes('帖子一标题'));
  const weibo = await readPublicPage({ source: 'weibo', sourceId: 'x', title: '微博',
    url: 'https://s.weibo.com/weibo?q=x' }, { cookie: false, fetchImpl: async () =>
    ({ ok: true, status: 200, text: async () => weiboVisitorHtml }) });
  assert.equal(weibo.status, 'blocked');
  const zhihu = await readPublicPage({ source: 'zhihu', sourceId: '1', title: '知乎',
    url: 'https://www.zhihu.com/question/1' }, { cookie: false, fetchImpl: async () =>
    ({ ok: false, status: 403 }) });
  assert.equal(zhihu.status, 'blocked');

  const root = await mkdtemp(join(projectRoot, '.runtime', 'trend-test-'));
  const store = new TrendStore(join(root, 'trends.sqlite'));
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  store.upsert([tiebaItem]);
  const result = await deepReadItems(store, [tiebaItem], { limit: 1, delayMs: 0, cookie: false,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => tiebaTopicHtml }),
    model: async () => ({ summary: '深入摘要', keywords: ['测试'], category: '社会',
      safety: 'safe', reason: 'fixture' }) });
  assert.deepEqual(result, { processed: 1, ok: 1, blocked: 0, empty: 0, error: 0 });
  const [row] = store.list({ status: 'approved', limit: 1 });
  assert.equal(row.summary, '深入摘要');
  assert.equal(row.detailStatus, 'ok');
  assert.ok(row.detailText.includes('帖子一标题'));
});

test('Tieba thread bodies are read when a cookie is present', async () => {
  const topic = `<html><head><meta name="description" content="专题说明：这是测试话题的背景"></head>
    <body><a href="/p/111">帖子一标题与讨论</a></body></html>`;
  const thread = '<html><body><div class="d_post_content">这是帖子正文，包含更多细节。</div></body></html>';
  const fetchImpl = async url => String(url).includes('/p/111')
    ? { ok: true, status: 200, text: async () => thread }
    : { ok: true, status: 200, text: async () => topic };
  const page = await readPublicPage({ source: 'tieba', sourceId: '42', title: '话题',
    url: 'https://tieba.baidu.com/hottopic/browse/hottopic?topic_id=42' },
  { fetchImpl, cookie: 'BDUSS=test' });
  assert.equal(page.status, 'ok');
  assert.ok(page.text.includes('这是帖子正文'));
});

test('long deep-read text is chunked and merged', async () => {
  const text = '这是一段测试句子，包含事件和数字。'.repeat(500);
  const chunks = chunkText(text, 1000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 1000));
  const calls = [];
  const ollama = async ({ component }) => {
    calls.push(component);
    if (component === 'trends_deep_chunk') return { summary: '片段摘要' };
    return { summary: '合并摘要', keywords: ['测试'], category: '其他',
      safety: 'safe', reason: 'fixture' };
  };
  const model = createTrendDeepSummarizer({ provider: 'ollama', fallback: 'none', ollama,
    chunkChars: 1000, maxChunks: 20 });
  const result = await model({ source: 'tieba', sourceId: '1', title: '标题', excerpt: '摘要' }, text);
  assert.equal(result.summary, '合并摘要');
  assert.ok(calls.includes('trends_deep_chunk'));
  assert.equal(calls.at(-1), 'trends_deep');
});

test('Zhihu answers are appended when a cookie is present', async () => {
  const question = '<html><head><title>知乎问题</title></head><body>这是一个知乎问题描述，长度足够用于测试。</body></html>';
  const answers = JSON.stringify({ data: [{ content: '<p>这是回答正文，包含更多细节。</p>' }] });
  const fetchImpl = async url => String(url).includes('/api/v4/questions/')
    ? { ok: true, status: 200, text: async () => answers }
    : { ok: true, status: 200, text: async () => question };
  const page = await readPublicPage({ source: 'zhihu', sourceId: '1', title: '知乎问题',
    url: 'https://www.zhihu.com/question/1' }, { fetchImpl, cookie: 'z_c0=test' });
  assert.equal(page.status, 'ok');
  assert.ok(page.text.includes('这是回答正文'));
});
