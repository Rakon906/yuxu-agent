import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadPeopleConfig } from '../people/index.mjs';
import { readObservationProfiles } from '../people/observations.mjs';
import { readCoreFacts } from '../diary/index.mjs';
import { readMomentObservations } from './person-memory.mjs';
import { runtimeMomentsExperience, publicMomentsContext, filterMomentsForActors } from '../participation/moments-context.mjs';

const ids = value => typeof value === 'string' && /^[\w.@-]{1,200}$/u.test(value);
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

/** Only current actors with a stable identity in an explicitly allowed group are joined. */
export function createSocialContextReader({ accountId, groupIds = [], inboxPath, diaryPath,
  memoryRoot, peopleConfigPath, momentMemoryPath = null, onError = () => {} }) {
  if (!ids(accountId) || !Array.isArray(groupIds) || groupIds.some(id => !ids(id))) throw new Error('Invalid social memory scope');
  const allowed = [...new Set(groupIds)];
  return ({ moment, comment = null } = {}) => {
    const userIds = [...new Set([comment?.userId, moment?.author?.id].filter(ids))].slice(0, 2);
    const people = [], diary = [];
    if (!allowed.length || !userIds.length || !existsSync(inboxPath)) return { people, diary };
    const inbox = new DatabaseSync(inboxPath, { readOnly: true });
    let history;
    try {
      inbox.exec('PRAGMA busy_timeout=3000');
      if (inbox.prepare("SELECT value FROM meta WHERE key='accountId'").get()?.value !== accountId) {
        throw new Error('Social memory Inbox account mismatch');
      }
      if (existsSync(diaryPath)) history = new DatabaseSync(diaryPath, { readOnly: true });
      for (const groupId of allowed.slice(0, 3)) {
        let names = new Map();
        if (peopleConfigPath && existsSync(peopleConfigPath)) {
          const descriptor = parse(readFileSync(peopleConfigPath, 'utf8'));
          if (descriptor?.accountId === accountId && descriptor.groupId === groupId) {
            names = loadPeopleConfig(peopleConfigPath, accountId, groupId).names;
          }
        }
        const known = userIds.filter(userId => Boolean(inbox.prepare(`SELECT 1 FROM inbox
          WHERE json_extract(message,'$.accountId')=? AND json_extract(message,'$.groupId')=?
          AND json_extract(message,'$.userId')=? LIMIT 1`).get(accountId, groupId, userId)));
        if (!known.length) continue;
        const coreFacts = readCoreFacts(memoryRoot, accountId, groupId);
        const observations = readObservationProfiles(diaryPath, { accountId, groupId, userIds: known, limitPerPerson: 4, inboxPath });
        for (const userId of known) {
          // The same stable-ID/allowed-group gate applies to SNS background.
          // Keep sources distinct and reserve at most two of six slots for SNS.
          const momentObservations = momentMemoryPath
            ? readMomentObservations(momentMemoryPath, { accountId, subjectId: userId, limit: 2 }) : [];
          people.push({ userId, preferredNames: names.get(userId) ?? [],
            facts: coreFacts.filter(item => item.subjectId === userId).slice(0, 6),
            observations: [...observations.filter(item => item.subjectId === userId).slice(0, 4),
              ...momentObservations].slice(0, 6) });
        }
        if (history) {
          const rows = history.prepare(`SELECT id,title,events_json,start_at,end_at FROM segments
            WHERE account_id=? AND group_id=? ORDER BY end_rowid DESC LIMIT 100`).all(accountId, groupId);
          const query = String(comment?.text ?? moment?.text ?? '').normalize('NFKC').toLowerCase();
          const terms = [...new Set(query.match(/[a-z0-9]{2,}|[\u3400-\u9fff]{2,6}/gu) ?? [])];
          const checkedEvent = event => {
            const sourceIds = event.sourceMessageIds;
            if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.length > 20 ||
                typeof event.evidenceQuote !== 'string' || !event.evidenceQuote) return false;
            const sources = sourceIds.map(id => parse(inbox.prepare('SELECT message FROM inbox WHERE id=?').get(id)?.message));
            if (!sources.every((item, i) => item && item.sourceMessageId === sourceIds[i] &&
              item.accountId === accountId && item.groupId === groupId &&
              !item.recall && !item.recalled && !item.revoked && !item.deleted &&
              !['recalled', 'revoked', 'deleted'].includes(item.state) &&
              typeof item.text === 'string') || !sources.some(item => known.includes(item.userId)) ||
              !sources.some(item => item.text.includes(event.evidenceQuote))) return null;
            const quoted = sources.filter(item => item.text.includes(event.evidenceQuote));
            return { ...event, sourceSpeakerIds: [...new Set(sources.map(item => item.userId))],
              quoteSpeakerIds: [...new Set(quoted.filter(item => (!item.interaction || item.interaction === 'text') && !item.quote).map(item => item.userId))],
              ...(quoted.some(item => (item.interaction && item.interaction !== 'text') || item.quote)
                ? { evidenceAttribution: 'external_content_not_source_speaker' } : {}) };
          };
          const events = rows.flatMap(row => (parse(row.events_json) ?? []).map(checkedEvent).filter(Boolean).map(event => ({
            segmentId: row.id, title: row.title, startAt: row.start_at, endAt: row.end_at,
            text: String(event.text ?? '').slice(0, 1200), sourceSpeakerIds: event.sourceSpeakerIds, quoteSpeakerIds: event.quoteSpeakerIds,
            sourceMessageIds: event.sourceMessageIds, evidenceQuote: event.evidenceQuote,
            ...(event.evidenceAttribution ? { evidenceAttribution: event.evidenceAttribution } : {}),
          }))).map(item => ({ ...item, rank: terms.reduce((n, t) => n + Number(item.text.toLowerCase().includes(t)), 0) }));
          events.sort((a, b) => b.rank - a.rank || b.endAt.localeCompare(a.endAt));
          diary.push(...events.slice(0, 3).map(({ rank, ...item }) => item));
        }
      }
      return { people: people.slice(0, 4), diary: diary.slice(0, 3),
        source: people.some(person => person.observations.some(item => item.sourceType === 'friend_moment'))
          ? 'authorized_group_and_moments_memory' : 'authorized_group_memory',
        guidance: '这些是已有群聊记忆及有来源标识的好友朋友圈原话，仅帮助认人、称呼和理解。朋友圈描述的是作者当时的近况，不等于现在仍如此；观察候选不是确定性格，转述也不归属作者。事件参与者不等于每件事的主体。不要在朋友圈泄露或逐字转述未公开的群聊、私事、号码等；不要为了展示记忆而提及过往。' };
    } catch (error) { onError({ errorType: error.name }); return { people: [], diary: [], unavailable: true }; }
    finally { history?.close(); inbox.close(); }
  };
}

export function runtimeSocialContext({ root, accountId, selfId = null, env = process.env, onError }) {
  const groupContext = createSocialContextReader({ accountId,
    groupIds: (env.SOCIOMEM_WECHAT_GROUPS ?? '').split(',').map(x => x.trim()).filter(Boolean),
    inboxPath: env.SOCIOMEM_WECHAT_DB ?? join(root, '.runtime/wechat-adapter/sociomem.sqlite'),
    diaryPath: join(env.SOCIOMEM_DIARY_ROOT ?? join(root, '.runtime/diary'), 'diary.sqlite'),
    memoryRoot: env.SOCIOMEM_MEMORY_ROOT ?? join(root, '.runtime/memory'),
    momentMemoryPath: env.SOCIOMEM_MOMENT_MEMORY_DB ?? join(root, '.runtime/moments/person-memory.sqlite'),
    peopleConfigPath: env.SOCIOMEM_PEOPLE_CONFIG ?? join(root, '.runtime/people/group-people.json'), onError });
  if (!selfId) return groupContext;
  const reader = runtimeMomentsExperience({ root, accountId, selfId, env, onError });
  return input => {
    const context = groupContext(input);
    const actors = [input.moment?.author, input.comment && { id: input.comment.userId, name: input.comment.name }]
      .filter(person => ids(person?.id));
    const subjectIds = [...new Set(actors.map(person => person.id))];
    const found = reader.search({ query: [input.moment?.text, input.comment?.text].filter(Boolean).join(' ').slice(0, 500),
      subjectIds, limit: 6 });
    const own = reader.search({ subjectIds: [], limit: 4 });
    const matches = filterMomentsForActors({ matches: [...new Map([...found.matches, ...own.matches]
      .map(item => [item.id, item])).values()] }, selfId, subjectIds).matches.slice(0, 8);
    return { ...context, momentsContext: publicMomentsContext({ matches, coverage: found.coverage }, selfId),
      momentsActors: actors.map(person => ({ name: person.name ?? '',
        speakerKey: publicMomentsContext({ matches: [{ authorId: person.id }] }, selfId).matches[0].authorKey })),
      momentsGuidance: 'AGENT是肥鱼不肥本人。已核实发布、看过的好友动态和已完成回复构成历史经历；原作者与转发者分开，历史核对不等于当前可见。仅相似正文不能认定截图账号。私事不外泄，不复读旧评论。' };
  };
}
