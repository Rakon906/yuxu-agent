import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { trendId } from './index.mjs';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const cookieFiles = {
  zhihu: process.env.SOCIOMEM_ZHIHU_COOKIE_FILE ??
    join(projectRoot, '.runtime', 'secrets', 'zhihu-cookies.txt'),
  weibo: process.env.SOCIOMEM_WEIBO_COOKIE_FILE ??
    join(projectRoot, '.runtime', 'secrets', 'weibo-cookies.txt'),
  tieba: process.env.SOCIOMEM_TIEBA_COOKIE_FILE ??
    join(projectRoot, '.runtime', 'secrets', 'tieba-cookies.txt'),
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const blockedPattern = /Sina Visitor System|百度安全验证|安全验证|登录后查看|请升级客户端|zh-zse-ck|验证码/u;
const entityMap = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—' };

export function cookieFile(source) {
  return cookieFiles[source] ?? null;
}

export function loadCookieHeader(source) {
  const file = cookieFiles[source];
  if (!file || !existsSync(file)) return null;
  let value;
  try { value = readFileSync(file, 'utf8'); } catch { return null; }
  value = value.replace(/^﻿/u, '').trim();
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      const list = Array.isArray(parsed) ? parsed : parsed.cookies ?? parsed;
      const host = source === 'zhihu' ? 'zhihu.com'
        : source === 'weibo' ? 'weibo.com' : 'baidu.com';
      if (Array.isArray(list)) {
        value = list.filter(cookie => cookie && typeof cookie.name === 'string' &&
          cookie.name.trim() && typeof cookie.value === 'string' &&
          (!cookie.domain || String(cookie.domain).includes(host)))
          .map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      } else if (list && typeof list === 'object') {
        value = Object.entries(list).filter(([, entry]) => typeof entry === 'string')
          .map(([name, entry]) => `${name}=${entry}`).join('; ');
      }
    } catch { return null; }
  }
  if (!value || value.length > 8192 || /[\r\n\u0000-\u001f]/u.test(value)) return null;
  return value;
}

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

function stripHtml(value) {
  return decodeEntities(String(value ?? '')
    .replace(/<script[\s\S]*?<\/script>/giu, ' ')
    .replace(/<style[\s\S]*?<\/style>/giu, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/giu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/<[^>]*>/gu, ' '))
    .replace(/[\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function metaDescription(html) {
  const match = html.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/iu) ??
    html.match(/<meta\s+content=["']([^"']*)["']\s+name=["']description["']/iu);
  return stripHtml(match?.[1] ?? '');
}

function tiebaText(html) {
  const titles = [...html.matchAll(/<a[^>]+href="\/p\/\d+"[^>]*>([\s\S]*?)<\/a>/gu)]
    .map(match => stripHtml(match[1])).filter(Boolean).slice(0, 10);
  return [metaDescription(html), ...titles].filter(Boolean).join('\n');
}

function tiebaPosts(html) {
  const posts = [
    ...html.matchAll(/<div[^>]+class="[^"]*d_post_content[^"]*"[^>]*>([\s\S]*?)<\/div>/gu),
    ...html.matchAll(/<div[^>]+class="[^"]*p_content[^"]*"[^>]*>([\s\S]*?)<\/div>/gu),
  ].map(match => stripHtml(match[1])).filter(Boolean);
  return [...new Set(posts)].slice(0, 3);
}

async function tiebaThreadText(html, { fetchImpl, cookie, referer }) {
  const links = [...html.matchAll(/<a[^>]+href="(\/p\/\d+)"[^>]*>/gu)]
    .map(match => match[1]).slice(0, 4);
  const texts = [];
  for (const href of links) {
    for (const pageNumber of [1, 2]) {
      try {
        const target = new URL(href, 'https://tieba.baidu.com');
        target.searchParams.set('pn', String(pageNumber));
        const response = await fetchImpl(target, {
          headers: { 'user-agent': UA, accept: 'text/html', referer, cookie },
          redirect: 'manual', signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) continue;
        const page = await response.text();
        if (blockedPattern.test(page)) continue;
        texts.push(...tiebaPosts(page));
      } catch { /* Keep other pages if one fails. */ }
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  return [...new Set(texts)].slice(0, 20);
}

async function zhihuAnswerText(item, { fetchImpl, cookie }) {
  if (!cookie || !item.sourceId) return '';
  const requested = Number(process.env.SOCIOMEM_TRENDS_ZHIHU_ANSWERS ?? 10);
  const limit = Number.isInteger(requested) && requested >= 1 && requested <= 20 ? requested : 10;
  const url = new URL(`https://www.zhihu.com/api/v4/questions/${encodeURIComponent(item.sourceId)}/answers`);
  url.searchParams.set('include', 'data[*].content');
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', '0');
  url.searchParams.set('order_by', 'default');
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: 'application/json',
        referer: `https://www.zhihu.com/question/${item.sourceId}`, cookie },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return '';
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) return '';
    const payload = JSON.parse(text);
    return (payload.data ?? []).map(answer => stripHtml(answer.content ?? ''))
      .filter(Boolean).join('\n');
  } catch { return ''; }
}

export async function readPublicPage(item, { fetchImpl = fetch, cookie: providedCookie = null } = {}) {
  if (!item || !['zhihu', 'tieba', 'weibo'].includes(item.source) ||
      typeof item.url !== 'string') return { status: 'error', reason: 'invalid_item' };
  let url;
  try { url = new URL(item.url); } catch { return { status: 'error', reason: 'invalid_url' }; }
  const cookie = providedCookie === false ? null
    : providedCookie ?? (['zhihu', 'weibo', 'tieba'].includes(item.source)
      ? loadCookieHeader(item.source) : null);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { 'user-agent': UA, accept: 'text/html,application/json',
        referer: item.source === 'weibo' ? 'https://weibo.com/'
          : item.source === 'zhihu' ? 'https://www.zhihu.com/' : 'https://tieba.baidu.com/',
        ...(cookie ? { cookie } : {}) },
      redirect: cookie ? 'manual' : 'follow', signal: AbortSignal.timeout(15000),
    });
  } catch (error) { return { status: 'error', reason: error.name }; }
  if (!response.ok) return { status: 'blocked', reason: `http_${response.status}` };
  let html;
  try { html = await response.text(); }
  catch (error) { return { status: 'error', reason: error.name }; }
  if (blockedPattern.test(html)) return { status: 'blocked', reason: 'login_or_verification' };
  let text;
  if (item.source === 'tieba') {
    const topic = tiebaText(html);
    const thread = cookie
      ? await tiebaThreadText(html, { fetchImpl, cookie, referer: url.toString() }) : [];
    text = [topic, ...thread].filter(Boolean).join('\n');
  } else if (item.source === 'zhihu') {
    const pageText = stripHtml(html);
    const answers = cookie ? await zhihuAnswerText(item, { fetchImpl, cookie }) : '';
    text = [pageText, answers].filter(Boolean).join('\n');
  } else {
    text = stripHtml(html);
  }
  if (text.length < 20) return { status: 'empty', reason: 'no_readable_text' };
  return { status: 'ok', text: text.slice(0, 48000) };
}

export async function probeAuth(source, item, { fetchImpl = fetch } = {}) {
  if (!['zhihu', 'weibo', 'tieba'].includes(source)) throw new Error('Invalid auth source');
  const cookie = loadCookieHeader(source);
  if (!cookie) return { source, cookie: false, status: 'missing_cookie' };
  const page = await readPublicPage(item, { fetchImpl, cookie });
  return { source, cookie: true, status: page.status, reason: page.reason ?? null };
}

export async function deepReadItems(store, items, { fetchImpl = fetch, model, limit = 2,
  delayMs = 1000, force = false, cookie = undefined, log = () => {} } = {}) {
  if (!Array.isArray(items) || !items.length) {
    return { processed: 0, ok: 0, blocked: 0, empty: 0, error: 0 };
  }
  if (typeof model !== 'function') throw new Error('Trend deep summarizer is required');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid deep read limit');
  const queues = new Map();
  for (const item of items) {
    if (!item || !['zhihu', 'tieba', 'weibo'].includes(item.source)) continue;
    if (!queues.has(item.source)) queues.set(item.source, []);
    queues.get(item.source).push(item);
  }
  const coverage = new Map(store.db.prepare(`SELECT source,COUNT(*) AS n FROM trends
    WHERE detail_status='ok' GROUP BY source`).all().map(row => [row.source, row.n]));
  const sources = [...queues.keys()]
    .sort((a, b) => (coverage.get(a) ?? 0) - (coverage.get(b) ?? 0));
  const selected = [];
  let cursor = 0;
  while (selected.length < limit && sources.some(source => queues.get(source).length)) {
    const source = sources[cursor % sources.length];
    const item = queues.get(source).shift();
    cursor++;
    if (!item) continue;
    const row = store.db.prepare('SELECT detail_status FROM trends WHERE id=?')
      .get(trendId(item.source, item.sourceId));
    if (!force && row?.detail_status) continue;
    selected.push(item);
  }
  const counts = { processed: 0, ok: 0, blocked: 0, empty: 0, error: 0 };
  for (const item of selected) {
    const id = trendId(item.source, item.sourceId);
    const page = await readPublicPage(item, { fetchImpl, cookie });
    counts.processed++;
    if (page.status !== 'ok') {
      counts[page.status] = (counts[page.status] ?? 0) + 1;
      store.markDeepRead(id, { status: page.status, reason: page.reason });
      log('trend_deep_read', { source: item.source, title: item.title, status: page.status,
        reason: page.reason });
    } else {
      store.markDeepRead(id, { text: page.text, status: 'ok' });
      try {
        const result = await model(item, page.text);
        if (result?.summary) store.markSummarized(id, { ...result, model: 'trend-deep' });
        counts.ok++;
        log('trend_deep_read', { source: item.source, title: item.title, status: 'ok',
          chars: page.text.length });
      } catch (error) {
        store.markDeepRead(id, { text: page.text, status: 'text_only', reason: error.name });
        counts.error++;
        log('trend_deep_read', { source: item.source, title: item.title, status: 'text_only',
          errorType: error.name });
      }
    }
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  return counts;
}
