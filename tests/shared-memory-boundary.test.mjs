import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { validateDiaryOutput } from '../packages/diary/index.mjs';
import { initializeObservations, accumulateDiaryObservations, readObservationProfiles, validatePersonObservation } from '../packages/people/observations.mjs';
import { LifeEventStore } from '../packages/life-events/index.mjs';
import { SocialContextStore } from '../packages/social-context/index.mjs';
import { createSocialContextReader } from '../packages/moments/social-context.mjs';

const scope={accountId:'boundary-account',groupId:'boundary@chatroom'};
const at='2026-11-13T06:00:00.000Z', now=Date.parse(at);
const source=(interaction='text',extra={})=>({id:'source-1',senderId:'outer-forwarder',at,text:'我喜欢BLG',interaction,...scope,...extra});
const event=message=>({text:'来源中提到了BLG',sourceMessageIds:[message.id],evidenceQuote:message.text,
  personObservation:{subjectId:message.senderId,category:'interest',topic:'BLG',stance:'support'}});
const output=(message,updates=[])=>({diary:{title:'讨论记录',summary:'有人分享了内容',events:[event(message)]},coreUpdates:updates});
const core=(message,subjectId=message.senderId,extra={})=>({action:'add',category:'interest',subjectId,fact:'喜欢BLG',sourceMessageIds:[message.id],evidenceQuote:message.text,...extra});
function fixture(t){
  const dir=mkdtempSync(join(tmpdir(),'sociomem-shared-boundary-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  return{dir,inboxPath:join(dir,'inbox.sqlite'),diaryPath:join(dir,'diary.sqlite')};
}

test('forwarded/card diary quotes retain provider but never attribute inside words to that person',()=>{
  for(const interaction of ['forwarded','share']){
    const message=source(interaction);
    const checked=validateDiaryOutput(output(message),[message]);
    const item=checked.diary.events[0];
    assert.deepEqual(item.sourceSpeakerIds,['outer-forwarder']);
    assert.deepEqual(item.quoteSpeakerIds,[]);
    assert.equal(item.evidenceAttribution,'external_content_not_source_speaker');
    assert.equal(item.personObservation,undefined);
    assert.equal(item.classificationRejected,'invalid_person_observation');
  }
});

test('personal and group core updates cannot promote forwarded/card statements',()=>{
  for(const interaction of ['forwarded','share'])for(const subject of ['outer-forwarder','group']){
    const message=source(interaction);
    assert.throws(()=>validateDiaryOutput(output(message,[core(message,subject)]),[message]),/direct text evidence|cited sender/u);
  }
  const direct=source();
  assert.equal(validateDiaryOutput(output(direct,[core(direct,'group')]),[direct]).coreUpdates.length,1);
});

test('media and forwarded evidence cannot pad the three-message behavior observation threshold',()=>{
  const first=source('text',{text:'我经常看BLG比赛'});
  const second=source('forwarded',{id:'source-2',text:'我经常看BLG比赛'});
  const third=source('share',{id:'source-3',text:'我经常看BLG比赛'});
  const proposed=core(first,first.senderId,{category:'speaking_style',fact:'经常谈BLG',sourceMessageIds:[first.id,second.id,third.id]});
  assert.throws(()=>validateDiaryOutput(output(first,[proposed]),[first,second,third]),/repeated self evidence/u);
});

test('person observations reject explicit classification and do not accumulate a generic utterance from shares',()=>{
  const db=new DatabaseSync(':memory:');initializeObservations(db);
  try{
    for(const interaction of ['forwarded','share']){
      const message=source(interaction);
      const proposed=event(message);
      assert.throws(()=>validatePersonObservation(proposed.personObservation,proposed,[message]),/self evidence/u);
      delete proposed.personObservation;
      assert.equal(accumulateDiaryObservations(db,{...scope,segmentId:'segment',events:[proposed],messages:[message]}),0);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM person_observations').get().n,0);
  }finally{db.close();}
});

test('read-time profile verification drops old observations reclassified as forwarded without waiting for backfill',t=>{
  const {inboxPath,diaryPath}=fixture(t);
  const inbox=new AdapterStore(inboxPath,scope.accountId);
  const db=new DatabaseSync(diaryPath);initializeObservations(db);
  try{
    const message=source();
    const raw={...scope,sourceMessageId:message.id,userId:message.senderId,eventTime:message.at,text:message.text,interaction:'text'};
    inbox.commitEvent('1',raw,'text');
    accumulateDiaryObservations(db,{...scope,segmentId:'segment',events:[event(message)],messages:[message]});
    const select=()=>readObservationProfiles(diaryPath,{...scope,userIds:[message.senderId],inboxPath});
    assert.equal(select().length,1);
    inbox.db.prepare('UPDATE inbox SET message=? WHERE id=?').run(JSON.stringify({...raw,interaction:'forwarded'}),message.id);
    assert.deepEqual(select(),[]);
  }finally{db.close();inbox.close();}
});

test('forwarded and share sources cannot create life-event tasks through rules or direct model proposals',t=>{
  const {dir}=fixture(t);
  const store=new LifeEventStore(join(dir,'life.sqlite'));
  try{
    for(const interaction of ['forwarded','share']){
      const message=source(interaction,{text:'我明天下午三点面试'});
      const result=store.ingest({...scope,messages:[message],proposals:[{action:'upsert',sourceMessageId:message.id,kind:'interview',topic:'面试',evidenceQuote:message.text,dateText:'明天',timeText:'下午三点'}],now});
      assert.equal(result.created,0);
      assert.equal(result.rejected.length,1);
    }
    assert.deepEqual(store.list(scope),[]);
  }finally{store.close();}
});

test('forwarded/card contents cannot create activities or pair relationships',t=>{
  const {dir}=fixture(t);
  const store=new SocialContextStore(join(dir,'social.sqlite'));
  try{
    const knownMembers=[{userId:'outer-forwarder',displayName:'转发者'},{userId:'bob',displayName:'示例成员19'}];
    for(const interaction of ['forwarded','share'])for(const text of ['周六下午三点一起打球','我和示例成员19是同学']){
      const message=source(interaction,{text});
      assert.equal(store.ingest({...scope,knownMembers,messages:[message],now}).inserted,0);
      assert.equal(store.applyProposals({...scope,knownMembers,messages:[message],proposals:[{
        type:'activity',action:'create',sourceMessageId:message.id,evidenceQuote:text,
      }],now}).inserted,0);
    }
    assert.deepEqual(store.context({...scope,knownMembers,now}).activities,[]);
    assert.deepEqual(store.context({...scope,knownMembers,now}).relationships,[]);
  }finally{store.close();}
});

test('Moments context rebuilds external diary attribution without making the forwarder an inner speaker',t=>{
  const {dir,inboxPath,diaryPath}=fixture(t);
  const inbox=new AdapterStore(inboxPath,scope.accountId);
  const diary=new DatabaseSync(diaryPath);
  diary.exec('CREATE TABLE segments(id TEXT,account_id TEXT,group_id TEXT,title TEXT,events_json TEXT,start_at TEXT,end_at TEXT,end_rowid INTEGER)');
  try{
    let index=0;
    for(const interaction of ['forwarded','share','text']){
      index++;
      const message=source(interaction,{id:`source-${index}`});
      inbox.commitEvent(String(index),{...scope,userId:message.senderId,sourceMessageId:message.id,text:message.text,eventTime:message.at,interaction},'text');
      diary.prepare('INSERT INTO segments VALUES (?,?,?,?,?,?,?,?)').run(`segment-${interaction}`,scope.accountId,scope.groupId,'BLG话题',
        JSON.stringify([{text:'有人提到BLG',sourceMessageIds:[message.id],evidenceQuote:message.text,
          sourceSpeakerIds:['wrong-person'],quoteSpeakerIds:['outer-forwarder']}]),at,at,index);
    }
    const read=createSocialContextReader({...scope,groupIds:[scope.groupId],inboxPath,diaryPath,memoryRoot:join(dir,'memory')});
    const result=read({moment:{author:{id:'outer-forwarder'},text:'BLG比赛'}});
    assert.equal(result.diary.length,3);
    for(const interaction of ['forwarded','share']){
      const item=result.diary.find(x=>x.segmentId===`segment-${interaction}`);
      assert.deepEqual(item.sourceSpeakerIds,['outer-forwarder']);
      assert.deepEqual(item.quoteSpeakerIds,[]);
      assert.equal(item.evidenceAttribution,'external_content_not_source_speaker');
    }
    assert.deepEqual(result.diary.find(x=>x.segmentId==='segment-text').quoteSpeakerIds,['outer-forwarder']);
    assert.equal(createSocialContextReader({...scope,groupIds:['unrelated@chatroom'],inboxPath,diaryPath,memoryRoot:join(dir,'memory')})({moment:{author:{id:'outer-forwarder'}}}).diary.length,0);
  }finally{diary.close();inbox.close();}
});
