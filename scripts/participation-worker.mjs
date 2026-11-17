import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { WeChatClient } from '../packages/wechat-adapter/client.mjs';
import { sendImageWithStandard } from '../packages/wechat-adapter/send-image.mjs';
import { listStickerCandidates, sendSticker, stickerSendKey } from '../packages/wechat-adapter/sticker-send.mjs';
import { generateSelfie, generatePicture } from '../packages/selfie/index.mjs';
import { openIntimacyStore } from '../packages/intimacy/index.mjs';
import { listGroupTopics, searchTrends } from '../packages/trends/index.mjs';
import { parseGroupAllowlist, selectOnlineAccount } from '../packages/wechat-adapter/real-config.mjs';
import { ParticipationLedger, runParticipationCycle, selectConversationContext } from '../packages/participation/index.mjs';
import { runProactiveCycle } from '../packages/participation/proactive.mjs';
import { deriveMemberInterests, interestsFromFacts, mergeInterests }
  from '../packages/participation/interests.mjs';
import { createAgentParticipationModel } from '../packages/participation/model.mjs';
import { createBehaviorModel, applyInteractionPreferences, containsBlockedName } from '../packages/participation/behavior-model.mjs';
import { InteractionPreferenceStore } from '../packages/people/interaction-preferences.mjs';
import { LearnedSlangStore, collectLearnedSlang } from '../packages/participation/learned-slang.mjs';
import { createParticipationTools } from '../packages/participation/tools.mjs';
import { runtimeMomentsExperience, createParticipationMomentsContext } from '../packages/participation/moments-context.mjs';
import { openMem0 } from '../packages/memory/index.mjs';
import { createConversationMemoryContext } from '../packages/participation/memory-context.mjs';
import { readCoreFacts, readDiaryState, readInbox, searchDiary } from '../packages/diary/index.mjs';
import { contactDirectory, groupRoster, loadPeopleConfig, memberProfile,
  selectRelatedMemberIds,
  readMemberActivity } from '../packages/people/index.mjs';
import { readObservationProfiles } from '../packages/people/observations.mjs';
import { LifeEventStore } from '../packages/life-events/index.mjs';
import { SubscriptionStore } from '../packages/subscriptions/index.mjs';
import { SocialContextStore, collectSocialContext } from '../packages/social-context/index.mjs';
import { collectLifeEvents, runSocialInitiative } from '../packages/social-runtime/initiatives.mjs';
import { readMomentObservations } from '../packages/moments/person-memory.mjs';
import { quoteReferenceFromInbox } from '../packages/wechat-adapter/quote-send.mjs';
import { sendParticipationVoice, reconcileVoiceReplies } from '../packages/voice/participation.mjs';
import { voiceSourceRevision } from '../packages/voice/source-revision.mjs';
import { MemberTracker, runMemberWelcome } from '../packages/members/index.mjs';
import { createArticleReader } from '../packages/shared-media/article.mjs';
import { createImageRecallService } from '../packages/image-recall/index.mjs';
import { PatSender } from '../packages/wechat-adapter/pat-send.mjs';
import { configureLocalMemory } from './local-memory-env.mjs';
import { projectRoot } from './runtime.mjs';

const execFile = promisify(execFileCallback);
const env = process.env;
const groups = parseGroupAllowlist(env.SOCIOMEM_WECHAT_GROUPS);
if (groups.length !== 1) throw new Error('Participation worker requires exactly one authorized group');
const groupId = groups[0];
const sendSetting = env.SOCIOMEM_PARTICIPATION_SEND ?? '0';
if (!['0', '1'].includes(sendSetting)) throw new Error('SOCIOMEM_PARTICIPATION_SEND must be 0 or 1');
const sendEnabled = sendSetting === '1';
const stickerSendSetting = env.SOCIOMEM_STICKER_SEND ?? '0';
if (!['0', '1'].includes(stickerSendSetting)) throw new Error('SOCIOMEM_STICKER_SEND must be 0 or 1');
const stickerShadow = stickerSendSetting !== '1';
const selfieSendSetting = env.SOCIOMEM_SELFIE_SEND ?? '0';
if (!['0', '1'].includes(selfieSendSetting)) throw new Error('SOCIOMEM_SELFIE_SEND must be 0 or 1');
const selfieEnabled = selfieSendSetting === '1';
const voiceEnabled = env.SOCIOMEM_VOICE_SEND !== '0';
configureLocalMemory();
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--once')) throw new Error('Only --once is accepted');
const once = args.includes('--once');
const pollMs = Number(env.SOCIOMEM_PARTICIPATION_POLL_MS ?? 10000);
if (!Number.isSafeInteger(pollMs) || pollMs < 1000) throw new Error('Invalid participation poll interval');
const baseModel = createAgentParticipationModel();
const dataDir = env.SOCIOMEM_WECHAT_DATA_DIR ?? join(projectRoot, '.runtime', 'agent-wechat');
const cliPath = env.SOCIOMEM_WECHAT_CLI ?? join(projectRoot, '.tools', 'agent-wechat', 'v1.3.2', 'wx.exe');
const tokenPath = env.SOCIOMEM_WECHAT_TOKEN_FILE ?? join(dataDir, 'api-token');
const result = await execFile(cliPath, ['--json', '--data-dir', dataDir, 'accounts', 'list'],
  { encoding: 'utf8', windowsHide: true });
const account = selectOnlineAccount(JSON.parse(result.stdout).items, {
  accountId: env.SOCIOMEM_WECHAT_ACCOUNT_ID, alias: env.SOCIOMEM_WECHAT_ALIAS,
});
const token = readFileSync(tokenPath, 'utf8').trim();
if (!token || /[\r\n]/u.test(token)) throw new Error('Local WeChat API token is invalid');
const sourcePath = env.SOCIOMEM_WECHAT_DB ?? join(projectRoot, '.runtime', 'wechat-adapter', 'sociomem.sqlite');
const ledgerPath = env.SOCIOMEM_PARTICIPATION_DB ?? join(projectRoot, '.runtime', 'participation', 'participation.sqlite');
const diaryPath = join(env.SOCIOMEM_DIARY_ROOT ?? join(projectRoot, '.runtime', 'diary'), 'diary.sqlite');
const memoryRoot = env.SOCIOMEM_MEMORY_ROOT ?? join(projectRoot, '.runtime', 'memory');
if (sourcePath === ledgerPath) throw new Error('Participation ledger must be separate from capture Inbox');
const store = new AdapterStore(ledgerPath, account.accountId);
const ledger = new ParticipationLedger(store);
const lifeEvents = new LifeEventStore(env.SOCIOMEM_LIFE_EVENTS_DB ?? join(projectRoot, '.runtime/life-events/life-events.sqlite'));
const subscriptions = new SubscriptionStore(env.SOCIOMEM_SUBSCRIPTIONS_DB ?? join(projectRoot, '.runtime/subscriptions/subscriptions.sqlite'));
const socialMemory = new SocialContextStore(env.SOCIOMEM_SOCIAL_CONTEXT_DB ?? join(projectRoot, '.runtime/social-context/social-context.sqlite'));
const momentMemoryPath = env.SOCIOMEM_MOMENT_MEMORY_DB ?? join(projectRoot, '.runtime/moments/person-memory.sqlite');
const intimacyStore = openIntimacyStore();
const client = new WeChatClient({ baseUrl: env.SOCIOMEM_WECHAT_BASE_URL ?? 'http://127.0.0.1:6174',
  token, accountId: account.accountId });
const adapter = new WeChatAdapter({ client, store, allowedGroups: [groupId], selfUserId: account.selfUserId,
  sendingEnabled: sendEnabled, cooldownMs: 15000 });
const memberTracker = new MemberTracker(ledger.db, { accountId: account.accountId, groupId, selfUserId: account.selfUserId });
const imageRecall = createImageRecallService({ ledger, adapter, client, inboxPath: sourcePath,
  imageDir: env.SOCIOMEM_IMAGE_CACHE ?? join(projectRoot, '.runtime/images') });
const aliases = (env.SOCIOMEM_AGENT_ALIASES ?? '肥鱼不肥,肥鱼,SocioMem,agent,机器人')
  .split(',').map(value => value.trim()).filter(Boolean);
const preferenceStore = new InteractionPreferenceStore(join(projectRoot, '.runtime/participation/interaction-preferences.sqlite'));
const learnedSlang = new LearnedSlangStore(join(projectRoot, '.runtime/participation/learned-slang.sqlite'));
const behaviorScope = { accountId: account.accountId, groupId, inboxPath: sourcePath, selfUserId: account.selfUserId };
const collectPreferences = () => preferenceStore.collect({ ...behaviorScope, agentAliases: aliases });
collectPreferences();
const preferencesFor = (userId, refresh = true) => userId
  ? preferenceStore.effective({ ...behaviorScope, userId, refresh }) : {};
const preferredProfile = options => applyInteractionPreferences(memberProfile(options), preferencesFor(options.userId, false));
const momentsContext = createParticipationMomentsContext({
  reader: runtimeMomentsExperience({ root: projectRoot, accountId: account.accountId,
    selfId: account.selfUserId, env, onError: detail => ledger.store.trace('moments.experience_error', detail) }),
  selfId: account.selfUserId, getMemberIds: () => [...roster.keys()],
  onError: detail => ledger.store.trace('moments.context_error', detail) });
const guardedModel = createBehaviorModel({ model: input => baseModel(momentsContext.enrich(input)),
  lookupPreferences: userId => preferencesFor(userId, false),
  createSlangAnnotator: () => {
    try { return learnedSlang.createAnnotator({ scope: { accountId: account.accountId, groupId }, inboxPath: sourcePath, blockedTerms: slangBlockedTerms() }); }
    catch (error) { log('learned_slang_read_error', { errorType: error.name }); return () => []; }
  },
  onViolation: detail => ledger.store.trace('participation.behavior_rejected', detail) });
// Every speaking route passes this boundary, including welcomes, followups and
// proactive topics. Ordinary replies carry a marker after their evidence lookup.
const model = async input => guardedModel(await memoryContext.enrich(input));
const { names: curatedNames, snapshots: identitySnapshots } = loadPeopleConfig(
  env.SOCIOMEM_PEOPLE_CONFIG ?? join(projectRoot, '.runtime', 'people', 'group-people.json'),
  account.accountId, groupId);
let roster = new Map();
let contacts = new Map();
function slangBlockedTerms() {
  return [...new Set([...aliases, ...roster.values(), ...[...curatedNames.values()].flat(),
    ...[...contacts.values()].flatMap(person => [person.wechatNickname, person.wechatAccount])].filter(Boolean))];
}
const patSender = new PatSender({ db: ledger.db, inboxPath: sourcePath, client, selfUserId: account.selfUserId,
  authorize: ({ targetUserId }) => !preferencesFor(targetUserId).patDisabled,
  allowedGroups: [groupId], getMemberIds: async () => {
    if (Date.now() - rosterCheckedAt > 60000) await refreshRoster();
    return [...roster.keys()];
  } });
const patCapability = env.SOCIOMEM_PAT_SEND === '1' ? await patSender.capability(AbortSignal.timeout(10000)) : { available: false };
const sendPat = patCapability.available ? async ({ target, groupId, signal }) => patSender.send({
  groupId, targetUserId: target.senderId, sourceId: target.id, kind: target.interaction === 'pat' ? 'reply' : 'proactive', signal }) : null;
let rosterCheckedAt = 0;
const intimacyFor = userId => {
  try { return intimacyStore.get(account.accountId, groupId, userId); }
  catch { return null; }
};
async function refreshRoster() {
  const items = [];
  let cursor = null;
  for (let page = 0; page < 10; page++) {
    const args = ['--json', '--data-dir', dataDir, 'groups', 'members', 'list', groupId, '--limit', '200'];
    if (cursor) args.push('--cursor', cursor);
    const result = await execFile(cliPath, args, { encoding: 'utf8', windowsHide: true });
    const response = JSON.parse(result.stdout);
    items.push(...response.items);
    cursor = response.nextCursor;
    if (!cursor) {
      const nextRoster = groupRoster(items);
      const contactItems = [];
      let contactCursor = null;
      for (let contactPage = 0; contactPage < 10; contactPage++) {
        const contactArgs = ['--json', '--data-dir', dataDir, 'contacts', 'list', '--limit', '200'];
        if (contactCursor) contactArgs.push('--cursor', contactCursor);
        const found = JSON.parse((await execFile(cliPath, contactArgs,
          { encoding: 'utf8', windowsHide: true })).stdout);
        contactItems.push(...found.items);
        contactCursor = found.nextCursor;
        if (!contactCursor) {
          roster = nextRoster;
          contacts = contactDirectory(contactItems);
          memberTracker.observe({ roster, contacts, complete: true });
          intimacyStore.ensureMembers(account.accountId, groupId, [...nextRoster.keys()]);
          rosterCheckedAt = Date.now();
          return;
        }
      }
      throw new Error('Contact directory pagination exceeded limit');
    }
  }
  throw new Error('Group roster pagination exceeded limit');
}
const abort = new AbortController();
process.once('SIGINT', () => abort.abort());
process.once('SIGTERM', () => abort.abort());
const log = (kind, details = {}) => console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...details }));
let failures = 0;
let memoryPromise;
const diaryCache = new Map();
const useTool = createParticipationTools({ accountId: account.accountId, groupId, inboxPath: sourcePath,
  diaryPath, momentsContext,
  articleReader: createArticleReader({ cacheDir: join(projectRoot, '.runtime/shared-articles') }), imageRecall,
  openMemory: () => memoryPromise ??= openMem0() });
let stickerDb = null;
try {
  stickerDb = new DatabaseSync(sourcePath);
  stickerDb.exec('PRAGMA busy_timeout=5000');
} catch (error) { log('sticker_db_unavailable', { errorType: error.name }); }
const stickerCandidates = () => {
  if (!stickerDb) return [];
  try { return listStickerCandidates(stickerDb, { groupId, limit: 30 }); }
  catch (error) { log('sticker_candidates_error', { errorType: error.name }); return []; }
};
const sendStickers = stickerDb ? async ({ task, stickers }) => {
  const results = [];
  for (const choice of stickers) {
    const key = stickerSendKey(account.accountId, groupId, task.source_id,
      choice.sourceId, choice.stickerId);
    try {
      results.push(await sendSticker({ db: stickerDb, client, account, groupId,
        stickerId: choice.stickerId, key, signal: AbortSignal.timeout(30000) }));
    } catch (error) {
      results.push({ stickerId: choice.stickerId, key, state: 'needs_review',
        errorType: error.name });
    }
  }
  return { results,
    sent: results.filter(item => item.state === 'sent').length,
    pending: results.filter(item => item.state === 'pending_receipt').length,
    failed: results.filter(item => !['sent', 'pending_receipt'].includes(item.state)).length };
} : null;
if (stickerDb) {
  stickerDb.exec(`CREATE TABLE IF NOT EXISTS selfie_sends (
    key TEXT PRIMARY KEY, task_id TEXT NOT NULL, group_id TEXT NOT NULL, scene TEXT NOT NULL,
    path TEXT, sha256 TEXT, state TEXT NOT NULL, receipt TEXT, created_at INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'selfie')`);
  try { stickerDb.exec("ALTER TABLE selfie_sends ADD COLUMN kind TEXT NOT NULL DEFAULT 'selfie'"); }
  catch { /* column already exists */ }
}
function runCli(args) {
  return new Promise((resolve, reject) => {
    execFile(cliPath, args, { encoding: 'utf8', windowsHide: true, timeout: 180000 },
      (error, stdout) => {
        try { resolve(JSON.parse(stdout)); } catch { reject(error ?? new Error('Invalid CLI output')); }
      });
  });
}
const sendGenerated = selfieEnabled && stickerDb ? async ({ kind, description, generate,
  task, groupId }) => {
  const key = createHash('sha256').update(JSON.stringify(['image', kind, account.accountId,
    groupId, task.source_id, description])).digest('hex');
  const existing = stickerDb.prepare('SELECT state FROM selfie_sends WHERE key=?').get(key);
  if (existing && ['sent', 'pending_receipt', 'needs_review'].includes(existing.state)) {
    return { state: existing.state, key, skipped: true };
  }
  const record = (state, generated, receipt, errorType = null) => {
    stickerDb.prepare(`INSERT OR REPLACE INTO selfie_sends
      (key,task_id,group_id,scene,path,sha256,state,receipt,created_at,kind)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(key, task.source_id, groupId, description, generated?.path ?? null,
        generated?.sha256 ?? null, state, receipt ? JSON.stringify(receipt) : null, Date.now(), kind);
    if (errorType) log('image_failed', { key, kind, errorType });
  };
  let generated;
  try { generated = await generate(); }
  catch (error) { record('needs_review', null, null, error.name); return { state: 'needs_review', key }; }
  try {
    const payload = await sendImageWithStandard(client, { threadId: groupId,
      imagePath: generated.path, key });
    const receipt = payload?.result?.nativeReceipt ?? null;
    const completed = payload?.state === 'completed' || payload?.phase === 'completed';
    const state = completed && receipt && receipt.serviceCode === 0
      ? 'sent' : 'needs_review';
    record(state, generated, receipt, state === 'sent' ? null : 'unexpected_receipt');
    return { state, key, path: generated.path, receipt };
  } catch (error) {
    record('needs_review', generated, null, error.name);
    return { state: 'needs_review', key, path: generated.path };
  }
} : null;
const sendSelfie = sendGenerated ? async ({ task, groupId, selfie }) =>
  sendGenerated({ kind: 'selfie', description: selfie.scene, task, groupId,
    generate: () => generateSelfie({ scene: selfie.scene }) }) : null;
const sendImage = sendGenerated ? async ({ task, groupId, image }) =>
  sendGenerated({ kind: 'image', description: image.prompt, task, groupId,
    generate: () => generatePicture({ prompt: image.prompt }) }) : null;
const sendVoice = voiceEnabled ? async args => {
  const recipientId = args.recipientId ?? args.target.senderId;
  if (preferencesFor(recipientId).voiceDisabled) return { state: 'skipped', safeToFallback: true, reason: 'member_voice_disabled' };
  const revision = () => voiceSourceRevision(stickerDb, account.accountId, groupId);
  const baseline = revision();
  const sourceIds = JSON.parse(args.task.source_ids_json);
  const originals = sourceIds.map(id => ({ id, raw: stickerDb?.prepare('SELECT message FROM inbox WHERE id=?').get(id)?.message }));
  const authorize = async () => {
    if (preferencesFor(recipientId).voiceDisabled || containsBlockedName(args.text, preferencesFor(recipientId)) ||
        (args.authorizeText && !args.authorizeText())) return false;
    if (!sendEnabled || !voiceEnabled || revision() !== baseline) return false;
    for (const original of originals) {
      if (!original.raw || stickerDb.prepare('SELECT message FROM inbox WHERE id=?').get(original.id)?.message !== original.raw) return false;
      const local = JSON.parse(original.raw), source = await client.message(original.id, args.signal);
      if (local.accountId !== account.accountId || local.groupId !== groupId || source.id !== original.id ||
          source.accountId !== account.accountId || source.threadId !== groupId || source.senderId !== local.userId ||
          source.serverId !== local.serverId || source.recall || source.recalled || source.deleted ||
          (local.interaction === 'text' && source.body !== local.text)) return false;
    }
    return revision() === baseline && !preferencesFor(recipientId).voiceDisabled && !containsBlockedName(args.text, preferencesFor(recipientId)) &&
      (!args.authorizeText || args.authorizeText());
  };
  const result = await sendParticipationVoice({ ledger, adapter, client, ...args, authorize });
  if (result.safeToFallback && !await authorize().catch(() => false)) return { ...result, state: 'needs_review', safeToFallback: false };
  return result;
} : null;
let voiceReconciledAt = 0;
const trendPath = env.SOCIOMEM_TRENDS_DB ?? join(projectRoot, '.runtime', 'trends', 'trends.sqlite');
let trendDb = null;
try {
  if (existsSync(trendPath)) {
    trendDb = new DatabaseSync(trendPath, { readOnly: true });
    trendDb.exec('PRAGMA busy_timeout=5000');
  }
} catch (error) { log('trend_db_unavailable', { errorType: error.name }); }
const lookupTrends = trendDb ? (target, context) => searchTrends(trendDb, {
  query: target.text, context: context.slice(-4).map(item => item.text), limit: 3,
}) : null;
const listTopicCandidates = () => {
  if (!trendDb) return [];
  try { return listGroupTopics(trendDb, { days: 7, limit: 6 }); }
  catch (error) { log('trend_topics_error', { errorType: error.name }); return []; }
};
const observationsFor = userId => {
  try {
    const items = readObservationProfiles(diaryPath, { accountId: account.accountId, groupId, userIds: [userId], limitPerPerson: 6, inboxPath: sourcePath });
    const moments = readMomentObservations(momentMemoryPath, { accountId: account.accountId, subjectId: userId, limit: 2 });
    return [...items.slice(0, 6 - moments.length), ...moments];
  } catch (error) { log('member_observations_error', { errorType: error.name }); return []; }
};
const lookupMemberProfile = userId => ({ ...preferredProfile({ userId, roster, contacts,
  curatedNames, snapshots: identitySnapshots,
  coreFacts: readCoreFacts(memoryRoot, account.accountId, groupId), observations: observationsFor(userId),
  activity: readMemberActivity(sourcePath, account.accountId, groupId, userId),
  intimacy: intimacyFor(userId) }), membership: memberTracker.identity(userId) });
const lookupMemberIdentity = userId => {
  const { displayName, preferredNames } = preferredProfile({ userId, roster, contacts,
    curatedNames, snapshots: identitySnapshots });
  return { displayName, preferredNames };
};
const lookupLatestDiary = () => {
  const latest = readDiaryState(diaryPath, account.accountId, groupId).latest;
  return latest && { title: latest.title, summary: latest.summary, endAt: latest.end_at };
};
const lookupRelatedProfiles = (target, context, relevantDiary) => {
  const relatedText = relevantDiary.map(item => `${item.title} ${item.text}`).join(' ');
  const ids = selectRelatedMemberIds({ target, context, roster, contacts, curatedNames, relatedText });
  const diarySpeakers = relevantDiary.flatMap(item => item.events ?? [])
    .flatMap(event => event.sourceSpeakerIds ?? []).filter(userId => roster.has(userId));
  const mentionedIds = (target.mentions?.userIds ?? []).filter(userId => roster.has(userId));
  return [...new Set([...mentionedIds, ...ids, ...diarySpeakers])]
    .filter(userId => userId !== target.senderId && userId !== account.selfUserId)
    .slice(0, 8).map(lookupMemberProfile);
};
const lookupDiary = async (target, context) => {
  const query = [...context.slice(-6).map(item => item.text), target.text].join(' ').slice(-500).trim();
  if (query.length < 3) return [];
  // A newly written diary invalidates a cached query immediately.
  const revision = readDiaryState(diaryPath, account.accountId, groupId).lastRowid;
  const key = JSON.stringify([revision, query]);
  const prior = diaryCache.get(key);
  if (prior && Date.now() - prior.at < 10 * 60000) return prior.items;
  const matches = await searchDiary(await (memoryPromise ??= openMem0()), {
    accountId: account.accountId, groupId, query, limit: 5, diaryPath, inboxPath: sourcePath });
  const items = matches.filter(item => item.score === null || item.score >= 0.30)
    .map(item => ({ id: item.id, title: item.title, text: item.text.slice(0, 2400),
      events: item.events, sourceMessageIds: item.sourceMessageIds,
      startAt: item.startAt, endAt: item.endAt, score: item.score }));
  if (diaryCache.size > 100) diaryCache.clear();
  diaryCache.set(key, { at: Date.now(), items });
  return items;
};
const memoryContext = createConversationMemoryContext({ accountId: account.accountId, groupId,
  getMemberIds: () => [...roster.keys()].filter(id => id !== account.selfUserId),
  lookupContext: input => selectConversationContext(
    readInbox(sourcePath, { accountId: account.accountId, groupId, recent: true, limit: 999 }),
    input.now ?? (Date.parse(input.currentTime?.utc) || Date.now()))
    .map(item => ({ ...item, speaker: lookupMemberIdentity(item.senderId) })),
  lookupProfile: lookupMemberProfile, lookupRelatedProfiles, lookupDiary, lookupLatestDiary,
  lookupConsolidatedThroughRowid: () => readDiaryState(diaryPath, account.accountId, groupId).consolidatedThroughRowid ?? 0,
  onError: detail => ledger.store.trace('participation.memory_context_error', detail),
  onLoaded: detail => ledger.store.trace('participation.memory_context_loaded', detail) });
const knownSocialMembers = () => [...roster.keys()].filter(userId => userId !== account.selfUserId)
  .map(userId => {
    const profile = preferredProfile({ userId, roster, contacts, curatedNames, snapshots: identitySnapshots });
    return { userId, displayName: profile.displayName, preferredNames: profile.preferredNames ?? [],
      wechatName: profile.wechatNickname, groupName: profile.groupNickname };
  });
let interestCache = { at: 0, map: new Map() };
const memberInterestMap = facts => {
  const now = Date.now();
  if (now - interestCache.at < 30 * 60000) return interestCache.map;
  try {
    const derived = deriveMemberInterests({ inboxPath: sourcePath, accountId: account.accountId,
      groupId, now });
    const map = new Map();
    for (const userId of roster.keys()) {
      const merged = mergeInterests(derived.get(userId) ?? [],
        interestsFromFacts(facts.filter(fact => fact.subjectId === userId)));
      if (merged.length) map.set(userId, merged);
    }
    interestCache = { at: now, map };
  } catch (error) { log('member_interests_error', { errorType: error.name }); }
  return interestCache.map;
};
try {
  try { await refreshRoster(); }
  catch (error) { log('member_roster_error', { errorType: error.name }); }
  log('ready', { accountId: account.accountId, groupId, sendEnabled, stickerShadow, selfieEnabled, voiceEnabled,
    patEnabled: Boolean(sendPat), imageRecallEnabled: true, memberRecognition: true,
    interactionPreferences: true, learnedSlang: true, gameParticipation: false,
    sourcePath, ledgerPath, modelProvider: env.SOCIOMEM_PARTICIPATION_PROVIDER ?? 'ollama' });
  while (!abort.signal.aborted) {
    try {
      collectPreferences();
      if (Date.now() - rosterCheckedAt > 10 * 60000) {
        try { await refreshRoster(); }
        catch (error) { rosterCheckedAt = Date.now();
          log('member_roster_error', { errorType: error.name }); }
      }
      try { collectLearnedSlang({ store: learnedSlang, ...behaviorScope, blockedTerms: slangBlockedTerms() }); }
      catch (error) { log('learned_slang_collect_error', { errorType: error.name }); }
      collectLifeEvents({ events: lifeEvents, ledger, inboxPath: sourcePath, accountId: account.accountId, groupId });
      try {
        collectSocialContext({ store: socialMemory, inboxPath: sourcePath,
          accountId: account.accountId, groupId, knownMembers: knownSocialMembers() });
      } catch (error) { log('social_context_collect_error', { errorType: error.name }); }
      if (Date.now() - voiceReconciledAt > 60000) {
        try { await reconcileVoiceReplies({ ledger, adapter, client, groupId, signal: AbortSignal.timeout(30000) }); }
        catch (error) { log('voice_reconcile_error', { errorType: error.name }); }
        try { await imageRecall.reconcile({ groupId, signal: AbortSignal.timeout(30000) }); }
        catch (error) { log('image_recall_reconcile_error', { errorType: error.name }); }
        try {
          for (const receipt of await patSender.reconcilePending({ limit: 5, signal: AbortSignal.timeout(30000) })) {
            const prior = ledger.store.sendRecord(receipt.key);
            if (receipt.state !== 'accepted' || JSON.parse(prior?.receipt ?? 'null')?.channel !== 'pat') continue;
            ledger.store.receipt(receipt.key, 'accepted', { ...receipt, channel: 'pat' });
            for (const pending of ledger.db.prepare("SELECT source_id FROM participation_tasks WHERE group_id=? AND outbox_key=? AND state='needs_review'").all(groupId, receipt.key)) {
              ledger.transition(pending.source_id, 'sent', 'pat_receipt_confirmed', receipt.key);
              ledger.settleTask(pending.source_id, 'resolved', Date.now());
            }
          }
        }
        catch (error) { log('pat_reconcile_error', { errorType: error.name }); }
        voiceReconciledAt = Date.now();
      }
      const outcome = await runParticipationCycle({ ledger, adapter, model, inboxPath: sourcePath,
        enrichModelInput: input => momentsContext.enrich(memoryContext.markLoaded(input)),
        lookupInteractionPreferences: preferencesFor,
        accountId: account.accountId, groupId, sendEnabled, aliases, useTool,
        stickerCandidates: stickerCandidates(), sendStickers, stickerShadow, lookupTrends,
        sendSelfie, sendImage, sendVoice, sendPat, sendRecalledImage: args => imageRecall.send(args),
        lookupLifeEvents: () => lifeEvents.list({ accountId: account.accountId, groupId, limit: 12 }),
        recordLifeEvents: (proposals, messages) => lifeEvents.ingest({ accountId: account.accountId, groupId, messages, proposals, extract: false }),
        lookupSocialContext: (target, context) => {
          const knownMembers = knownSocialMembers();
          const found = socialMemory.context({ accountId: account.accountId, groupId,
            userIds: [...new Set([target.senderId, ...context.slice(-12).map(item => item.senderId)])],
            query: target.text.slice(0, 200), inboxPath: sourcePath, knownMembers, limit: 8 });
          const ids = new Set([...found.activities.flatMap(item => [item.organizerId, ...item.participants.map(p => p.userId)]),
            ...found.relationships.flatMap(item => item.userIds)]);
          return { ...found, members: knownMembers.filter(member => ids.has(member.userId)) };
        },
        recordSocialUpdates: (proposals, messages) => socialMemory.applyProposals({ accountId: account.accountId,
          groupId, messages, knownMembers: knownSocialMembers(), proposals }),
        resolveQuote: messageId => quoteReferenceFromInbox({ db: stickerDb, accountId: account.accountId, groupId, messageId }),
        latestDiary: lookupLatestDiary(),
        lookupMemberProfile, lookupMemberIdentity, lookupRelatedProfiles, lookupDiary });
      if (outcome.status !== 'waiting') log('participation', { status: outcome.status,
        sourceId: outcome.sourceId, kind: outcome.kind, key: outcome.key,
        stickers: outcome.stickers, selfie: outcome.selfie, image: outcome.image, voice: outcome.voice });
      const routineId = env.SOCIOMEM_ROUTINE_MEMBER_ID || null;
      const welcome = await runMemberWelcome({ tracker: memberTracker, ledger, adapter, model,
        inboxPath: sourcePath, accountId: account.accountId, groupId, sendEnabled,
        lookupIdentity: userId => preferredProfile({ userId, roster, contacts, curatedNames, snapshots: identitySnapshots }) });
      if (welcome.status !== 'waiting') log('member_welcome', welcome);
      const social = await runSocialInitiative({ events: lifeEvents, subscriptions, ledger, adapter, model,
        inboxPath: sourcePath, accountId: account.accountId, groupId, sendEnabled,
        lookupIdentity: userId => preferredProfile({ userId, roster, contacts, curatedNames, snapshots: identitySnapshots }) });
      if (social.status !== 'waiting') log('social_initiative', social);
      const proactive = await runProactiveCycle({ ledger, adapter, model, inboxPath: sourcePath,
        lookupInteractionPreferences: preferencesFor,
        accountId: account.accountId, groupId, sendEnabled,
        lookupIdentity: senderId => {
          const { displayName, preferredNames } = preferredProfile({ userId: senderId, roster, contacts,
            curatedNames, snapshots: identitySnapshots });
          return { displayName, preferredNames };
        },
        routineMember: routineId ? preferredProfile({ userId: routineId, roster, contacts,
          curatedNames, snapshots: identitySnapshots, observations: observationsFor(routineId), intimacy: intimacyFor(routineId) }) : null,
        memberCandidates: [...roster.keys()].filter(userId => userId !== account.selfUserId)
          .map(userId => preferredProfile({ userId, roster, contacts,
            curatedNames, snapshots: identitySnapshots, observations: observationsFor(userId), intimacy: intimacyFor(userId) })),
        trendTopics: listTopicCandidates(),
        memberInterests: memberInterestMap(readCoreFacts(memoryRoot, account.accountId, groupId)),
        latestDiary: (() => {
          const latest = readDiaryState(diaryPath, account.accountId, groupId).latest;
          return latest && { title: latest.title, summary: latest.summary, endAt: latest.end_at };
        })() });
      if (proactive.status !== 'waiting') log('proactive', { status: proactive.status,
        slot: proactive.slot, key: proactive.key });
      failures = 0;
    } catch (error) {
      failures++;
      log('participation_error', { errorType: error.name, message: error.message, failures });
      if (once || failures >= 3) { process.exitCode = 1; break; }
    }
    if (once) break;
    try { await delay(pollMs, undefined, { signal: abort.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
} finally { preferenceStore.close(); learnedSlang.close(); patSender.close(); imageRecall.close(); socialMemory.close(); lifeEvents.close(); subscriptions.close(); trendDb?.close(); stickerDb?.close(); intimacyStore.close(); store.close(); log('stopped'); }
