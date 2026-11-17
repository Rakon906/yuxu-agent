import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createParticipationMomentsContext, publicMomentsContext, filterMomentsForActors } from '../packages/participation/moments-context.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
import { createParticipationTools, validateToolRequest } from '../packages/participation/tools.mjs';

const selfId = 'wxid_self_private', friendId = 'wxid_friend_private';
const own = { id: 'SNS_own', momentId: '11', sourceType: 'self_moment', action: 'published',
  authorId: selfId, subjectId: selfId, text: '昨天发过一碗热汤面。', state: 'verified', publishedVisibility: 'friends',
  at: '2026-11-14T10:00:00Z', evidence: [{ speakerId: selfId, id: 'SNS_own', quote: '昨天发过一碗热汤面。' }] };
const input = { target: { id: 'msg1', senderId: friendId, text: '这是你自己发的吗？', sourceIds: ['msg1'] },
  context: [{ id: 'image1', senderId: friendId, text: '[朋友圈截图]', interaction: 'image', at: '2026-11-15T10:00:00Z',
    imageSha256: 'a'.repeat(64), imageVisibleText: '肥鱼不肥 昨天发过一碗热汤面。', imageDescriptionCorrection: {
      kind: 'ocr_transcription', method: 'local_image_inspection', imageSha256: 'a'.repeat(64),
      correctedVisibleTextSha256: createHash('sha256').update('肥鱼不肥 昨天发过一碗热汤面。').digest('hex') } }],
  coreFacts: [], latestDiary: null };

test('default context supplies own publication and limits friends to current host members', () => {
  const calls = [];
  const helper = createParticipationMomentsContext({ selfId, getMemberIds: () => [friendId],
    reader: { search: req => { calls.push(req); return { matches: [own,
      { ...own, id: 'SNS_private', publishedVisibility: 'private' }], coverage: { complete: false } }; } } });
  const enriched = helper.enrich({ ...input, relatedProfiles: [{ userId: 'other_group_person' }] });
  assert.deepEqual(calls[0].subjectIds, [friendId]);
  assert.deepEqual(enriched.momentsContext.matches.map(m => m.id), ['SNS_own']);
  assert.equal(enriched.self.userId, selfId);
  const prompt = JSON.parse(participationMessages(enriched)[1].content);
  assert.equal(prompt.self.name, '肥鱼不肥');
  assert.equal(prompt.momentsContext.matches[0].authorKey, 'AGENT');
  assert.notEqual(prompt.conversation[0].speakerKey, 'AGENT');
  assert.equal(prompt.conversation[0].image.correction.source, 'host_visual_review');
  assert.equal(prompt.conversation[0].image.visibleText, input.context[0].imageVisibleText);
  assert.equal(JSON.stringify(prompt).includes(selfId), false);
  assert.equal(JSON.stringify(prompt).includes(friendId), false);
  assert.equal(helper.enrich(enriched).momentsContext, enriched.momentsContext);
});

test('Moments tools are host scoped and callable without opening vector memory', async () => {
  const calls = [];
  const context = createParticipationMomentsContext({ selfId, getMemberIds: () => [friendId],
    reader: { search: req => { calls.push(req); return { matches: [own], coverage: {} }; } } });
  const tools = createParticipationTools({ accountId: 'account', groupId: 'group@chatroom', inboxPath: 'unused',
    openMemory: () => assert.fail('No embedding needed'), momentsContext: context });
  const result = await tools({ name: 'moments_search', query: '汤面', who: 'self' }, input);
  assert.equal(result.matches[0].action, 'published');
  assert.deepEqual(calls[0].subjectIds, []);
  await tools({ name: 'moments_search', query: '', who: 'involved' }, input);
  assert.equal(calls[1].includeSelf, false);
  assert.deepEqual(calls[1].subjectIds, [friendId]);
  assert.throws(() => validateToolRequest({ name: 'moments_search', query: '', accountId: 'other' }));
  assert.throws(() => validateToolRequest({ name: 'moments_search', query: '', subjectIds: ['other'] }));
  assert.throws(() => validateToolRequest({ name: 'moments_search', query: '', who: 'anyone' }));
});

test('all nested author and recipient IDs are serialized consistently, not leaked or reassigned to forwarder', () => {
  const result = publicMomentsContext({ matches: [{ ...own, authorId: friendId, subjectId: friendId,
    actorRole: 'self', replyToId: selfId, momentAuthorId: friendId,
    evidence: [{ id: 'proof', speakerId: friendId, quote: '原评论' }] }] }, selfId);
  const match = result.matches[0];
  assert.equal(match.actorRole, 'friend');
  assert.equal(match.replyToKey, 'AGENT');
  assert.equal(match.authorKey, match.subjectKey);
  assert.equal(match.authorKey, match.momentAuthorKey);
  assert.equal(match.authorKey, match.evidence[0].speakerKey);
  assert.ok(!JSON.stringify(result).includes('wxid_'));
});

test('two maximum Moments tool results fit the DeepSeek memory and input budgets', () => {
  const matches = Array.from({ length: 8 }, (_, i) => ({ ...own, id: `SNS_${i}`,
    text: '面'.repeat(600), evidence: [{ id: `SNS_${i}`, speakerId: selfId, quote: '面'.repeat(600) }] }));
  const messages = participationMessages({ ...input, self: { userId: selfId }, momentsContext: { matches },
    toolResults: [{ name: 'moments_search', matches }, { name: 'moments_search', matches }] }, 24000, 16000, 8000);
  const payload = JSON.parse(messages[1].content);
  assert.ok(Math.ceil(Buffer.byteLength(JSON.stringify(messages)) / 2) <= 24000);
  assert.ok(payload.toolResults.every(result => result.matches.length >= 1));
  assert.ok(payload.toolResults.some(result => result.coverage.promptBudgetTrimmed));
  assert.ok(!JSON.stringify(payload).includes('wxid_'));
});

test('read failure reports incomplete knowledge instead of asserting no past publication', () => {
  let errors = 0;
  const helper = createParticipationMomentsContext({ selfId, reader: { search() { throw new Error('broken'); } },
    onError: () => errors++ });
  const result = helper.enrich(input);
  assert.equal(errors, 1);
  assert.equal(result.momentsContext.coverage.unavailable, true);
  assert.equal(result.momentsContext.coverage.complete, false);
  assert.equal(result.self.name, '肥鱼不肥');
});

test('past own replies concerning unrelated friends are not exposed to a group', () => {
  const helper = createParticipationMomentsContext({ selfId, getMemberIds: () => [friendId], reader: {
    search: () => ({ matches: [own, { ...own, id: 'SNS_unrelated', sourceType: 'self_moment_reply',
      publishedVisibility: 'unknown', replyToId: 'outside', momentAuthorId: 'outside' }], coverage: {} }) } });
  assert.deepEqual(helper.enrich(input).momentsContext.matches.map(m => m.id), ['SNS_own']);
  assert.deepEqual(helper.search({ who: 'self', query: '' }, input).matches.map(m => m.id), ['SNS_own']);
});

test('chat and Moments share one actor filter, including the author of the commented post', () => {
  const items = [own,
    { ...own, id: 'ok', sourceType: 'self_moment_reply', replyToId: friendId, momentAuthorId: selfId },
    { ...own, id: 'bad', sourceType: 'self_moment_reply', replyToId: friendId, momentAuthorId: 'unrelated' },
    { ...own, id: 'peer-bad', authorId: friendId, sourceType: 'friend_moment_comment', replyToId: selfId, momentAuthorId: 'unrelated' },
    { ...own, id: 'peer-ok', authorId: friendId, sourceType: 'friend_moment_comment', replyToId: selfId, momentAuthorId: friendId }];
  assert.deepEqual(filterMomentsForActors({ matches: items }, selfId, [friendId]).matches.map(m => m.id),
    ['SNS_own', 'ok', 'peer-ok']);
});

test('image review markers require matching bytes and OCR, including verified cache reuse', () => {
  const original = input.context[0];
  const publicCorrection = item => JSON.parse(participationMessages({ ...input, context: [item] })[1].content)
    .conversation[0].image.correction;
  assert.equal(publicCorrection({ ...original, imageSha256: 'b'.repeat(64) }), null);
  assert.equal(publicCorrection({ ...original, imageVisibleText: 'different OCR' }), null);
  const cached = { ...original, imageDescriptionCorrection: undefined, imageDescriptionProvenance: {
    verification: 'local_image_inspection', correctionId: 'test', imageSha256: original.imageSha256,
    visibleTextSha256: original.imageDescriptionCorrection.correctedVisibleTextSha256 } };
  assert.equal(publicCorrection(cached).verified, true);
  assert.equal(publicCorrection({ ...cached, imageVisibleText: 'different OCR' }), null);
});
