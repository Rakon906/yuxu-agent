// Public, first-party pages. Never execute scripts embedded in an upstream page.
export const OFFICIAL_SOURCES = Object.freeze({
  'lol-patches': Object.freeze({ id: 'lol-patches', kind: 'riot-patches', name: '英雄联盟国际服官方版本公告',
    url: 'https://www.leagueoflegends.com/en-us/news/tags/patch-notes/',
    pollMs: 6 * 3600000, topic: '英雄联盟', category: '游戏' }),
  'lol-esports': Object.freeze({ id: 'lol-esports', kind: 'riot-esports', name: 'LoL Esports 官方赛程',
    url: 'https://lolesports.com/en-US', pollMs: 30 * 60000, topic: '英雄联盟', category: '电竞' }),
  'delta-announcements': Object.freeze({ id: 'delta-announcements', kind: 'tencent-delta-announcements',
    name: '三角洲行动官方更新公告', url: 'https://comm.ams.game.qq.com/ide/',
    pageUrl: 'https://df.qq.com/cp/a20240906main/newslist.html',
    pollMs: 6 * 3600000, topic: '三角洲行动', category: '游戏', maxBytes: 2 * 1024 * 1024,
    // Public read-only flow identifiers from the official site's published JS/config;
    // these are NOT a user credential. No login, cookies or activity/claim flow is used.
    method: 'POST', form: Object.freeze({ iChartId: '329849', iSubChartId: '329849', sIdeToken: 'o3Iw53',
      chanid: '6896', typeids: '1', limit: '30', start: '0' }) }),
});

const text = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const instant = value => typeof value === 'string' && /(?:Z|[+-]\d{2}:\d{2})$/u.test(value) &&
  Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const plain = value => text(value, 3000).replace(/<[^>]*>/gu, ' ').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gu,
  match => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ' })[match])
  .replace(/\s+/gu, ' ').trim().slice(0, 700);

function objectAt(source, start) {
  let depth = 0, quoted = false, escape = false;
  for (let i = start; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === '"') quoted = false;
    } else if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(source.slice(start, i + 1));
  }
  throw new Error('Incomplete official JSON object');
}

export function parseRiotSchedule(html) {
  if (typeof html !== 'string' || html.length > 8 * 1024 * 1024 || !html.includes('ApolloSSRDataTransport')) {
    throw new Error('Official schedule format unavailable');
  }
  const found = new Map();
  for (const match of html.matchAll(/\{"__typename":"EventMatch",/gu)) {
    const item = objectAt(html, match.index);
    const startTime = instant(item.startTime);
    const status = ({ unstarted: 'scheduled', inProgress: 'live', completed: 'completed',
      cancelled: 'cancelled', canceled: 'cancelled', postponed: 'postponed' })[item.state];
    const externalId = text(item.id, 100);
    if (!/^\d{5,30}$/u.test(externalId) || !startTime || !status || item.type !== 'match') continue;
    if (!Array.isArray(item.matchTeams) || item.matchTeams.length !== 2) continue;
    const teams = item.matchTeams.map(team => ({ code: text(team.code, 20).toUpperCase(),
      name: text(team.name, 100), wins: Number.isSafeInteger(team.result?.gameWins) && team.result.gameWins >= 0
        ? team.result.gameWins : null, outcome: ['win', 'loss'].includes(team.result?.outcome) ? team.result.outcome : null }));
    if (teams.some(team => !/^[A-Z0-9._-]{1,20}$/u.test(team.code) || !team.name) || teams[0].code === teams[1].code) continue;
    const league = text(item.league?.name, 100), stage = text(item.blockName, 100);
    const row = { externalId, kind: 'match', title: `${teams[0].code} vs ${teams[1].code}${league ? ` · ${league}` : ''}`,
      summary: [league, stage].filter(Boolean).join(' / '), sourceUrl: OFFICIAL_SOURCES['lol-esports'].url,
      publishedAt: null, startTime, status, teams, league, stage,
      bestOf: Number.isSafeInteger(item.match?.strategy?.count) ? item.match.strategy.count : null };
    const prior = found.get(externalId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('Conflicting official match versions');
    found.set(externalId, row);
    if (found.size > 500) throw new Error('Official schedule too large');
  }
  if (!found.size) throw new Error('No validated official matches');
  return [...found.values()];
}

export function parseRiotPatches(html) {
  if (typeof html !== 'string' || html.length > 8 * 1024 * 1024) throw new Error('Invalid official patch page');
  const script = html.match(/<script\b[^>]*\bid=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/u);
  if (!script) throw new Error('Official patch page format unavailable');
  const data = JSON.parse(script[1]);
  const blades = data?.props?.pageProps?.page?.blades;
  if (!Array.isArray(blades)) throw new Error('Official patch list missing');
  const found = new Map();
  for (const blade of blades) for (const item of Array.isArray(blade.items) ? blade.items : []) {
    const title = plain(item.title), publishedAt = instant(item.publishedAt ?? item.analytics?.publishDate);
    const href = item.action?.payload?.url;
    if (!title || !publishedAt || typeof href !== 'string') continue;
    const url = new URL(href, OFFICIAL_SOURCES['lol-patches'].url);
    if (url.protocol !== 'https:' || url.hostname !== 'www.leagueoflegends.com' || url.username || url.password ||
        !/^\/en-us\/news\/game-updates\/[a-z0-9-]*patch-[a-z0-9-]+\/?$/u.test(url.pathname)) continue;
    url.search = ''; url.hash = '';
    const row = { externalId: url.pathname, kind: 'patch', title, summary: plain(item.description?.body),
      sourceUrl: url.href, publishedAt, startTime: null, status: 'published', teams: [] };
    const prior = found.get(row.externalId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('Conflicting official patch versions');
    found.set(row.externalId, row);
  }
  if (!found.size || found.size > 2000) throw new Error('No validated official patch notes');
  // The official hydration payload includes years of archives, beyond the visible first page.
  return [...found.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 100);
}

export function parseOfficialSource(sourceId, body) {
  if (sourceId === 'lol-esports') return parseRiotSchedule(body);
  if (sourceId === 'lol-patches') return parseRiotPatches(body);
  if (sourceId === 'delta-announcements') return parseDeltaAnnouncements(body);
  throw new Error('Unsupported official subscription source');
}

function beijingListTime(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)) return null;
  // The Chinese official page displays this timezone-less field as a local date.
  const local = value.replace(' ', 'T');
  const timestamp = Date.parse(`${local}+08:00`);
  if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 3600000).toISOString().slice(0, 19) !== local) return null;
  return new Date(timestamp).toISOString();
}

/** Official announcement list only: no body/rollout time is inferred from a title. */
export function parseDeltaAnnouncements(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > 2 * 1024 * 1024) throw new Error('Invalid Delta announcement response');
  const data = JSON.parse(body);
  const list = data?.jData?.data;
  if (data.iRet !== 0 || ![0, '0'].includes(data.jData?.iRet) || !list ||
      !Number.isSafeInteger(list.total) || list.total < 0 || !Array.isArray(list.items) || list.items.length > 100) {
    throw new Error('Official Delta announcement format unavailable');
  }
  const found = new Map(); let valid = 0;
  for (const item of list.items) {
    const externalId = item?.iDocID, title = plain(item?.sTitle), publishedAt = beijingListTime(item?.sIdxTime);
    // Preserve uint64 article identities as strings; reject other games/channels/media.
    if (typeof externalId !== 'string' || !/^\d{5,30}$/u.test(externalId) || !title || !publishedAt ||
        item.iInfoType !== 1 || item.iBiz !== 423 || !Array.isArray(item.sChannel) || !item.sChannel.includes(6896)) continue;
    const sourceUrl = `https://df.qq.com/cp/a20240906main/newsdetail.html?id=${externalId}`;
    if (item.sRedirectURL && item.sRedirectURL !== sourceUrl) continue;
    valid++;
    // The channel also contains punishment lists; only game-update topics are subscribed.
    if (!/更新|维护|赛季|修复|调整|优化|平衡/u.test(title) || /处罚|封禁|封号|作弊/u.test(title)) continue;
    const row = { externalId, kind: 'announcement', title, summary: plain(item.sDesc), sourceUrl,
      publishedAt, startTime: null, status: 'published', teams: [],
      contentScope: 'official_list_title_and_summary', publicationTimezone: 'Asia/Shanghai',
      rolloutTime: null };
    const prior = found.get(externalId);
    if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error('Conflicting official Delta announcement versions');
    found.set(externalId, row);
  }
  if (!valid && list.total !== 0) throw new Error('No validated official Delta announcements');
  return [...found.values()].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, 30);
}
