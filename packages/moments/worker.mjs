import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createAnthropicJsonModel } from '../model/anthropic.mjs';
import { createOllamaJsonModel } from '../model/ollama.mjs';
import { describeMomentMedia, downloadMomentImage } from './media.mjs';
import { loadOfficialCacheImages } from './official-cache.mjs';
import { encodeFields } from './protobuf.mjs';
import { parseTimelineReply, timelineBody } from './timeline.mjs';
import { gameParticipationViolation } from '../participation/game-boundary.mjs';

const DAY = 24 * 3600000;
const HOUR = 3600000;
const skillUrl = new URL('../../skills/moments/SKILL.md', import.meta.url);

export const defaultMomentsLimits = Object.freeze({
  maxAgeMs: 72 * HOUR,
  maxPosts: 10,
  maxLikesPerDay: Infinity,
  maxCommentsPerDay: 3,
  cooldownMs: 60 * 1000,
  busyMs: 3 * 60 * 1000,
});

export function newClientId(now = Date.now()) {
  return `${Math.floor(now / 1000)}${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
}

export function momentsDecisionMessages({ moment, self, recentActions = [], currentTime = null, socialContext = null }) {
  const current = currentTime ?? {
    utc: new Date().toISOString(),
    timezone: 'Asia/Shanghai',
    local: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric',
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      hourCycle: 'h23' }).format(new Date()),
  };
  return [
    { role: 'system', content: readFileSync(skillUrl, 'utf8') },
    { role: 'user', content: JSON.stringify({
      currentTime: current,
      self: { name: self.name },
      socialContext,
      moment: {
        id: moment.id,
        author: { id: moment.author.id, name: moment.author.name },
        createdAt: moment.createTime ? new Date(moment.createTime * 1000).toISOString() : null,
        text: moment.text.slice(0, 4000),
        media: (moment.media ?? []).slice(0, 9).map(item => ({
          type: item.type, description: item.description, width: item.width, height: item.height,
          vision: item.vision ? { scene: item.vision.scene,
            visibleText: item.vision.visibleText ?? item.vision.visible_text ?? '',
            tone: item.vision.tone ?? '', safety: item.vision.safety ?? 'uncertain' } : null,
        })),
        location: moment.location,
        likes: (moment.likes ?? []).map(item => item.name),
        comments: (moment.comments ?? []).slice(0, 20).map(item => ({
          name: item.name, text: item.text, replyTo: item.replyTo,
        })),
      },
      recentAgentComments: recentActions.filter(item => item.kind === 'comment')
        .map(item => item.text).filter(Boolean).slice(0, 10),
    }) },
  ];
}

export function validateMomentDecision(value, { contextText = '' } = {}) {
  if (!value || typeof value !== 'object' || !['none', 'like', 'comment'].includes(value.action)) {
    throw new Error('Invalid moments decision action');
  }
  const reason = typeof value.reason === 'string' ? value.reason.slice(0, 120) : '';
  let comment = typeof value.comment === 'string' ? value.comment
    .replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim() : '';
  if (comment.length > 60 || /https?:\/\//iu.test(comment) || /@/u.test(comment)) comment = '';
  if (value.action === 'comment' && !comment) return { action: 'none', comment: '', reason };
  if (value.action !== 'comment') comment = '';
  if (gameParticipationViolation(comment, { contextText })) {
    return { action: 'none', comment: '', reason: 'cannot_play_games',
      ...(Array.isArray(value.memory) ? { memory: value.memory.slice(0, 3) } : {}) };
  }
  return { action: value.action, comment, reason,
    ...(Array.isArray(value.memory) ? { memory: value.memory.slice(0, 3) } : {}) };
}

export function selectCandidateMoments(timeline, { selfId, ledger, now = Date.now(),
  maxAgeMs = defaultMomentsLimits.maxAgeMs, limit = defaultMomentsLimits.maxPosts } = {}) {
  if (!timeline || !Array.isArray(timeline.objects)) throw new Error('Invalid moments timeline');
  return timeline.objects.filter(object => object.author?.id && object.author.id !== selfId &&
    !object.private && !object.advertisement &&
    (object.text.trim() || (object.media ?? []).length) &&
    Number.isFinite(object.createTime) && object.createTime * 1000 >= now - maxAgeMs &&
    !ledger.seen(object.id))
    .sort((a, b) => b.createTime - a.createTime)
    .slice(0, limit);
}

export function createMomentsDecisionModel({ provider = process.env.SOCIOMEM_MOMENTS_PROVIDER ?? 'ollama',
  anthropic = null, ollama = null, lookupSocialContext = null } = {}) {
  let model;
  if (provider === 'anthropic') {
    try { model = anthropic ?? createAnthropicJsonModel(); }
    catch { model = ollama ?? createOllamaJsonModel(); }
  } else if (provider === 'ollama') {
    model = ollama ?? createOllamaJsonModel();
  } else throw new Error('Invalid moments provider');
  return async input => model({ component: 'moments', messages: momentsDecisionMessages({ ...input,
    socialContext: lookupSocialContext ? await lookupSocialContext(input) : null }),
    maxTokens: 500, temperature: 0.4, timeoutMs: 120000 });
}

export function likeBody(moment, self, clientId, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const action = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: moment.author.id },
    { number: 5, varint: 1 },
    { number: 6, varint: 1 },
    { number: 7, varint: seconds },
  ]);
  const group = encodeFields([
    { number: 1, varint: BigInt(moment.id) },
    { number: 3, bytes: action },
  ]);
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}

export function commentBody(moment, self, text, clientId, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const action = encodeFields([
    { number: 1, bytes: self.id },
    { number: 2, bytes: text },
    { number: 3, bytes: text },
    { number: 4, bytes: text },
    { number: 5, varint: 2 },
    { number: 6, varint: 0 },
    { number: 7, varint: seconds },
    { number: 8, bytes: text },
    { number: 12, varint: 0 },
    { number: 13, varint: 0 },
  ]);
  const group = encodeFields([
    { number: 1, varint: BigInt(moment.id) },
    { number: 3, bytes: action },
  ]);
  return encodeFields([
    { number: 2, bytes: group },
    { number: 3, bytes: clientId },
  ]).toString('hex');
}

export function isBusy({ inboxPath, now = Date.now(), busyMs = defaultMomentsLimits.busyMs } = {}) {
  if (!inboxPath || !existsSync(inboxPath)) return false;
  const db = new DatabaseSync(inboxPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT message FROM inbox ORDER BY rowid DESC LIMIT 1').get();
    if (!row) return false;
    const at = Date.parse(JSON.parse(row.message).at ?? '');
    return Number.isFinite(at) && now - at < busyMs;
  } catch { return false; }
  finally { db.close(); }
}

export { planRuns, nextRunAt, claimScheduledRun } from './browse-schedule.mjs';

export async function readTimeline({ client, now = Date.now(),
  maxAgeMs = defaultMomentsLimits.maxAgeMs, maxPages = 10 } = {}) {
  const objects = [];
  const seen = new Set();
  let maxId = 0n;
  let pages = 0;
  for (; pages < maxPages; pages++) {
    const reply = await client.probe(211, timelineBody({ maxId, minId: 0n }), { withBaseRequest: true });
    if (reply.ok === false) throw new Error(reply.detail ?? 'Moments timeline failed');
    const page = parseTimelineReply(reply.replyHex);
    const fresh = page.objects.filter(item => !seen.has(String(item.id)));
    for (const item of fresh) { seen.add(String(item.id)); objects.push(item); }
    if (!page.objects.length || !fresh.length) break;
    const oldest = page.objects.reduce((a, b) => BigInt(a.id) <= BigInt(b.id) ? a : b);
    const next = BigInt(oldest.id);
    if (next === 0n || next === maxId) break;
    if (oldest.createTime && oldest.createTime * 1000 < now - maxAgeMs) break;
    maxId = next;
  }
  return { objects, pages: pages + 1 };
}

async function verifyComment({ client, momentId, self, text, sentAt }) {
  try {
    const reply = await client.probe(211, timelineBody(), { withBaseRequest: true });
    if (reply.ok === false) return null;
    const moment = parseTimelineReply(reply.replyHex).objects
      .find(item => String(item.id) === String(momentId));
    const comment = (moment?.comments ?? [])
      .filter(item => item.userId === self.id && item.text === text &&
        (item.createTime ?? 0) >= sentAt - 5)
      .sort((a, b) => (b.createTime ?? 0) - (a.createTime ?? 0))[0];
    return comment ? String(comment.commentId) : null;
  } catch { return null; }
}

export async function runMomentsCycle({ ledger, client, model, self, now = Date.now(),
  send = false, likeSend = false, commentSend = false, limits = defaultMomentsLimits,
  vision = null, visionEnabled = false, download = undefined,
  officialCache = null,
  maxImagesPerRun = 8, maxImagesPerMoment = 3, rememberMoment = null } = {}) {
  const timeline = await readTimeline({ client, now, maxAgeMs: limits.maxAgeMs });
  if (rememberMoment) for (const moment of timeline.objects) {
    if (moment.author?.id === self.id) continue;
    try { await rememberMoment(moment, [], now); }
    catch (error) { ledger.trace('moments.memory_error', { errorType: error.name }); }
  }
  let officialImages = null;
  if (officialCache?.enabled && typeof client.downloadImage !== 'function') {
    try {
      officialImages = loadOfficialCacheImages({ ...officialCache,
        media: timeline.objects.flatMap(object => object.media ?? []) });
      ledger.trace('moments.official_cache', { images: officialImages.size });
    } catch (error) {
      ledger.trace('moments.official_cache_error', { errorType: error.name });
    }
  }
  const downloadImage = item => {
    if (download) return download(item);
    if (typeof client.downloadImage === 'function') return client.downloadImage(item.momentId, item);
    const cached = officialImages?.get(String(item?.md5 ?? '').toLowerCase());
    if (cached) {
      return Promise.resolve({ bytes: cached.bytes,
        extension: cached.mediaType.split('/')[1].replace('jpeg', 'jpg'),
        mediaType: cached.mediaType, sha256: createHash('sha256').update(cached.bytes).digest('hex'),
        sourceUrl: 'official-cache' });
    }
    return (download ?? downloadMomentImage)(item);
  };
  const candidates = selectCandidateMoments(timeline, { selfId: self.id, ledger, now,
    maxAgeMs: limits.maxAgeMs, limit: limits.maxPosts });
  const summary = { at: new Date(now).toISOString(), read: timeline.objects.length,
    pages: timeline.pages, candidates: candidates.length, decisions: [], actions: [] };
  if (officialImages) summary.cacheImages = officialImages.size;
  let lastActionAt = ledger.recentActions({ since: now - HOUR })[0]?.created_at ?? 0;
  const mediaBudget = { remaining: maxImagesPerRun };
  for (const moment of candidates) {
    const media = visionEnabled
      ? await describeMomentMedia({ moment, ledger, vision, download: downloadImage,
        budget: mediaBudget, now, maxImages: maxImagesPerMoment })
      : (moment.media ?? []);
    const inputMoment = { ...moment, media };
    const unsafe = media.some(item => item?.vision?.safety === 'unsafe');
    let decision;
    if (unsafe) {
      decision = { action: 'none', comment: '', reason: 'unsafe_media' };
    } else {
      try {
        decision = validateMomentDecision(await model({ moment: inputMoment, self, currentTime: {
          utc: new Date(now).toISOString(), timezone: 'Asia/Shanghai',
          local: new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric',
            month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
            hourCycle: 'h23' }).format(new Date(now)) },
        recentActions: ledger.recentActions({ since: now - DAY }) }), { contextText: moment.text });
      } catch (error) {
        ledger.trace('moments.decision_error', { momentId: moment.id, errorType: error.name });
        summary.decisions.push({ momentId: moment.id, error: error.name });
        continue;
      }
    }
    if (rememberMoment && !unsafe) {
      try { await rememberMoment(moment, decision.memory ?? [], now); }
      catch (error) { ledger.trace('moments.memory_error', { errorType: error.name }); }
    }
    ledger.markSeen({ momentId: moment.id, authorId: moment.author.id,
      authorName: moment.author.name, createdAt: moment.createTime
        ? new Date(moment.createTime * 1000).toISOString() : null,
      text: moment.text, decision: decision.action, reason: decision.reason,
      comment: decision.comment, state: 'decided', now });
    summary.decisions.push({ momentId: moment.id, action: decision.action,
      comment: decision.comment, reason: decision.reason });
    if (decision.action === 'none') continue;
    if (!send) {
      ledger.trace('moments.shadow', { momentId: moment.id, action: decision.action,
        comment: decision.comment });
      continue;
    }
    if (decision.action === 'like' && !likeSend) continue;
    if (decision.action === 'comment' && !commentSend) continue;
    if (decision.action === 'like' && moment.likes.some(item => item.userId === self.id)) continue;
    const kind = decision.action;
    const cap = kind === 'like' ? limits.maxLikesPerDay : limits.maxCommentsPerDay;
    if (Number.isFinite(cap) && ledger.countToday(kind, now) >= cap) {
      ledger.trace('moments.daily_cap', { momentId: moment.id, kind });
      continue;
    }
    if (lastActionAt && now - lastActionAt < limits.cooldownMs) {
      ledger.trace('moments.cooldown', { momentId: moment.id, kind });
      continue;
    }
    const clientId = newClientId(now);
    const bodyHex = kind === 'like'
      ? likeBody(moment, self, clientId, now)
      : commentBody(moment, self, decision.comment, clientId, now);
    const actionKey = `moments-${kind}-${moment.id}-${now}-${clientId}`;
    ledger.recordAction({ key: actionKey, kind, momentId: moment.id, authorId: moment.author.id,
      text: decision.comment, clientId, state: 'dispatching', now });
    try {
      const reply = await client.probe(213, bodyHex, { withBaseRequest: true, write: true });
      const state = reply.ok !== false && reply.baseCode === 0 ? 'sent' : 'needs_review';
      let commentId = null;
      if (state === 'sent' && kind === 'comment') {
        await new Promise(resolve => setTimeout(resolve, 1500));
        commentId = await verifyComment({ client, momentId: moment.id, self,
          text: decision.comment, sentAt: Math.floor(now / 1000) });
        if (!commentId) ledger.trace('moments.comment_verify_missing', { momentId: moment.id, actionKey });
      }
      ledger.updateAction(actionKey, { state, commentId, receipt: reply.ok === false
        ? { error: reply.detail ?? 'probe_failed' }
        : { cgi: 213, baseCode: reply.baseCode, replyBytes: reply.replyBytes }, now });
      ledger.markActed(moment.id, { state, actedAt: now, clientId, commentId });
      if (state === 'sent') ledger.incrementToday(kind, now);
      lastActionAt = now;
      summary.actions.push({ momentId: moment.id, kind, state, clientId, commentId, actionKey });
    } catch (error) {
      ledger.updateAction(actionKey, { state: 'needs_review',
        receipt: { error: error.name }, now });
      ledger.markActed(moment.id, { state: 'needs_review', actedAt: now, clientId });
      summary.actions.push({ momentId: moment.id, kind, state: 'needs_review', error: error.name });
    }
  }
  return summary;
}
