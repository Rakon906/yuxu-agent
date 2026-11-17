import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { localDeepSeekKey } from '../diary/model.mjs';
import { appendDeepSeekUsage, operationDigest, recordDeepSeekRequest } from '../telemetry/deepseek-usage.mjs';
import { createOllamaJsonModel } from '../model/ollama.mjs';
import { createAnthropicJsonModel } from '../model/anthropic.mjs';
import { createSlangAnnotator } from './slang.mjs';
import { publicSocialContext } from '../social-runtime/context.mjs';
import { publicMomentsContext } from './moments-context.mjs';

const skillUrl = new URL('../../skills/group-participation/SKILL.md', import.meta.url);
const estimateInputTokens = messages => Math.ceil(Buffer.byteLength(JSON.stringify(messages), 'utf8') / 2);
const annotateSlang = createSlangAnnotator();
function publicImage(item) {
  const sha = item.imageSha256, visibleText = item.imageVisibleText;
  const correction = item.imageDescriptionCorrection, provenance = item.imageDescriptionProvenance;
  const bound = sha && /^[a-f0-9]{64}$/u.test(sha) && typeof visibleText === 'string';
  const textHash = bound ? createHash('sha256').update(visibleText).digest('hex') : null;
  const reviewed = bound && ((correction?.kind === 'ocr_transcription' && correction.method === 'local_image_inspection' &&
    correction.imageSha256 === sha && correction.correctedVisibleTextSha256 === textHash) ||
    (provenance?.verification === 'local_image_inspection' && provenance.correctionId &&
      provenance.imageSha256 === sha && provenance.visibleTextSha256 === textHash));
  return { contentId: sha, visibleText: visibleText?.slice(0, 2000),
    correction: reviewed ? { verified: true, source: 'host_visual_review' } : null };
}

export function participationMessages({ target, context, kind, mustReply, currentTime = null, previousAgentMessage = null,
  coreFacts, latestDiary, relevantDiary = [], recentAgentReplies = [],
  recentAgentMessages = [], toolResults = [], remainingToolCalls = 2, openTasks = [],
  personProfile = null, relatedProfiles = [], initiative = null, stickers = [], trendContext = [], futureEvents = [], socialContext = {}, actions = {},
  learnedSlangAnnotator = () => [], behaviorCorrection = null, self = null, momentsContext = null },
  maxInputTokensEstimate = 200000, maxChatTokensEstimate = 120000,
  maxMemoryTokensEstimate = 80000) {
  const firstAt = Math.min(...context.map(item => Date.parse(item.at)).filter(Number.isFinite));
  // The same WeChat ID must keep the same model-visible key across requests.
  // Short hashed keys avoid sending raw account IDs to the API fallback.
  const speakerKey = userId => userId && userId === self?.userId ? 'AGENT' : typeof userId === 'string' && userId
    ? `M_${createHash('sha256').update(userId).digest('base64url').slice(0, 12)}` : null;
  const publicDiaryEvent = ({ sourceSpeakerIds, quoteSpeakerIds, ...event }) => ({ ...event,
    sourceSpeakerKeys: [...new Set((sourceSpeakerIds ?? []).map(speakerKey).filter(Boolean))],
    quoteSpeakerKeys: [...new Set((quoteSpeakerIds ?? []).map(speakerKey).filter(Boolean))] });
  const publicDiaryEntry = entry => ({ ...entry,
    events: entry.events?.map(publicDiaryEvent) });
  const publicMentions = mentions => ({ self: mentions?.self === true,
    speakerKeys: [...new Set((mentions?.userIds ?? []).map(speakerKey).filter(Boolean))] });
  const publicQuote = quote => !quote ? null : { speakerKey: speakerKey(quote.senderId),
    text: typeof quote.text === 'string' ? quote.text.slice(0, 500) : null,
    type: quote.type ?? null, sticker: quote.sticker === true, image: quote.image === true };
  const learnedDefinitions = new Map();
  let learnedDefinitionChars = 0;
  const publicInterpretations = text => {
    const fixed = annotateSlang(text);
    const learnedSlangRefs = [];
    for (const item of learnedSlangAnnotator(text)) {
      if (fixed.some(known => known.surface === item.surface)) continue;
      const key = `${item.surface}\u0000${item.intended}`;
      if (!learnedDefinitions.has(key)) {
        const cost = JSON.stringify(item).length;
        if (learnedDefinitions.size >= 24 || learnedDefinitionChars + cost > 12000) continue;
        learnedDefinitions.set(key, { ...item, ref: `slang-${learnedDefinitions.size + 1}` });
        learnedDefinitionChars += cost;
      }
      learnedSlangRefs.push(learnedDefinitions.get(key).ref);
    }
    return { ...(fixed.length ? { interpretations: fixed.slice(0, 6) } : {}),
      ...(learnedSlangRefs.length ? { learnedSlangRefs } : {}) };
  };
  const targetInterpretations = publicInterpretations(target.text);
  // Newer context gets first use of the small dictionary budget.
  for (const item of [...context].reverse()) publicInterpretations(item.text);
  const publicObservation = ({ subjectId, evidence = [], ...observation }) => ({ ...observation,
    speakerKey: speakerKey(subjectId),
    evidence: evidence.map(({ speakerId, ...item }) => ({ ...item, speakerKey: speakerKey(speakerId) })) });
  const publicPerson = ({ userId, observations, ...profile }, fallbackId = null) => ({ ...profile,
    speakerKey: speakerKey(userId ?? fallbackId),
    ...(Array.isArray(observations) ? { observations: observations.map(publicObservation) } : {}) });
  const publicProfile = personProfile && publicPerson(personProfile, target.senderId);
  const publicFacts = coreFacts.slice(0, 20).map(({ subjectId, ...fact }) => ({ ...fact,
    ...(subjectId ? { speakerKey: speakerKey(subjectId) } : {}) }));
  const publicToolResults = toolResults.map(result => result.name === 'moments_search'
    ? { name: result.name, error: result.error, ...publicMomentsContext(result, self?.userId) } : ({ ...result,
    images: result.images?.map(({ senderId, ...item }) => ({ ...item, speakerKey: speakerKey(senderId) })),
    messages: result.messages?.map(({ senderId, quote, ...message }) => ({ ...message,
      speakerKey: speakerKey(senderId), ...(quote ? { replyTo: publicQuote(quote) } : {}) })),
    matches: result.matches?.map(({ subjectId, ...match }) => ({ ...publicDiaryEntry(match),
      ...(subjectId ? { speakerKey: speakerKey(subjectId) } : {}) })) }));
  const conversation = [
    ...context.map(item => ({ id: item.id, role: 'group_member',
      speakerKey: speakerKey(item.senderId),
      name: item.speaker?.displayName ?? null,
      preferredNames: item.speaker?.preferredNames ?? [],
      text: item.text.slice(0, item.interaction === 'forwarded' ? 12000 : 2000), at: item.at,
      ...(item.text.length > (item.interaction === 'forwarded' ? 12000 : 2000) ? { textTruncated: true } : {}),
      mentions: publicMentions(item.mentions), interaction: item.interaction ?? 'text',
      ...(item.interaction === 'image' ? { image: publicImage(item) } : {}),
      replyTo: publicQuote(item.quote), ...publicInterpretations(item.text) })),
    ...recentAgentMessages.filter(item => Number.isFinite(firstAt) &&
      Date.parse(item.at) >= firstAt - 120000).map(item => ({ role: 'agent',
      speakerKey: 'AGENT', name: '肥鱼', text: item.text.slice(0, 500), at: item.at,
      mentions: { speakerKeys: [...new Set((item.mentionUserIds ?? []).map(speakerKey)
        .filter(Boolean))] } })),
  ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const diary = relevantDiary.slice(0, 8).map(publicDiaryEntry);
  const people = relatedProfiles.slice(0, 12).map(profile => publicPerson(profile));
  const social = publicSocialContext(socialContext);
  const moments = publicMomentsContext(momentsContext, self?.userId);
  const snsResults = publicToolResults.filter(result => result.name === 'moments_search');
  while (estimateInputTokens(snsResults) > maxMemoryTokensEstimate * 0.35) {
    const longest = snsResults.filter(result => result.matches.length > 1)
      .sort((a, b) => b.matches.length - a.matches.length)[0];
    if (!longest) break;
    longest.matches.pop();
    longest.coverage = { ...longest.coverage, truncated: true, promptBudgetTrimmed: true };
  }
  const memorySize = () => estimateInputTokens({ personProfile: publicProfile,
    relatedProfiles: people, coreFacts: publicFacts, latestDiary,
    relevantDiary: diary, toolResults: publicToolResults, socialContext: social, momentsContext: moments });
  while (memorySize() > maxMemoryTokensEstimate && (moments.matches.length || diary.length || people.length || social.activities.length || social.relationships.length || social.members.length)) {
    if (diary.length) diary.pop();
    else if (people.length) people.pop();
    else if (social.activities.length) social.activities.pop();
    else if (social.relationships.length) social.relationships.pop();
    else if (social.members.length) social.members.pop();
    else moments.matches.pop();
  }
  if (memorySize() > maxMemoryTokensEstimate) {
    throw new Error('Participation memory exceeds input budget');
  }
  const system = { role: 'system', content: readFileSync(skillUrl, 'utf8') };
  const makeMessages = start => [system,
    { role: 'user', content: JSON.stringify({ target: {
      id: target.id, speakerKey: speakerKey(target.senderId),
      name: personProfile?.displayName ?? null,
      preferredNames: personProfile?.preferredNames ?? [], text: target.text.slice(0, 2000),
      at: target.at, mentions: publicMentions(target.mentions),
      interaction: target.interaction ?? 'text',
      ...(target.interaction === 'image' ? { image: publicImage(target) } : {}),
      replyTo: publicQuote(target.quote), ...targetInterpretations,
      sourceIds: target.sourceIds }, kind, mustReply,
    currentTime, previousAgentMessage, personProfile: publicProfile, initiative, socialContext: social,
    self: { speakerKey: 'AGENT', name: '肥鱼不肥', nickname: '肥鱼' }, momentsContext: moments,
    behaviorCorrection,
    learnedSlangDefinitions: [...learnedDefinitions.values()].filter(item =>
      new Set([...(targetInterpretations.learnedSlangRefs ?? []),
        ...conversation.slice(start).flatMap(turn => turn.learnedSlangRefs ?? [])]).has(item.ref)),
    actions: { pat: actions.pat === true, imageRecall: actions.imageRecall === true },
    futureEvents: futureEvents.slice(0, 12).map(({ subjectId, ...item }) => ({ ...item, speakerKey: speakerKey(subjectId) })),
    stickers: stickers.slice(0, 30).map(item => ({ stickerId: item.stickerId,
      context: item.context, summary: item.summary, visibleText: item.visibleText,
      tone: item.tone, occurrences: item.occurrences })),
    trendContext: trendContext.slice(0, 3).map(item => ({ title: String(item.title ?? '').slice(0, 120),
      summary: String(item.summary ?? '').slice(0, 240), category: item.category ?? '其他',
      source: item.source ?? null, lastSeenAt: item.lastSeenAt ?? null })),
    conversation: conversation.slice(start),
    coreFacts: publicFacts, latestDiary, relevantDiary: diary,
    relatedProfiles: people,
    recentAgentReplies: recentAgentReplies.slice(0, 6), toolResults: publicToolResults,
    remainingToolCalls, openTasks: openTasks.slice(0, 3) }) },
  ];
  // The provider's whole-input ceiling can be tighter than the memory ceiling.
  // Trim new SNS material before rejecting a prompt that no chat trimming can fit.
  while (estimateInputTokens(makeMessages(conversation.length)) > maxInputTokensEstimate) {
    if (moments.matches.length) { moments.matches.pop(); moments.coverage = { ...moments.coverage, promptBudgetTrimmed: true }; }
    else {
      const longest = snsResults.filter(result => result.matches.length > 1)
        .sort((a, b) => b.matches.length - a.matches.length)[0];
      if (!longest) break;
      longest.matches.pop();
      longest.coverage = { ...longest.coverage, truncated: true, promptBudgetTrimmed: true };
    }
  }
  const fit = (first, measure, limit) => {
    if (measure(first) <= limit) return first;
    let low = first + 1;
    let high = conversation.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (measure(middle) <= limit) high = middle;
      else low = middle + 1;
    }
    return low;
  };
  let start = fit(0, index => estimateInputTokens(conversation.slice(index)),
    maxChatTokensEstimate);
  start = fit(start, index => estimateInputTokens(makeMessages(index)), maxInputTokensEstimate);
  const messages = makeMessages(start);
  if (estimateInputTokens(messages) > maxInputTokensEstimate) {
    throw new Error('Participation prompt exceeds input budget without conversation history');
  }
  return messages;
}

export function createParticipationModel({ apiKey = localDeepSeekKey(),
  model = process.env.SOCIOMEM_PARTICIPATION_MODEL ?? 'deepseek-flash',
  baseURL = process.env.SOCIOMEM_DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
  fetchImpl = fetch, onUsage = appendDeepSeekUsage } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || /[\r\n]/u.test(apiKey.trim())) {
    throw new Error('DEEPSEEK_API_KEY is required for group participation');
  }
  const secret = apiKey.trim();
  const endpoint = new URL('chat/completions', `${baseURL.replace(/\/$/u, '')}/`);
  return async input => {
    const { target } = input;
    const messages = participationMessages(input, 24000, 16000, 8000);
    const operationId = operationDigest(['participation', target.id]);
    for (const [index, maxTokens] of [1600, 3200].entries()) {
      const started = performance.now();
      let response, payload, errorName = null;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
          body: JSON.stringify({ model, temperature: 0.4, thinking: { type: 'disabled' },
            max_tokens: maxTokens,
            response_format: { type: 'json_object' }, messages }),
          signal: AbortSignal.timeout(60000),
        });
        if (!response.ok) throw new Error(`DeepSeek participation request failed: HTTP ${response.status}`);
        payload = await response.json();
        const choice = payload.choices?.[0];
        if (choice?.finish_reason === 'length' && maxTokens === 1600) continue;
        if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string') {
          throw new Error(`DeepSeek participation response incomplete: ${choice?.finish_reason ?? 'missing'}`);
        }
        try { return JSON.parse(choice.message.content); }
        catch { throw new Error('DeepSeek participation response is not valid JSON'); }
      } catch (error) { errorName = error.name; throw error; }
      finally { recordDeepSeekRequest({ component: 'participation', operationId, attempt: index + 1,
        modelRequested: model, response, payload, elapsedMs: performance.now() - started, errorName, onUsage }); }
    }
  };
}

export function createAgentParticipationModel({ provider = process.env.SOCIOMEM_PARTICIPATION_PROVIDER ?? 'ollama',
  fallback = process.env.SOCIOMEM_MODEL_FALLBACK ?? 'deepseek',
  ollama = createOllamaJsonModel(), anthropic = null } = {}) {
  if (!['ollama', 'deepseek', 'anthropic'].includes(provider)) throw new Error('Invalid participation provider');
  if (!['deepseek', 'none'].includes(fallback)) throw new Error('Invalid model fallback');
  if (provider === 'deepseek') return createParticipationModel();
  const model = provider === 'anthropic' ? anthropic ?? createAnthropicJsonModel() : ollama;
  const label = provider === 'anthropic' ? 'Anthropic' : 'Local';
  let deepseek;
  return async input => {
    try {
      return await model({ component: 'participation', messages: participationMessages(input),
        maxTokens: 1600, temperature: 0.4, timeoutMs: 180000 });
    } catch (error) {
      if (fallback !== 'deepseek' || !localDeepSeekKey()) throw error;
      process.stderr.write(`${label} participation model failed (${error.name}); using DeepSeek fallback\n`);
      deepseek ??= createParticipationModel();
      return deepseek(input);
    }
  };
}
