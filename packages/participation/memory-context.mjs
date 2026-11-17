import { selectChatContext } from '../memory/context-policy.mjs';

// One memory boundary for ordinary replies and every autonomous speaking route.
// The marker is private host metadata, never part of a model-visible payload.
const preparedScope = Symbol('conversation-memory-scope');

export function memoryQueryTarget(input) {
  const target = input.target ?? {};
  const initiative = input.initiative ?? {};
  const clues = [initiative.event?.topic, initiative.event?.evidenceQuote,
    initiative.ignoredMention?.originalText, initiative.routine?.person,
    initiative.officialUpdate?.title, initiative.officialUpdate?.summary,
    ...(input.trendContext ?? []).slice(0, 2).map(item => item.title)]
    .filter(value => typeof value === 'string' && value.trim());
  return { ...target, text: [...clues, target.text ?? ''].join(' ').slice(-1000) };
}

export function createConversationMemoryContext({ accountId, groupId,
  getMemberIds, lookupContext = input => input.context ?? [], lookupProfile,
  lookupDiary, lookupRelatedProfiles, lookupLatestDiary,
  lookupConsolidatedThroughRowid = () => 0,
  onError = () => {}, onLoaded = () => {} }) {
  if (!accountId || !groupId || typeof getMemberIds !== 'function') {
    throw new Error('Conversation memory scope is required');
  }
  const scope = Object.freeze({ accountId, groupId });
  const compact = context => {
    try { return selectChatContext(context, { consolidatedThroughRowid: lookupConsolidatedThroughRowid() }); }
    catch (error) { onError({ part: 'context_progress', errorType: error.name }); return context; }
  };
  const safe = async (part, action, fallback) => {
    try { return await action(); }
    catch (error) { onError({ part, errorType: error.name }); return fallback; }
  };
  const markLoaded = input => {
    if (input[preparedScope] === scope) return input;
    input = { ...input, context: compact(input.context ?? []) };
    const profiles = [input.personProfile, ...(input.relatedProfiles ?? [])].filter(Boolean);
    onLoaded({ kind: input.kind, sourceId: input.target?.id,
      stage: 'selected_before_prompt_budget',
      contextMessageCount: (input.context ?? []).length,
      personProfilePresent: Boolean(input.personProfile),
      relatedProfileCount: (input.relatedProfiles ?? []).length,
      profileFactCount: profiles.reduce((count, profile) => count + (profile.facts?.length ?? 0), 0),
      profileObservationCount: profiles.reduce((count, profile) => count + (profile.observations?.length ?? 0), 0),
      diaryCount: (input.relevantDiary ?? []).length, latestDiaryPresent: Boolean(input.latestDiary) });
    return { ...input, [preparedScope]: scope };
  };
  return { markLoaded,
    async enrich(input) {
      if (input[preparedScope] === scope) return input;
      const allowed = new Set(getMemberIds());
      const target = memoryQueryTarget(input);
      const context = compact(await safe('context', () => lookupContext(input), input.context ?? []));
      const latestDiary = await safe('latest_diary', () => lookupLatestDiary(), null);
      const relevantDiary = (await safe('diary', () => lookupDiary(target, context), []))
        .filter(item => (!item.accountId || item.accountId === accountId) &&
          (!item.groupId || item.groupId === groupId)).slice(0, 5);
      const personProfile = allowed.has(target.senderId)
        ? await safe('person_profile', () => lookupProfile(target.senderId), null) : null;
      const selected = await safe('related_profiles',
        () => lookupRelatedProfiles(target, context, relevantDiary), []);
      // Explicitly involved actors (e.g. the nine o'clock routine) retain their
      // full profile. A roster of potential @ targets is not a list of actors.
      const explicit = [...(input.memorySubjectIds ?? []).slice(0, 3),
        ...(input.relatedProfiles ?? []).map(profile => profile.userId)]
        .filter(id => id !== target.senderId && allowed.has(id));
      const extra = [];
      for (const id of new Set(explicit)) {
        const profile = await safe('related_profile', () => lookupProfile(id), null);
        if (profile?.userId === id) extra.push(profile);
      }
      const relatedProfiles = [...new Map([...extra, ...selected]
        .filter(profile => profile && allowed.has(profile.userId) && profile.userId !== target.senderId)
        .map(profile => [profile.userId, profile])).values()].slice(0, 8);
      return markLoaded({ ...input, context, latestDiary, relevantDiary, relatedProfiles,
        personProfile: personProfile?.userId === target.senderId ? personProfile : null });
    },
  };
}
