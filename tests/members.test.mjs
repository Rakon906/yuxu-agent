import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { ParticipationLedger } from '../packages/participation/index.mjs';
import { initProactiveLedger, proactiveOpportunity } from '../packages/participation/proactive.mjs';
import { MemberTracker, runMemberWelcome } from '../packages/members/index.mjs';

const accountId='account-member-test', groupId='members@chatroom', selfUserId='wxid-agent';
const now=Date.parse('2026-11-13T06:00:00Z');
const roster=(...ids)=>new Map([[selfUserId,'肥鱼'],...ids.map(id=>[id,`昵称${id}`])]);
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'sociomem-members-'));
  const inboxPath=join(dir,'inbox.sqlite');
  const source=new AdapterStore(inboxPath,accountId);
  const store=new AdapterStore(join(dir,'participation.sqlite'),accountId);
  const ledger=new ParticipationLedger(store);
  let tracker=new MemberTracker(store.db,{accountId,groupId,selfUserId});
  let sends=0, sequence=0;
  const adapter={client:{accountId},allowed:new Set([groupId]),
    propose:({key,groupId:to,text})=>store.draft(key,to,text),
    sendApproved:async key=>{sends++;store.db.prepare('UPDATE outbox SET attempted_at=? WHERE key=?').run(now,key);return store.receipt(key,'accepted',{id:`send-${sends}`,accountId,destination:groupId,state:'accepted'});}};
  const observe=(r,at=now,extra={})=>tracker.observe({roster:r,complete:true,now:at,...extra});
  const incoming=(at=now-20*60000)=>{sequence++;return source.commitEvent(String(sequence),{accountId,groupId,userId:'old',sourceMessageId:`source-${sequence}`,text:'今天聊得不错',eventTime:new Date(at).toISOString(),recordedAt:new Date(at).toISOString()},'text');};
  const joinNew=()=>{observe(roster('old'),now-300000);observe(roster('old','new'),now-180000);observe(roster('old','new'),now-120000);};
  const run=(model=async()=>({shouldReply:true,reply:'新朋友来啦，随便坐呀'}),extra={})=>runMemberWelcome({tracker,ledger,adapter,model,inboxPath,accountId,groupId,lookupIdentity:id=>({displayName:`昵称${id}`,preferredNames:[]}),sendEnabled:true,now,...extra});
  return {dir,source,store,ledger,adapter,observe,incoming,joinNew,run,
    get tracker(){return tracker;},get sends(){return sends;},
    reopenTracker(){tracker=new MemberTracker(store.db,{accountId,groupId,selfUserId});return tracker;},
    close(){source.close();store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('first complete roster is a baseline, partial/stale rosters do not welcome or remove',()=>{
  const f=fixture();
  try {
    assert.equal(f.observe(roster('old'),now-300000,{complete:false}).ignored,true);
    assert.equal(f.tracker.identity('old'),null);
    assert.equal(f.observe(roster('old'),now-200000).initialized,true);
    assert.equal(f.tracker.due(now),undefined);
    assert.equal(f.observe(roster('new'),now-200000).ignored,true);
    f.observe(roster('new'),now-100000,{complete:false});
    assert.equal(f.tracker.identity('old').present,true);
    assert.equal(f.tracker.identity('new'),null);
    assert.equal(f.reopenTracker().due(now),undefined);
  }finally{f.close();}
});

test('new members require two complete observations at least a minute apart',()=>{
  const f=fixture();
  try {
    f.observe(roster('old'),now-300000);
    f.observe(roster('old','new'),now-180000);
    assert.equal(f.tracker.due(now),undefined);
    f.observe(roster('old','new'),now-150000);
    assert.equal(f.tracker.due(now),undefined);
    f.observe(roster('old','new'),now-120000);
    const due=f.tracker.due(now);
    assert.equal(due.user_id,'new');
    assert.equal(due.confirmed,1);
    assert.equal(f.reopenTracker().due(now).id,due.id);
  }finally{f.close();}
});

test('nicknames and WeChat account labels update while stable user ID and history survive',()=>{
  const f=fixture();
  try {
    f.observe(roster('old'),now-300000,{contacts:new Map([['old',{wechatNickname:'微信昵称',wechatAccount:'old-alias'}]])});
    const renamed=roster('old');renamed.set('old','新群昵称');
    const result=f.observe(renamed,now-120000,{contacts:new Map([['old',{wechatNickname:'新的微信昵称',wechatAccount:'new-alias'}]])});
    const identity=f.tracker.identity('old');
    assert.equal(result.joined,0);
    assert.equal(identity.identitySource,'stable_wechat_id');
    assert.equal(identity.current.groupNickname,'新群昵称');
    assert.equal(identity.current.wechatAccount,'new-alias');
    assert.equal(identity.previousNames[0].wechatNickname,'微信昵称');
    assert.equal(f.tracker.due(now),undefined);
  }finally{f.close();}
});

test('first disappearance suspends welcome; second confirms departure and cancels pending',()=>{
  const f=fixture();
  try {
    f.joinNew();assert.equal(f.tracker.due(now).user_id,'new');
    f.observe(roster('old'),now-60000);
    assert.equal(f.tracker.identity('new').present,true);
    assert.equal(f.tracker.identity('new').currentlyObserved,false);
    assert.equal(f.tracker.due(now),undefined);
    f.observe(roster('old'),now);
    assert.equal(f.tracker.identity('new').present,false);
    assert.equal(f.store.db.prepare("SELECT state,reason FROM member_welcomes WHERE user_id='new'").get().reason,'departed');
    f.observe(roster('old','new'),now+60000);
    f.observe(roster('old','new'),now+120000);
    assert.equal(f.tracker.due(now+120000).user_id,'new');
    assert.equal(f.store.db.prepare("SELECT COUNT(*) n FROM member_welcomes WHERE user_id='new'").get().n,2);
  }finally{f.close();}
});

test('abruptly shrunken roster is ignored; groups isolated and mismatched DB account rejected',()=>{
  const f=fixture();
  try {
    f.observe(roster('1','2','3','4','5','6'),now-200000);
    assert.equal(f.observe(roster('1'),now).reason,'roster_shrank_abruptly');
    assert.equal(f.tracker.identity('6').present,true);
    const other=new MemberTracker(f.store.db,{accountId,groupId:'other@chatroom',selfUserId});
    assert.equal(other.identity('1'),null);
    other.observe({roster:roster('new'),complete:true,now});
    assert.equal(other.due(now),undefined);
    assert.equal(f.tracker.identity('new'),null);
    assert.throws(()=>new MemberTracker(f.store.db,{accountId:'wrong-account',groupId,selfUserId}),/account scope/u);
  }finally{f.close();}
});

test('welcome uses persona once and is not duplicated after tracker restart',async()=>{
  const f=fixture();
  try {
    f.joinNew();f.incoming();let calls=0;
    const result=await f.run(async request=>{calls++;assert.equal(request.kind,'member_welcome');assert.equal(request.initiative.member.name,'昵称new');assert.equal(request.remainingToolCalls,0);return{shouldReply:true,reply:'新朋友来啦，随便坐呀'};});
    assert.equal(result.status,'sent');assert.equal(f.sends,1);
    f.reopenTracker();
    assert.equal((await f.run(async()=>{calls++;return{shouldReply:true,reply:'又来啦'};})).status,'waiting');
    assert.equal(calls,1);assert.equal(f.sends,1);
  }finally{f.close();}
});

test('welcome stops if new message or departure arrives during generation',async()=>{
  for(const change of ['message','departure']) {
    const f=fixture();
    try {
      f.joinNew();f.incoming();
      const result=await f.run(async()=>{
        if(change==='message')f.incoming(now+1000);else f.observe(roster('old'),now+1000);
        return{shouldReply:true,reply:'来啦，新朋友'};
      });
      assert.equal(result.status,'skipped',change);assert.equal(f.sends,0);
    }finally{f.close();}
  }
});

test('shared proactive quota stops welcome before any model call',async()=>{
  const f=fixture();
  try {
    f.joinNew();initProactiveLedger(f.ledger);
    for(let i=0;i<4;i++)f.store.db.prepare('INSERT INTO proactive_slots(group_id,local_date,slot,state,checked_at,baseline_rowid) VALUES (?,?,?,?,?,?)')
      .run(groupId,proactiveOpportunity(now).date,`other-${i}`,'sent',now,0);
    assert.equal((await f.run(()=>{throw new Error('must not call model');})).status,'waiting');
    assert.equal(f.sends,0);
  }finally{f.close();}
});

test('pre-send guards recheck same-millisecond other sends, pending work and midnight',async()=>{
  for(const change of ['other-send','pending-task','midnight']) {
    const f=fixture();
    let clock=10000;
    try {
      f.joinNew();f.incoming();
      const timestamp=change==='midnight'?Date.parse('2026-11-13T15:59:59Z'):now;
      const result=await f.run(async()=>{
        if(change==='other-send') {
          f.store.draft('parallel-send',groupId,'之前的回复');
          f.store.db.prepare("UPDATE outbox SET state='accepted',attempted_at=? WHERE key='parallel-send'").run(timestamp);
        }else if(change==='pending-task') {
          f.ledger.observe({id:'new-task',groupId,senderId:'old',rowid:10,text:'肥鱼在吗',at:new Date(timestamp).toISOString()},'mention',timestamp);
        }else clock+=2000;
        return{shouldReply:true,reply:'新朋友来啦'};
      },{now:timestamp,clock:()=>clock});
      assert.equal(result.status,'skipped',change);assert.equal(f.sends,0);
    }finally{f.close();}
  }
});

test('disabled sends, quiet hours and cross-group adapter scope cause no model activity',async()=>{
  const f=fixture();
  try {
    f.joinNew();const model=()=>{throw new Error('must not call model');};
    assert.equal((await f.run(model,{sendEnabled:false})).status,'waiting');
    assert.equal((await f.run(model,{now:Date.parse('2026-11-13T01:00:00Z')})).status,'waiting');
    await assert.rejects(f.run(model,{groupId:'other@chatroom'}),/scope mismatch/u);
    assert.equal(f.sends,0);
  }finally{f.close();}
});
