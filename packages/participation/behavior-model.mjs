import { gameParticipationViolation, GAME_PARTICIPATION_BOUNDARY } from './game-boundary.mjs';

export function applyInteractionPreferences(profile, preferences = {}) {
  if (!profile) return profile;
  const blocked = new Set((preferences.blockedNames ?? []).map(name => name.normalize('NFKC').toLowerCase()));
  const preferredNames = [...new Set([preferences.preferredName,
    ...(profile.preferredNames ?? [])].filter(name => name && !blocked.has(name.normalize('NFKC').toLowerCase())))];
  return { ...profile, preferredNames,
    displayName: preferences.preferredName || (!blocked.has(profile.displayName?.normalize('NFKC').toLowerCase()) ? profile.displayName : preferredNames[0] ?? null),
    interactionPreferences: { voiceDisabled: preferences.voiceDisabled === true,
      patDisabled: preferences.patDisabled === true,
      proactiveMentionDisabled: preferences.proactiveMentionDisabled === true,
      blockedNames: [...(preferences.blockedNames ?? [])], preferredName: preferences.preferredName ?? null } };
}

export function containsBlockedName(text, preferences = {}) {
  return typeof text === 'string' && (preferences.blockedNames ?? []).some(name => name &&
    text.normalize('NFKC').toLowerCase().includes(name.normalize('NFKC').toLowerCase()));
}

// One bounded correction, only after a violated host constraint. No extra request
// on ordinary turns, no tools/actions from a rejected proposal, no canned reply.
export function createBehaviorModel({ model, lookupPreferences = () => ({}),
  createSlangAnnotator = () => () => [], onViolation = () => {} }) {
  return async input => {
    const ids = [...new Set([input.target?.senderId, input.personProfile?.userId,
      ...(input.relatedProfiles ?? []).map(p => p.userId),
      ...(input.initiative?.mentionCandidates ?? []).map(p => p.userId),
      ...(input.socialContext?.members ?? []).map(p => p.userId),
      ...(input.context ?? []).map(item => item.senderId)].filter(Boolean))];
    const prefs = new Map(ids.map(id => [id, lookupPreferences(id)]));
    const profile = (p, fallbackId) => applyInteractionPreferences(p, prefs.get(p?.userId ?? fallbackId));
    const prepared = { ...input,
      personProfile: profile(input.personProfile, input.target?.senderId),
      relatedProfiles: (input.relatedProfiles ?? []).map(p => profile(p)),
      context: (input.context ?? []).map(item => ({ ...item, speaker: profile(item.speaker, item.senderId) })),
      ...(input.socialContext ? { socialContext: { ...input.socialContext,
        members: (input.socialContext.members ?? []).map(p => profile(p)) } } : {}),
      ...(input.initiative ? { initiative: { ...input.initiative,
        ...(input.initiative.mentionCandidates ? { mentionCandidates: input.initiative.mentionCandidates
          .filter(p => !prefs.get(p.userId)?.proactiveMentionDisabled)
          .map(p => { const updated = profile({ ...p, displayName: p.name }); return { ...updated, name: updated.displayName }; }) } : {}) } } : {}),
      learnedSlangAnnotator: createSlangAnnotator() };
    let correction = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const decision = await model({ ...prepared, behaviorCorrection: correction });
      if (!decision || typeof decision.reply !== 'string') return decision;
      const game = gameParticipationViolation(decision.reply, { contextText: input.target?.text ?? '' });
      // Consider only people involved in this prompt, never the global roster.
      const name = ids.some(id => containsBlockedName(decision.reply, lookupPreferences(id)));
      if (!game && !name) return decision;
      const reason = game ? 'cannot_play_games' : 'blocked_member_name';
      onViolation({ reason, attempt: attempt + 1, sourceId: input.target?.id });
      correction = game ? GAME_PARTICIPATION_BOUNDARY
        : '刚才草稿使用了在场群友明确拒绝的称呼。改用其当前允许的称呼或省略称呼；不要复述被禁用的昵称。';
    }
    return { shouldReply: false, reply: '', reason: 'host_behavior_constraint', confidence: 1 };
  };
}
