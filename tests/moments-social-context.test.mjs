import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { memoryScope } from '../packages/memory/index.mjs';
import { createSocialContextReader, runtimeSocialContext } from '../packages/moments/social-context.mjs';
import { MomentPersonMemory } from '../packages/moments/person-memory.mjs';
import { initializeObservations, accumulateDiaryObservations } from '../packages/people/observations.mjs';
import { createMomentsDecisionModel } from '../packages/moments/worker.mjs';
import { createCommentReplyModel } from '../packages/moments/comment-reply-worker.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'social-context-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const inboxPath = join(root, 'inbox.sqlite'), diaryPath = join(root, 'diary.sqlite'), memoryRoot = join(root, 'memory');
  mkdirSync(memoryRoot);
  const inbox = new DatabaseSync(inboxPath);
  inbox.exec("CREATE TABLE meta(key TEXT,value TEXT);INSERT INTO meta VALUES ('accountId','acct');CREATE TABLE inbox(id TEXT,message TEXT)");
  const add = (id, groupId, userId, text) => inbox.prepare('INSERT INTO inbox VALUES (?,?)').run(id, JSON.stringify({
    accountId: 'acct', groupId, userId, sourceMessageId: id, text }));
  add('s1', 'group@chatroom', 'u1', '我喜欢看BLG比赛'); add('s2', 'group@chatroom', 'u2', '我喜欢猫');
  add('s3', 'other@chatroom', 'u1', '不该进入的其他群内容'); inbox.close();
  const diary = new DatabaseSync(diaryPath);
  diary.exec('CREATE TABLE segments(id TEXT,account_id TEXT,group_id TEXT,title TEXT,events_json TEXT,start_at TEXT,end_at TEXT,end_rowid INTEGER)');
  for (const [i, group, who, quote] of [['1','group@chatroom','u1','我喜欢看BLG比赛'],['2','group@chatroom','u2','我喜欢猫'],['3','other@chatroom','u1','不该进入的其他群内容']]) {
    diary.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?,?)').run(`d${i}`, 'acct', group, '记录',
      JSON.stringify([{ text: quote, sourceMessageIds: [`s${i}`], sourceSpeakerIds: [who], evidenceQuote: quote }]),
      '2026-11-11', '2026-11-12', Number(i));
  }
  diary.close();
  const vector = new DatabaseSync(join(memoryRoot,'vectors.db'));
  vector.exec('CREATE TABLE vectors(id TEXT,payload TEXT)');
  for (const [i,group,who] of [['1','group@chatroom','u1'],['2','group@chatroom','u2'],['3','other@chatroom','u1']]) vector.prepare('INSERT INTO vectors VALUES (?,?)').run(i,
    JSON.stringify({ agent_id: memoryScope('acct',group), kind: 'core', accountId:'acct',groupId:group,subjectId:who,data:`fact-${i}`,category:'interest' }));
  vector.close();
  const peopleConfigPath = join(root,'people.json');
  writeFileSync(peopleConfigPath,JSON.stringify({schemaVersion:1,accountId:'acct',groupId:'group@chatroom',namesByUserId:{u1:['熟悉昵称']},identitySnapshots:{u1:{wechatNickname:'原名',groupNickname:'群名',wechatAccount:null}}}));
  return { accountId:'acct',groupIds:['group@chatroom'],inboxPath,diaryPath,memoryRoot,peopleConfigPath };
}

test('Moments memory joins stable actors and scoped evidence, not everyone or same-name strangers', t => {
  const config=fixture(t), read=createSocialContextReader(config);
  const moment={author:{id:'u1',name:'群名'},text:'BLG比赛'};
  const result=read({moment});
  assert.deepEqual(result.people.map(x=>x.userId),['u1']);
  assert.deepEqual(result.people[0].preferredNames,['熟悉昵称']);
  assert.deepEqual(result.people[0].facts.map(x=>x.id),['1']);
  assert.deepEqual(result.diary.map(x=>x.segmentId),['d1']);
  assert.equal(result.people[0].observations.length,0);
  assert.equal(read({moment:{...moment,author:{id:'stranger',name:'群名'}}}).people.length,0);
  assert.equal(createSocialContextReader({...config,groupIds:[]})({moment}).people.length,0);
});

test('missing or changed source quotes cannot become retrieved social history', t => {
  const config=fixture(t);
  const db=new DatabaseSync(config.inboxPath);
  db.prepare('DELETE FROM inbox WHERE id=?').run('s1'); db.close();
  const result=createSocialContextReader(config)({moment:{author:{id:'u1'},text:'比赛'}});
  assert.equal(result.diary.length,0);
  assert.equal(result.people.length,0);
});

test('revocation flags stop diary reuse and speaker attribution is rebuilt from original evidence', t => {
  const config=fixture(t), reader=createSocialContextReader(config);
  const moment={author:{id:'u1'},text:'比赛'};
  const db=new DatabaseSync(config.diaryPath);
  const row=db.prepare("SELECT events_json FROM segments WHERE id='d1'").get();
  const events=JSON.parse(row.events_json); events[0].sourceSpeakerIds=['wrong-user'];
  db.prepare("UPDATE segments SET events_json=? WHERE id='d1'").run(JSON.stringify(events));db.close();
  assert.deepEqual(reader({moment}).diary[0].sourceSpeakerIds,['u1']);
  const inbox=new DatabaseSync(config.inboxPath);
  const source=JSON.parse(inbox.prepare("SELECT message FROM inbox WHERE id='s1'").get().message);
  source.state='revoked'; inbox.prepare("UPDATE inbox SET message=? WHERE id='s1'").run(JSON.stringify(source));inbox.close();
  assert.equal(reader({moment}).diary.length,0);
});

test('both first comments and threaded replies really pass shared context into their model request', async () => {
  let calls=0;
  const socialContext={people:[{userId:'u1',preferredNames:['熟悉昵称']}],diary:[]};
  const capture=async request=>{calls++; const input=JSON.parse(request.messages[1].content); assert.deepEqual(input.socialContext,socialContext);return {action:'none'};};
  const lookupSocialContext=()=>socialContext;
  const moment={id:'123',author:{id:'u1',name:'名字'},text:'比赛',media:[],comments:[],likes:[]};
  await createMomentsDecisionModel({provider:'ollama',ollama:capture,lookupSocialContext})({moment,self:{name:'肥鱼'}});
  await createCommentReplyModel({provider:'ollama',ollama:capture,lookupSocialContext})({moment,comment:{commentId:'1',userId:'u1',text:'你好'},selfId:'self'});
  assert.equal(calls,2);
});

test('known current actors receive their own verified prior Moments with two reserved observation slots', t => {
  const config = fixture(t), now = Date.now();
  const momentMemoryPath = join(config.memoryRoot, '..', 'person-memory.sqlite');
  const memories = new MomentPersonMemory(momentMemoryPath);
  const makeMoment = (id, userId, days = 30) => ({ id, author: { id: userId, name: '群名' },
    text: `我去青岛旅游了，动态${id}`, createTime: Math.floor((now - days * 86400000) / 1000) });
  memories.record({ accountId: 'acct', moment: makeMoment('101', 'u1', 32), now });
  memories.record({ accountId: 'acct', moment: makeMoment('102', 'u1', 31), now });
  memories.record({ accountId: 'acct', moment: makeMoment('103', 'u1', 30), now });
  memories.record({ accountId: 'acct', moment: makeMoment('104', 'u2', 1), now });
  memories.record({ accountId: 'other-account', moment: makeMoment('105', 'u1', 0), now });
  memories.record({ accountId: 'acct', moment: makeMoment('106', 'stranger', 0), now });
  memories.close();
  const inbox = new DatabaseSync(config.inboxPath), history = new DatabaseSync(config.diaryPath);
  initializeObservations(history);
  const messages = Array.from({ length: 4 }, (_, i) => ({ id: `own-observation-${i}`, senderId: 'u1',
    text: `我喜欢游戏${i}`, at: new Date(now - 3600000).toISOString(), interaction: 'text' }));
  for (const message of messages) inbox.prepare('INSERT INTO inbox VALUES (?,?)').run(message.id,
    JSON.stringify({ accountId: 'acct', groupId: 'group@chatroom', userId: 'u1',
      sourceMessageId: message.id, text: message.text, eventTime: message.at }));
  accumulateDiaryObservations(history, { accountId: 'acct', groupId: 'group@chatroom', segmentId: 'test-observations', messages,
    events: messages.map((message, i) => ({ sourceMessageIds: [message.id], evidenceQuote: message.text,
      personObservation: { subjectId: 'u1', category: 'interest', topic: `游戏${i}`, stance: 'support' } })) });
  inbox.close(); history.close();
  const reader = createSocialContextReader({ ...config, momentMemoryPath });
  const result = reader({ moment: { author: { id: 'u1', name: '群名' }, text: '又想出去玩了' } });
  assert.deepEqual(result.people.map(item => item.userId), ['u1']);
  assert.equal(result.people[0].observations.length, 6);
  const sns = result.people[0].observations.filter(item => item.sourceType === 'friend_moment');
  assert.deepEqual(sns.map(item => item.evidence[0].sourceMomentId), ['103', '102']);
  assert.ok(sns.every(item => item.subjectId === 'u1' && item.ageDays >= 30));
  assert.equal(result.source, 'authorized_group_and_moments_memory');
  assert.equal(reader({ moment: { author: { id: 'stranger', name: '群名' }, text: '旅游' } }).people.length, 0);
  assert.equal(createSocialContextReader({ ...config, momentMemoryPath, groupIds: [] })({ moment: { author: { id: 'u1' } } }).people.length, 0);
});

test('private, unavailable and verification-expired Moments are excluded from current social context', t => {
  const config = fixture(t), now = Date.now();
  const momentMemoryPath = join(config.memoryRoot, '..', 'person-memory.sqlite');
  const memories = new MomentPersonMemory(momentMemoryPath);
  const makeMoment = id => ({ id, author: { id: 'u1' }, text: '我在青岛旅游',
    createTime: Math.floor((now - 72 * 3600000) / 1000) });
  memories.record({ accountId: 'acct', moment: makeMoment('201'), now });
  memories.record({ accountId: 'acct', moment: { ...makeMoment('201'), private: true }, now });
  memories.record({ accountId: 'acct', moment: makeMoment('202'), now: now - 49 * 3600000 });
  memories.record({ accountId: 'acct', moment: makeMoment('203'), now });
  memories.db.prepare("UPDATE moments_sources SET state='unavailable' WHERE moment_id='203'").run();
  memories.close();
  const result = createSocialContextReader({ ...config, momentMemoryPath })({ moment: { author: { id: 'u1' }, text: '旅游' } });
  assert.equal(result.people.length, 1);
  assert.deepEqual(result.people[0].observations, []);
});

test('runtime reader loads the default Moments person-memory path with the existing group gate intact', t => {
  const config = fixture(t), root = join(config.memoryRoot, '..'), now = Date.now();
  const memories = new MomentPersonMemory(join(root, '.runtime/moments/person-memory.sqlite'));
  memories.record({ accountId: 'acct', moment: { id: '301', author: { id: 'u1' }, text: '我喜欢看比赛',
    createTime: Math.floor((now - 86400000) / 1000) }, now });
  memories.close();
  const env = { SOCIOMEM_WECHAT_GROUPS: 'group@chatroom', SOCIOMEM_WECHAT_DB: config.inboxPath,
    SOCIOMEM_DIARY_ROOT: root, SOCIOMEM_MEMORY_ROOT: config.memoryRoot, SOCIOMEM_PEOPLE_CONFIG: config.peopleConfigPath };
  const result = runtimeSocialContext({ root, accountId: 'acct', env })({ moment: { author: { id: 'u1' }, text: '比赛' } });
  assert.equal(result.people[0].observations[0].evidence[0].sourceMomentId, '301');
});
