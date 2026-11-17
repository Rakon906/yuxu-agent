import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { createMomentsExperienceReader } from '../moments/experience.mjs';

export function filterMomentsForActors(result, selfId, subjectIds) {
  const involved = new Set(subjectIds);
  const actor = id => id === selfId || involved.has(id);
  return { ...result, matches: result.matches.filter(item => item.publishedVisibility !== 'private' && actor(item.authorId) &&
    (!['self_moment_reply', 'friend_moment_comment'].includes(item.sourceType) ||
      (actor(item.replyToId) && actor(item.momentAuthorId)))) };
}

export function runtimeMomentsExperience({ root, accountId, selfId, env = process.env, onError }) {
  return createMomentsExperienceReader({ accountId, selfId,
    publishPath: env.SOCIOMEM_MOMENTS_PUBLISH_LEDGER ?? env.SOCIOMEM_MOMENTS_PUBLISH_DB ?? join(root, '.runtime/moments/publish.sqlite'),
    momentMemoryPath: env.SOCIOMEM_MOMENT_MEMORY_DB ?? join(root, '.runtime/moments/person-memory.sqlite'),
    commentReplyPath: env.SOCIOMEM_MOMENTS_REPLY_DB ?? join(root, '.runtime/moments/comment-replies.sqlite'), onError });
}

// A group receives relevant historical evidence, never an unrestricted friend feed.
export function createParticipationMomentsContext({ reader, selfId, getMemberIds = () => [], onError = () => {} }) {
  const self = { userId: selfId, name: '肥鱼不肥', nickname: '肥鱼' };
  const subjects = input => {
    const allowed = new Set(getMemberIds());
    return [...new Set([input.target?.senderId, ...(input.context ?? []).slice(-12).map(m => m.senderId),
      ...(input.relatedProfiles ?? []).map(p => p.userId), ...(input.target?.mentions?.userIds ?? []),
      ...(input.initiative?.mentionCandidates ?? []).map(p => p.userId)])]
      .filter(id => id !== selfId && allowed.has(id)).slice(0, 16);
  };
  const visible = (result, input) => filterMomentsForActors(result, selfId, subjects(input));
  const search = (request, input = {}) => {
    const subjectIds = request.who === 'self' ? [] : subjects(input);
    const result = visible(reader.search({ query: request.query ?? '', subjectIds,
      includeSelf: request.who !== 'involved', limit: 12, now: input.now ?? Date.now() }), input);
    return { ...result, matches: result.matches.slice(0, 8) };
  };
  return { self, search,
    enrich(input) {
      if (input.momentsContext) return { ...input, self };
      try {
        const query = [input.target?.text ?? '', ...(input.context ?? []).slice(-3).map(m => m.text ?? '')]
          .join(' ').slice(0, 500);
        const relevant = visible(reader.search({ query, subjectIds: subjects(input), limit: 6, now: input.now ?? Date.now() }), input);
        const recent = visible(reader.search({ subjectIds: [], limit: 8, now: input.now ?? Date.now() }), input);
        const ownPosts = recent.matches.filter(item => item.sourceType === 'self_moment').slice(0, 3);
        const matches = [...new Map([...ownPosts, ...relevant.matches, ...recent.matches.slice(0, 2)]
          .map(item => [item.id, item])).values()].slice(0, 8);
        return { ...input, self, momentsContext: { matches, coverage: relevant.coverage } };
      } catch (error) {
        onError({ errorType: error.name });
        return { ...input, self, momentsContext: { matches: [], coverage: { complete: false, unavailable: true } } };
      }
    } };
}

export function publicMomentsContext(context, selfId) {
  const key = id => !id ? null : id === selfId ? 'AGENT'
    : `M_${createHash('sha256').update(id).digest('base64url').slice(0, 12)}`;
  return { matches: (context?.matches ?? []).slice(0, 12).map(item => ({
    id: item.id, momentId: item.momentId, sourceType: item.sourceType,
    action: item.action, actorRole: item.authorId === selfId ? 'self' : 'friend',
    authorKey: key(item.authorId), subjectKey: key(item.subjectId),
    replyToKey: key(item.replyToId), momentAuthorKey: key(item.momentAuthorId),
    commentId: item.commentId, sourceCommentId: item.sourceCommentId,
    text: String(item.text ?? '').slice(0, 600), at: item.at, verifiedAt: item.verifiedAt,
    availability: item.availability, publishedVisibility: item.publishedVisibility,
    state: item.state, matchReason: item.matchReason, attribution: item.attribution,
    evidence: (item.evidence ?? []).slice(0, 3).map(e => ({ id: e.id,
      sourceMomentId: e.sourceMomentId, speakerKey: key(e.speakerId), at: e.at,
      ...(e.quote !== item.text ? { quote: e.quote?.slice(0, 600) } : {}) })) })),
    coverage: context?.coverage ?? { complete: false } };
}
