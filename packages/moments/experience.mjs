import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { draftDigest } from './publish-service.mjs';
import { CommentReplyStore } from './comment-reply-service.mjs';

const SCAN_LIMIT = 500;
const MAX_TEXT = 600;
const RECENT_MS = 48 * 3600000;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identity = value => typeof value === 'string' && value.length > 0 && value.length <= 200 &&
  !/[\u0000-\u0020\u007f]/u.test(value);
const objectId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/u.test(value) && BigInt(value) <= 0xffffffffffffffffn;
const validTime = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 60000;
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const normalized = value => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const reported = text => /(?:他说|她说|转发|代发|朋友说|同事说|朋友的|同事的)|[“「]/u.test(text);
const hasTable = (db, name) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function scopeList(values, predicate, name, max = 100) {
  if (!Array.isArray(values) || values.length > max || values.some(value => !predicate(value))) throw new Error(`Invalid Moments ${name}`);
  return [...new Set(values)];
}

function textRank(text, query) {
  if (!query) return 0;
  const haystack = normalized(text), needle = normalized(query);
  if (haystack.includes(needle)) return 100 + needle.length;
  if (haystack.length >= 4 && needle.includes(haystack)) return 100 + haystack.length;
  // Keywords locate candidates only. They never prove a screenshot's identity.
  const cleaned = needle.replace(/朋友圈|自己|昨天|今天|前天|发布|发的|什么|这个|那个|记得|之前|说过|看看|图片|截图/gu, ' ');
  const parts = cleaned.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,}/gu) ?? [];
  const terms = new Set(parts.flatMap(part => /^[\u3400-\u9fff]{3,}$/u.test(part)
    ? Array.from({ length: part.length - 1 }, (_, index) => part.slice(index, index + 2)) : [part]));
  return [...terms].reduce((score, term) => score + (haystack.includes(term) ? term.length : 0), 0);
}

function evidence(accountId, { sourceType, action, actorRole, authorId, momentId, text, at,
  verifiedAt, availability, publishedVisibility = 'unknown', state, ...extra }) {
  const id = `SNS_${hash([accountId, sourceType, momentId, extra.commentId ?? null]).slice(0, 24)}`;
  const quote = text.slice(0, MAX_TEXT);
  return { id, momentId, sourceMomentId: momentId, sourceType, action, actorRole,
    authorId, subjectId: authorId, text: quote, textTruncated: text.length > MAX_TEXT,
    at: new Date(at).toISOString(), verifiedAt: new Date(verifiedAt).toISOString(),
    availability, publishedVisibility, state,
    attribution: reported(text) ? 'post_author_is_reposter_original_speaker_unverified'
      : 'source_author_only_not_forwarder_or_image_identity',
    ...extra,
    evidence: [{ id, sourceMomentId: momentId, speakerId: authorId, at: new Date(at).toISOString(), quote }],
    _text: text };
}

/** Local evidence only: no network, model, migrations, owner files or ledger writes. */
export function createMomentsExperienceReader({ accountId, selfId, publishPath = null,
  momentMemoryPath = null, commentReplyPath = null, onError = () => {} } = {}) {
  if (!identity(accountId) || !identity(selfId) || typeof onError !== 'function') throw new Error('Moments experience identity is required');
  for (const path of [publishPath, momentMemoryPath, commentReplyPath]) {
    if (path !== null && (typeof path !== 'string' || !path || path.includes('\0'))) throw new Error('Invalid Moments ledger path');
  }
  return {
    search({ query = '', momentIds = [], subjectIds = [], includeSelf = true, limit = 8, now = Date.now() } = {}) {
      if (typeof query !== 'string' || query.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(query) ||
          typeof includeSelf !== 'boolean' || !Number.isSafeInteger(limit) || limit < 1 || limit > 20 ||
          !Number.isSafeInteger(now) || now <= 0) throw new Error('Invalid Moments search');
      const ids = scopeList(momentIds, objectId, 'moment IDs', 20);
      const subjects = scopeList(subjectIds, identity, 'subjects');
      const subjectsSet = new Set(subjects.filter(id => id !== selfId));
      const matches = [], sources = {}, scanned = {};
      let truncated = false;
      const momentFilter = (column, values) => {
        if (!ids.length) return '';
        values.push(...ids);
        return ` AND ${column} IN (${ids.map(() => '?').join(',')})`;
      };
      const rowsOf = (db, sql, values, source) => {
        const rows = db.prepare(sql).all(...values, SCAN_LIMIT + 1);
        scanned[source] = Math.min(rows.length, SCAN_LIMIT);
        if (rows.length > SCAN_LIMIT) truncated = true;
        return rows.slice(0, SCAN_LIMIT);
      };
      const collect = item => {
        const score = textRank(item._text, query.trim());
        if (query.trim() && !score && !ids.includes(item.momentId)) return;
        item.matchReason = [...(ids.includes(item.momentId) ? ['exact_moment_id'] : []),
          ...(score ? ['text_query'] : []), ...(subjectsSet.has(item.authorId) ? ['subject_id'] : [])];
        if (!item.matchReason.length) item.matchReason.push('recent');
        matches.push({ ...item, _rank: score + (ids.includes(item.momentId) ? 1000 : 0) });
      };
      const read = (source, path, reader) => {
        if (!path || !existsSync(path)) { sources[source] = 'missing'; return; }
        let db;
        try {
          db = new DatabaseSync(path, { readOnly: true });
          db.exec('PRAGMA busy_timeout=3000');
          reader(db);
          sources[source] = 'read';
        } catch (error) {
          sources[source] = 'unavailable';
          onError({ source, errorType: error.name });
        } finally { db?.close(); }
      };

      if (includeSelf) read('publications', publishPath, db => {
        if (!hasTable(db, 'publications')) throw new Error('Publication schema unavailable');
        const values = [accountId];
        const filter = momentFilter('moment_id', values);
        const rows = rowsOf(db, `SELECT key,account_id,draft_json,state,attempted_at,updated_at,moment_id,verification_json
          FROM publications WHERE account_id=? AND state='verified'${filter} ORDER BY updated_at DESC,key LIMIT ?`, values, 'publications');
        for (const row of rows) {
          try {
            const draft = parse(row.draft_json), proof = parse(row.verification_json);
            if (!draft || draft.accountId !== accountId || draft.selfUserId !== selfId || draft.key !== row.key ||
                draft.digest !== draftDigest(draft) || !objectId(row.moment_id) || proof?.verified !== true ||
                proof.momentId !== row.moment_id || !validTime(row.attempted_at, now) ||
                !validTime(row.updated_at, now) || row.updated_at < row.attempted_at) continue;
            collect(evidence(accountId, { sourceType: 'self_moment', action: 'published', actorRole: 'self',
              authorId: selfId, momentId: row.moment_id, text: draft.text, at: row.attempted_at,
              verifiedAt: row.updated_at, availability: 'verified_historical_publication',
              publishedVisibility: draft.visibility, state: 'verified', timeBasis: 'verified_publication_attempt' }));
          } catch { /* Invalid draft integrity excludes this row, never adjacent valid rows. */ }
        }
      });

      if (subjectsSet.size) read('friend_sources', momentMemoryPath, db => {
        if (!hasTable(db, 'moments_sources')) throw new Error('Friend Moments schema unavailable');
        const values = [accountId, ...subjectsSet];
        const filter = momentFilter('moment_id', values);
        const rows = rowsOf(db, `SELECT * FROM moments_sources WHERE account_id=? AND state='visible'
          AND author_id IN (${[...subjectsSet].map(() => '?').join(',')})${filter}
          ORDER BY published_at DESC,moment_id LIMIT ?`, values, 'friend_sources');
        for (const row of rows) {
          if (!objectId(row.moment_id) || !subjectsSet.has(row.author_id) || typeof row.text !== 'string' ||
              !row.text.trim() || row.text.length > 10000 || !validTime(row.published_at, now) ||
              !validTime(row.checked_at, now) || row.checked_at < row.published_at - 60000 ||
              row.digest !== hash([row.author_id, row.text, row.published_at])) continue;
          collect(evidence(accountId, { sourceType: 'friend_moment', action: 'observed', actorRole: 'friend',
            authorId: row.author_id, momentId: row.moment_id, text: row.text, at: row.published_at,
            verifiedAt: row.checked_at, availability: now - row.checked_at <= RECENT_MS ? 'recently_checked' : 'not_recently_checked',
            state: 'observed', timeBasis: 'source_publication_time' }));
        }
      });

      if (includeSelf || subjectsSet.size) read('comment_replies', commentReplyPath, db => {
        if (!hasTable(db, 'comment_reply_jobs')) throw new Error('Reply schema unavailable');
        // Reuse the service's account binding and immutable-draft integrity checks.
        const store = new CommentReplyStore(commentReplyPath, { accountId, selfId, readOnly: true });
        try {
          const values = [accountId, selfId];
          const filter = momentFilter('moment_id', values);
          const rows = rowsOf(db, `SELECT key FROM comment_reply_jobs WHERE account_id=? AND self_id=? AND state='verified'${filter}
            ORDER BY updated_at DESC,key LIMIT ?`, values, 'comment_replies');
          for (const row of rows) {
            try {
              const draft = store.get(row.key), proof = draft?.verification;
              const commentId = proof?.commentId;
              if (!draft || draft.state !== 'verified' || proof?.verified !== true || !objectId(commentId) ||
                  !objectId(draft.moment.id) || !objectId(draft.comment.commentId) ||
                  !identity(draft.moment.author?.id) || !identity(draft.comment.userId) ||
                  draft.comment.userId === selfId || !validTime(draft.attemptedAt, now) ||
                  !validTime(draft.updatedAt, now) || draft.updatedAt < draft.attemptedAt ||
                  draft.priorCommentIds.includes(commentId) ||
                  (proof.momentId !== undefined && proof.momentId !== draft.moment.id) ||
                  (proof.sourceCommentId !== undefined && String(proof.sourceCommentId) !== draft.comment.commentId) ||
                  (proof.replyCommentId !== undefined && String(proof.replyCommentId) !== draft.comment.commentId) ||
                  (proof.authorId !== undefined && proof.authorId !== selfId) ||
                  (proof.replyTo !== undefined && proof.replyTo !== draft.comment.userId) ||
                  (proof.text !== undefined && proof.text !== draft.text)) continue;
              // A self-authored reply is personal history. Its quoted peer text is not exposed.
              if (includeSelf) collect(evidence(accountId, { sourceType: 'self_moment_reply', action: 'replied', actorRole: 'self',
                authorId: selfId, momentId: draft.moment.id, text: draft.text, at: draft.attemptedAt,
                verifiedAt: draft.updatedAt, availability: 'verified_historical_reply', state: 'verified',
                commentId, sourceCommentId: draft.comment.commentId, replyToId: draft.comment.userId,
                momentAuthorId: draft.moment.author.id, timeBasis: 'verified_reply_attempt' }));
              if (subjectsSet.has(draft.comment.userId) && typeof draft.comment.text === 'string' &&
                  draft.comment.text.trim() && draft.comment.text.length <= 10000) {
                const sourceAt = Number(draft.comment.createTime) * 1000;
                const knownTime = validTime(sourceAt, now);
                collect(evidence(accountId, { sourceType: 'friend_moment_comment', action: 'commented', actorRole: 'friend',
                  authorId: draft.comment.userId, momentId: draft.moment.id, text: draft.comment.text,
                  at: knownTime ? sourceAt : draft.attemptedAt, verifiedAt: draft.updatedAt,
                  availability: 'verified_historical_comment_snapshot', state: 'observed',
                  commentId: draft.comment.commentId, sourceCommentId: draft.comment.commentId,
                  ...(draft.comment.replyTo ? { replyToId: draft.comment.replyTo } : {}),
                  momentAuthorId: draft.moment.author.id,
                  timeBasis: knownTime ? 'source_comment_time' : 'reply_source_observed_time' }));
              }
            } catch { /* A corrupt reply is not evidence. */ }
          }
        } finally { store.close(); }
      });

      const ordered = [...new Map(matches.map(item => [item.id, item])).values()]
        .sort((a, b) => b._rank - a._rank || b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
      return { matches: ordered.slice(0, limit).map(({ _text, _rank, ...item }) => item),
        coverage: { source: 'local_verified_moments_ledgers', complete: false,
          truncated: truncated || ordered.length > limit, scanLimitPerSource: SCAN_LIMIT, scanned, sources,
          scope: 'self_and_host_selected_friend_ids', currentVisibilityVerified: false,
          identityMatch: 'text_similarity_is_not_screenshot_or_forwarder_identity',
          legacyActions: 'unbound_legacy_likes_and_comments_excluded',
          note: 'Historical records only; absence is not proof an event never happened.' } };
    },
  };
}
