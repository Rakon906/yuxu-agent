import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MomentsPublishStore } from '../packages/moments/publish-service.mjs';
import { CommentReplyStore } from '../packages/moments/comment-reply-service.mjs';
import { MomentPersonMemory } from '../packages/moments/person-memory.mjs';
import { createMomentsExperienceReader } from '../packages/moments/experience.mjs';

const accountId = 'test-account', selfId = 'wxid-self', friendId = 'wxid-friend';
const now = Date.parse('2026-11-15T10:00:00Z');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'moments-experience-'));
  const publishPath = join(dir, 'publish.sqlite'), momentMemoryPath = join(dir, 'friends.sqlite');
  const commentReplyPath = join(dir, 'replies.sqlite');
  const publications = new MomentsPublishStore(publishPath, { now: () => now - 3600000 });
  const friends = new MomentPersonMemory(momentMemoryPath);
  const replies = new CommentReplyStore(commentReplyPath, { accountId, selfId, now: () => now - 1800000 });
  t.after(() => {
    for (const store of [publications, friends, replies]) store.close();
    assert.ok(resolve(dir).startsWith(resolve(tmpdir(), 'moments-experience-')));
    rmSync(dir, { recursive: true, force: true });
  });
  const paths = { publishPath, momentMemoryPath, commentReplyPath };
  const reader = createMomentsExperienceReader({ accountId, selfId, ...paths });
  const publish = ({ key = 'post', momentId = '100', text = '先喝口热奶茶再说', state = 'verified',
    account = accountId, self = selfId, visibility = 'friends', proof = null } = {}) => {
    const draft = publications.draft({ key, accountId: account, selfUserId: self, text, visibility });
    if (state !== 'draft') {
      publications.claim(key, draft.digest);
      publications.update(key, { state, momentId, verification: proof ?? { verified: state === 'verified', momentId } });
    }
    return draft;
  };
  const observe = ({ momentId = '200', text = '我朋友说：她想去青岛旅游', authorId = friendId,
    checkedAt = now - 3600000, publishedAt = checkedAt - 3600000, account = accountId } = {}) => {
    const moment = { id: momentId, author: { id: authorId }, text, createTime: publishedAt / 1000 };
    friends.record({ accountId: account, moment, now: checkedAt });
    return moment;
  };
  const reply = ({ text = '奶茶先放一边，来聊两句', state = 'verified', proof = {}, momentId = '100' } = {}) => {
    const source = { commentId: '300', userId: friendId, text: '好像看见你的奶茶了',
      createTime: now / 1000 - 2000 };
    const moment = { id: momentId, author: { id: selfId }, text: '先喝口热奶茶再说', comments: [source] };
    const draft = replies.prepare({ moment, comment: source, text });
    if (state !== 'draft') {
      replies.claim(draft.key, draft.digest, ['300']);
      replies.update(draft.key, { state, verification: { verified: state === 'verified',
        commentId: '301', momentId, sourceCommentId: source.commentId, authorId: selfId,
        replyTo: friendId, text, ...proof } });
    }
    return draft;
  };
  return { dir, ...paths, publications, friends, replies, publish, observe, reply, reader,
    search: input => reader.search({ now, ...input }) };
}

test('verified publication is self history with stable evidence and exact source identity', t => {
  const f = fixture(t);
  f.publish();
  const first = f.search({ query: '奶茶' }).matches;
  assert.equal(first.length, 1);
  assert.equal(first[0].actorRole, 'self');
  assert.equal(first[0].authorId, selfId);
  assert.equal(first[0].sourceType, 'self_moment');
  assert.equal(first[0].publishedVisibility, 'friends');
  assert.equal(first[0].availability, 'verified_historical_publication');
  assert.equal(first[0].evidence[0].id, first[0].id);
  assert.equal(first[0].evidence[0].quote, first[0].text);
  assert.deepEqual(first[0].matchReason, ['text_query']);
  assert.equal(f.search({ momentIds: ['100'], query: 'unrelated' }).matches[0].id, first[0].id);
  assert.deepEqual(f.search({ includeSelf: false }).matches, []);
  assert.equal(f.search().coverage.currentVisibilityVerified, false);
});

test('failed, draft, wrong-account, wrong-self, corrupt and inconsistent publications are excluded', t => {
  const f = fixture(t);
  f.publish({ key: 'draft', momentId: '101', state: 'draft' });
  f.publish({ key: 'failed', momentId: '102', state: 'needs_review' });
  f.publish({ key: 'accepted', momentId: '103', state: 'accepted' });
  f.publish({ key: 'other-account', momentId: '104', account: 'another-account' });
  f.publish({ key: 'other-self', momentId: '105', self: 'another-self' });
  f.publish({ key: 'bad-proof', momentId: '106', proof: { verified: true, momentId: '999' } });
  f.publish({ key: 'corrupt', momentId: '107' });
  const corrupt = JSON.parse(f.publications.db.prepare('SELECT draft_json FROM publications WHERE key=?').get('corrupt').draft_json);
  f.publications.db.prepare('UPDATE publications SET draft_json=? WHERE key=?').run(JSON.stringify({ ...corrupt, text: '篡改正文' }), 'corrupt');
  f.publish({ key: 'good', momentId: '108' });
  assert.deepEqual(f.search().matches.map(row => row.momentId), ['108']);
});

test('friend history needs host-selected authors and keeps old verification without claiming current visibility', t => {
  const f = fixture(t);
  f.observe({ checkedAt: now - 5 * 86400000 });
  assert.deepEqual(f.search().matches, []);
  const result = f.search({ subjectIds: [friendId], query: '青岛' });
  assert.equal(result.matches.length, 1);
  const item = result.matches[0];
  assert.equal(item.sourceType, 'friend_moment');
  assert.equal(item.authorId, friendId);
  assert.equal(item.actorRole, 'friend');
  assert.equal(item.availability, 'not_recently_checked');
  assert.equal(item.publishedVisibility, 'unknown');
  assert.equal(item.attribution, 'post_author_is_reposter_original_speaker_unverified');
  assert.match(item.text, /我朋友说/);
  assert.deepEqual(f.search({ subjectIds: ['same-name-other-id'] }).matches, []);
  assert.deepEqual(f.search({ subjectIds: [friendId], momentIds: ['201'] }).matches, []);
});

test('fresh source is observed, withdrawn/deleted/unavailable or tampered sources never reappear', t => {
  const f = fixture(t);
  f.observe({ momentId: '201', text: '今天回天津了' });
  f.observe({ momentId: '202', text: '准备去青岛' });
  f.observe({ momentId: '203', text: '已经回家' });
  f.observe({ momentId: '204', text: '以后去旅行' });
  f.observe({ momentId: '205', text: '没有撤回' });
  f.observe({ momentId: '206', account: 'another-account' });
  for (const [id, state] of [['202', 'withdrawn'], ['203', 'deleted'], ['204', 'unavailable']]) {
    f.friends.db.prepare('UPDATE moments_sources SET state=? WHERE moment_id=?').run(state, id);
  }
  f.friends.db.prepare('UPDATE moments_sources SET text=? WHERE moment_id=?').run('伪造正文', '205');
  const matches = f.search({ subjectIds: [friendId], includeSelf: false }).matches;
  assert.deepEqual(matches.map(row => row.momentId), ['201']);
  assert.equal(matches[0].availability, 'recently_checked');
});

test('verified comment reply is bound to the actual self and source comment, not its quoted author', t => {
  const f = fixture(t);
  f.reply();
  const [item] = f.search({ query: '奶茶' }).matches;
  assert.equal(item.sourceType, 'self_moment_reply');
  assert.equal(item.authorId, selfId);
  assert.equal(item.replyToId, friendId);
  assert.equal(item.sourceCommentId, '300');
  assert.equal(item.commentId, '301');
  assert.equal(item.momentAuthorId, selfId);
  assert.equal(item.evidence[0].speakerId, selfId);
  assert.equal(item.text, '奶茶先放一边，来聊两句');
  assert.equal(JSON.stringify(item).includes('好像看见你的奶茶了'), false);
  assert.equal(item.availability, 'verified_historical_reply');
});

test('unverified, inconsistent and corrupt reply receipts cannot become self history', t => {
  const f = fixture(t);
  const draft = f.reply({ proof: { authorId: 'imposter' } });
  assert.deepEqual(f.search().matches, []);
  f.replies.db.prepare('UPDATE comment_reply_jobs SET verification_json=? WHERE key=?')
    .run(JSON.stringify({ verified: true, commentId: '300' }), draft.key);
  assert.deepEqual(f.search().matches, []);
  f.replies.db.prepare('UPDATE comment_reply_jobs SET verification_json=?,state=? WHERE key=?')
    .run(JSON.stringify({ verified: true, commentId: '301' }), 'needs_review', draft.key);
  assert.deepEqual(f.search().matches, []);
  f.replies.db.prepare('UPDATE comment_reply_jobs SET state=?,digest=? WHERE key=?').run('verified', '0'.repeat(64), draft.key);
  assert.deepEqual(f.search().matches, []);
});

test('peer comments require a verified immutable reply snapshot and a host-selected author', t => {
  const f = fixture(t);
  const draft = f.reply();
  assert.deepEqual(f.search({ includeSelf: false }).matches, []);
  assert.deepEqual(f.search({ includeSelf: false, subjectIds: ['another-friend'] }).matches, []);
  const [item] = f.search({ includeSelf: false, subjectIds: [friendId] }).matches;
  assert.equal(item.sourceType, 'friend_moment_comment');
  assert.equal(item.action, 'commented');
  assert.equal(item.authorId, friendId);
  assert.equal(item.momentAuthorId, selfId);
  assert.equal(item.commentId, '300');
  assert.equal(item.evidence[0].speakerId, friendId);
  assert.equal(item.text, '好像看见你的奶茶了');
  assert.equal(item.availability, 'verified_historical_comment_snapshot');
  const saved = JSON.parse(f.replies.db.prepare('SELECT draft_json FROM comment_reply_jobs WHERE key=?').get(draft.key).draft_json);
  saved.comment.text = '伪造第三方的评论';
  f.replies.db.prepare('UPDATE comment_reply_jobs SET draft_json=? WHERE key=?').run(JSON.stringify(saved), draft.key);
  assert.deepEqual(f.search({ includeSelf: false, subjectIds: [friendId] }).matches, []);
});

test('wrong reply ledger identity fails closed while independent sources remain usable', t => {
  const f = fixture(t);
  f.publish(); f.reply();
  f.replies.db.prepare("UPDATE comment_reply_meta SET value=? WHERE key='identity'")
    .run(JSON.stringify({ accountId: 'other', selfId }));
  const errors = [];
  const reader = createMomentsExperienceReader({ accountId, selfId, publishPath: f.publishPath,
    commentReplyPath: f.commentReplyPath, onError: error => errors.push(error) });
  const result = reader.search({ now });
  assert.equal(result.matches.length, 1);
  assert.equal(result.matches[0].sourceType, 'self_moment');
  assert.equal(result.coverage.sources.comment_replies, 'unavailable');
  assert.deepEqual(errors, [{ source: 'comment_replies', errorType: 'Error' }]);
});

test('text similarity retrieves candidates without confirming a screenshot author or account name', t => {
  const f = fixture(t);
  f.publish({ text: '先喝口热奶茶再说' });
  f.observe({ momentId: '200', text: '先喝口热奶茶再说' });
  const result = f.search({ query: '截图：肥鱼不瘦，先喝口热奶茶再说', subjectIds: [friendId] });
  assert.equal(result.matches.length, 2);
  assert.deepEqual(new Set(result.matches.map(row => row.actorRole)), new Set(['self', 'friend']));
  assert.ok(result.matches.every(row => row.attribution === 'source_author_only_not_forwarder_or_image_identity'));
  assert.equal(result.coverage.identityMatch, 'text_similarity_is_not_screenshot_or_forwarder_identity');
  assert.equal(JSON.stringify(result.matches).includes('肥鱼不瘦'), false);
});

test('bounded snippets preserve private visibility and reject widened or invalid scope', t => {
  const f = fixture(t);
  for (let i = 0; i < 23; i++) f.publish({ key: `post-${i}`, momentId: String(1000 + i),
    text: `${'奶茶'.repeat(400)}${i}`, visibility: i === 0 ? 'private' : 'friends' });
  const result = f.search({ limit: 20 });
  assert.equal(result.matches.length, 20);
  assert.equal(result.coverage.truncated, true);
  assert.ok(result.matches.every(row => row.text.length <= 600 && row.textTruncated));
  assert.equal(f.search({ momentIds: ['1000'] }).matches[0].publishedVisibility, 'private');
  for (const input of [{ limit: 21 }, { momentIds: ['not-an-id'] }, { subjectIds: ['bad id'] },
    { includeSelf: 1 }, { query: 'x'.repeat(2001) }, { now: NaN }]) assert.throws(() => f.search(input));
});

test('reader does not change ledger bytes, create owner files, or create absent databases', t => {
  const f = fixture(t);
  f.publish(); f.observe(); f.reply();
  // DELETE mode makes a byte-for-byte no-write assertion independent of SQLite WAL coordination.
  for (const store of [f.publications, f.friends, f.replies]) store.db.exec('PRAGMA journal_mode=DELETE');
  const snapshot = () => Object.fromEntries(readdirSync(f.dir).map(name => [name,
    createHash('sha256').update(readFileSync(join(f.dir, name))).digest('hex')]));
  const before = snapshot();
  f.search({ subjectIds: [friendId] }); f.search({ momentIds: ['100'] });
  assert.deepEqual(snapshot(), before);
  assert.ok(readdirSync(f.dir).every(name => !name.endsWith('.owner')));
  const missing = join(f.dir, 'missing', 'absent.sqlite');
  const result = createMomentsExperienceReader({ accountId, selfId, publishPath: missing }).search({ now });
  assert.deepEqual(result.matches, []);
  assert.equal(existsSync(join(f.dir, 'missing')), false);
  assert.equal(result.coverage.legacyActions, 'unbound_legacy_likes_and_comments_excluded');
});
