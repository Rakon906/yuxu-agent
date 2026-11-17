import { createHash, randomUUID } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const VERSION = 1;
const ipv4Blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],
  ['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],
  ['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],
  ['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]]) {
  ipv4Blocked.addSubnet(address, prefix, 'ipv4');
}
const ipv6Public = new BlockList();
ipv6Public.addSubnet('2000::', 3, 'ipv6');
const ipv6Blocked = new BlockList();
for (const [address, prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]]) {
  ipv6Blocked.addSubnet(address, prefix, 'ipv6');
}
const fakeIp = new BlockList();
fakeIp.addSubnet('198.18.0.0', 15, 'ipv4');
const fail = reason => Object.assign(new Error(reason), { articleReason: reason });
const hash = value => createHash('sha256').update(value).digest('hex');
const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');

export function isPublicArticleAddress(address) {
  const family = isIP(address);
  if (family === 4) return !ipv4Blocked.check(address, 'ipv4');
  // Restrict IPv6 to global unicast, excluding transition and special ranges.
  return family === 6 && ipv6Public.check(address, 'ipv6') && !ipv6Blocked.check(address, 'ipv6');
}

function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw fail('invalid_url');
  let url;
  try { url = new URL(value); } catch { throw fail('invalid_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw fail('non_public_url');
  const host = url.hostname.replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
  if (!host || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid|onion)$/u.test(host) ||
      (!isIP(host) && !host.includes('.')) || (isIP(host) && !isPublicArticleAddress(host))) {
    throw fail('non_public_url');
  }
  url.hash = '';
  return url;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(fail('aborted'));
  return new Promise((resolve, reject) => {
    const cancel = () => reject(fail(signal.reason?.name === 'TimeoutError' ? 'timeout' : 'aborted'));
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}

async function resolvePublic(url, lookupImpl, signal, publicLookupImpl) {
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  let addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
    : await abortable(lookupImpl(hostname, { all: true, verbatim: true }), signal);
  let resolver = 'system';
  // A TUN DNS can supply benchmark-range Fake-IP addresses. Never connect to
  // those addresses: independently resolve the hostname through authenticated
  // HTTPS DNS, then repeat the public-address check and pin that actual answer.
  if (!isIP(hostname) && addresses?.length && publicLookupImpl &&
      addresses.every(entry => isIP(entry.address) === 4 && fakeIp.check(entry.address, 'ipv4'))) {
    addresses = await abortable(publicLookupImpl(hostname, { signal }), signal);
    resolver = 'public_https';
  }
  if (!Array.isArray(addresses) || !addresses.length ||
      addresses.some(entry => !isPublicArticleAddress(entry.address))) throw fail('non_public_address');
  return { resolver, addresses:addresses.map(entry => ({ address: entry.address, family: isIP(entry.address) })) };
}

// The production transport pins the prevalidated DNS result, preserving hostname
// for TLS SNI / Host. A second DNS lookup must never select a private address.
function pinnedFetch(url, { signal, addresses, headers }) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', signal, headers, agent: false,
      lookup(_hostname, options, done) {
        if (options?.all) done(null, addresses);
        else done(null, addresses[0].address, addresses[0].family);
      },
    }, response => resolve({ status: response.statusCode, headers: {
      get(name) { const value = response.headers[name.toLowerCase()]; return Array.isArray(value) ? value[0] : value; },
    }, body: response }));
    request.once('error', reject);
    request.end();
  });
}

function discard(response) {
  response?.body?.destroy?.();
  if (response?.body?.cancel) void response.body.cancel().catch(() => {});
}

async function limitedBody(response, maxBytes, signal) {
  const length = Number(response.headers?.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) { discard(response); throw fail('response_too_large'); }
  if (!response.body?.[Symbol.asyncIterator]) throw fail('body_stream_unavailable');
  const chunks = [];
  let bytes = 0;
  const iterator = response.body[Symbol.asyncIterator]();
  try {
    while (true) {
      const part = await abortable(iterator.next(), signal);
      if (part.done) break;
      const chunk = Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value);
      bytes += chunk.length;
      if (bytes > maxBytes) throw fail('response_too_large');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    discard(response);
  }
}

async function publicHttpsLookup(hostname, { signal }) {
  const canonical = value => String(value ?? '').toLowerCase().replace(/\.$/u, '');
  const results = await Promise.all([1,28].map(async type => {
    const endpoint = new URL('https://dns.google/resolve');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', String(type));
    endpoint.searchParams.set('edns_client_subnet', '0.0.0.0/0');
    const response = await pinnedFetch(endpoint, { signal,
      addresses:[{address:'8.8.8.8',family:4},{address:'8.8.4.4',family:4}],
      headers:{ accept:'application/dns-json', 'accept-encoding':'identity' } });
    if (response.status !== 200) { discard(response); throw fail('public_dns_failed'); }
    const payload = JSON.parse((await limitedBody(response, 65536, signal)).toString('utf8'));
    if (payload.Status !== 0 || payload.TC || !payload.Question?.some(question =>
      canonical(question.name) === canonical(hostname) && question.type === type)) throw fail('public_dns_failed');
    const answers = payload.Answer ?? [];
    const permitted = new Set([canonical(hostname)]);
    for (let i = 0; i < 8; i += 1) {
      for (const answer of answers) if (answer.type === 5 && permitted.has(canonical(answer.name))) permitted.add(canonical(answer.data));
    }
    return answers.filter(answer => answer.type === type && permitted.has(canonical(answer.name)))
      .map(answer => ({address:answer.data,family:type === 1 ? 4 : 6}));
  }));
  return results.flat();
}

function entities(text) {
  const named = { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ', hellip:'…', mdash:'—', ndash:'–', lsquo:'‘', rsquo:'’', ldquo:'“', rdquo:'”', middot:'·', copy:'©' };
  return text.replace(/&(#(?:x[\da-f]+|\d+)|[a-z]+);/giu, (whole, entity) => {
    if (!entity.startsWith('#')) return named[entity.toLowerCase()] ?? whole;
    const hex = entity[1]?.toLowerCase() === 'x';
    const n = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : '�';
  });
}

function plainHtml(html) {
  return clean(entities(html.replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object|form|nav|footer|header)\b[^>]*>[^]*?<\/\1\s*>/giu, ' ')
    .replace(/<(?:br|hr)\b[^>]*>|<\/(?:p|div|article|section|main|li|h[1-6]|tr|blockquote)>/giu, '\n')
    .replace(/<[^>]*>/gu, ' ')))
    .replace(/[\t \u00a0]+/gu, ' ').replace(/ *\n */gu, '\n').replace(/\n{3,}/gu, '\n\n').trim();
}

function matchingElement(html, name, opening) {
  let depth = 1;
  const tags = new RegExp(`<\\/?${name}\\b[^>]*>`, 'giu');
  tags.lastIndex = opening.index + opening[0].length;
  let next;
  while ((next = tags.exec(html))) {
    if (/^<\//u.test(next[0])) depth -= 1;
    else if (!/\/\s*>$/u.test(next[0])) depth += 1;
    if (!depth) return html.slice(opening.index + opening[0].length, next.index);
  }
  return null;
}

export function extractArticleBody(html, { maxChars = 18000 } = {}) {
  // This parser only extracts text. No scripts, embedded URLs or instructions run.
  const stripped = html.replace(/<!--[^]*?-->/gu, ' ')
    .replace(/<(script|style|noscript|template|svg|iframe|object)\b[^>]*>[^]*?<\/\1\s*>/giu, ' ');
  const title = plainHtml(stripped.match(/<h1\b[^>]*>([^]*?)<\/h1\s*>/iu)?.[1] ??
    stripped.match(/<title\b[^>]*>([^]*?)<\/title\s*>/iu)?.[1] ?? '').slice(0, 300);
  let chosen = null;
  for (const pattern of [/<(div|section)\b[^>]*\bid\s*=\s*["']js_content["'][^>]*>/iu,
    /<(article)\b[^>]*>/iu, /<(main)\b[^>]*>/iu, /<(body)\b[^>]*>/iu]) {
    const match = pattern.exec(stripped);
    if (match) chosen = matchingElement(stripped, match[1], match);
    if (chosen) break;
  }
  const body = plainHtml(chosen ?? stripped);
  if (!body) throw fail('empty_body');
  if (/Sina Visitor System|百度安全验证|请完成安全验证|请先登录后查看|访问过于频繁|验证后继续访问|Just a moment\.\.\./iu.test(`${title}\n${body.slice(0, 1500)}`)) {
    throw fail('access_challenge');
  }
  return { title, text: body.slice(0, maxChars), truncated: body.length > maxChars };
}

/** On-demand, public, credential-free article reading. fetchImpl is for tests;
 * custom transports must honor addresses (DNS pinning) and redirect:'manual'. */
export function createArticleReader({ cacheDir = null, fetchImpl = pinnedFetch,
  lookupImpl = dnsLookup, publicLookupImpl = publicHttpsLookup, timeoutMs = 15000, maxBytes = 2 * 1024 * 1024,
  maxChars = 18000, maxRedirects = 4, cacheTtlMs = 6 * 60 * 60 * 1000,
  now = () => Date.now(),
} = {}) {
  const pending = new Map();
  const memory = new Map();
  for (const [key, value, minimum, maximum] of [
    ['timeoutMs',timeoutMs,1,60000],['maxBytes',maxBytes,1,4*1024*1024],
    ['maxChars',maxChars,1,64000],['maxRedirects',maxRedirects,0,8],['cacheTtlMs',cacheTtlMs,0,7*86400000],
  ]) if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${key}`);

  async function load(url) {
    let cached = memory.get(url);
    if (!cached && cacheDir) {
      try {
        const file = join(cacheDir, `${hash(url)}.json`);
        if ((await stat(file)).size > maxChars * 6 + 20000) return null;
        const data = await readFile(file, 'utf8');
        if (Buffer.byteLength(data) <= maxChars * 6 + 20000) cached = JSON.parse(data);
      } catch { /* A cache miss or invalid cache never substitutes for a fetch. */ }
    }
    if (cached?.version === VERSION && cached.url === url && cached.status === 'ok' &&
        typeof cached.text === 'string' && cached.text.length <= maxChars &&
        hash(cached.text) === cached.contentHash && now() - Date.parse(cached.fetchedAt) >= 0 &&
        now() - Date.parse(cached.fetchedAt) < cacheTtlMs) return { ...cached, cached: true };
    return null;
  }

  async function perform(url, externalSignal) {
    const signal = externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    let target = new URL(url);
    const seen = new Set();
    for (let step = 0; step <= maxRedirects; step += 1) {
      target = publicUrl(target.href);
      if (seen.has(target.href)) throw fail('redirect_loop');
      seen.add(target.href);
      const { addresses, resolver } = await resolvePublic(target, lookupImpl, signal, publicLookupImpl);
      const response = await abortable(fetchImpl(target, { addresses, signal, redirect: 'manual',
        headers: { 'user-agent':'SocioMem-ArticleReader/1.0', accept:'text/html,text/plain;q=0.9', 'accept-encoding':'identity' },
      }), signal);
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers?.get('location');
        discard(response);
        if (!location || step === maxRedirects) throw fail('redirect_limit');
        try { target = new URL(location, target); } catch { throw fail('invalid_redirect'); }
        continue;
      }
      if (response.status < 200 || response.status >= 300) { discard(response); throw fail(`http_${response.status}`); }
      const contentType = String(response.headers?.get('content-type') ?? '').toLowerCase();
      const encoding = response.headers?.get('content-encoding');
      if (encoding && encoding !== 'identity') { discard(response); throw fail('unsupported_encoding'); }
      if (!/^(?:text\/html|application\/xhtml\+xml|text\/plain)(?:;|$)/u.test(contentType)) {
        discard(response); throw fail('unsupported_content_type');
      }
      const bytes = await limitedBody(response, maxBytes, signal);
      const charset = contentType.match(/charset\s*=\s*["']?([a-z0-9_-]+)/u)?.[1] ?? 'utf-8';
      let body;
      try { body = new TextDecoder(charset).decode(bytes); } catch { throw fail('unsupported_charset'); }
      const extracted = contentType.startsWith('text/plain') ? { title: '', text: clean(body).trim().slice(0, maxChars), truncated: body.length > maxChars }
        : extractArticleBody(body, { maxChars });
      if (!extracted.text) throw fail('empty_body');
      const result = { version: VERSION, status:'ok', url, finalUrl:target.href,
        source:target.hostname, fetchedAt:new Date(now()).toISOString(), ...extracted,
        contentHash:hash(extracted.text), cached:false, contentScope:'external_article_body',
        trust:'untrusted_external_content', identityVerified:false, dnsResolution:resolver };
      memory.set(url, result);
      if (memory.size > 128) memory.delete(memory.keys().next().value);
      if (cacheDir) {
        try {
          await mkdir(cacheDir, { recursive:true });
          const file = join(cacheDir, `${hash(url)}.json`);
          const temporary = `${file}.${randomUUID()}.tmp`;
          await writeFile(temporary, JSON.stringify(result), { flag:'wx' });
          await rename(temporary, file);
        } catch { /* Reading remains usable if the optional cache is unwritable. */ }
      }
      return result;
    }
    throw fail('redirect_limit');
  }

  return async function readArticle({ url: value, signal } = {}) {
    let url;
    try {
      url = publicUrl(value).href;
      if (signal?.aborted) throw fail('aborted');
      const cached = await load(url);
      if (cached) return cached;
      if (pending.has(url)) return await (signal ? abortable(pending.get(url), signal) : pending.get(url));
      const operation = perform(url, signal);
      pending.set(url, operation);
      try { return await operation; } finally { pending.delete(url); }
    } catch (error) {
      return { status:'error', reason:error.articleReason ??
        (error.name === 'AbortError' ? 'aborted' : error.name === 'TimeoutError' ? 'timeout' : 'fetch_failed'),
        ...(url ? { url } : {}), text:'', fetchedAt:new Date(now()).toISOString(), cached:false };
    }
  };
}
