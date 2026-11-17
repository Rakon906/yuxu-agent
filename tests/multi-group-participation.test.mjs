import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger, runParticipationCycle } from '../packages/participation/index.mjs';
import { voiceSourceRevision } from '../packages/voice/source-revision.mjs';
import { deriveMemberInterests } from '../packages/participation/interests.mjs';

test('two group workers share capture but only see, reply and advance their own group', async t => {
  const base=fileURLToPath(new URL('../.runtime/test-tmp/',import.meta.url));mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'multi-group-')),inboxPath=join(root,'capture.sqlite');
  const accountId='account-fixture',selfUserId='self',groups=['111111@chatroom','222222@chatroom'];
  const capture=new AdapterStore(inboxPath,accountId),stores=groups.map((_,i)=>new AdapterStore(join(root,`ledger-${i}.sqlite`),accountId));
  t.after(()=>{capture.close();for(const store of stores)store.close();});
  const ledgers=stores.map(store=>new ParticipationLedger(store));
  const deliveries=[];const client={accountId,send:async(destination,text,key)=>{deliveries.push({destination,text});return{id:key,accountId,destination,state:'accepted'};}};
  const adapters=stores.map((store,i)=>new WeChatAdapter({client,store,allowedGroups:[groups[i]],selfUserId,sendingEnabled:true,cooldownMs:0}));
  const now=Date.now();let seq=0;
  const insert=(groupId,text,id,at)=>capture.commitEvent(String(++seq),{accountId,groupId,userId:'same-person',sourceMessageId:id,text,
    eventTime:new Date(at).toISOString(),recordedAt:new Date(at).toISOString(),mentions:{self:true,userIds:[]}},'text');
  insert(groups[0],'旧群历史','old-a',now-60000);
  const voiceBaseline=voiceSourceRevision(capture.db,accountId,groups[0]);
  insert(groups[1],'新群入群前记录','old-b',now-60000);
  assert.equal(voiceSourceRevision(capture.db,accountId,groups[0]),voiceBaseline,'another group must not cancel this voice');
  const run=(i,at,model)=>runParticipationCycle({ledger:ledgers[i],adapter:adapters[i],accountId,groupId:groups[i],inboxPath,
    sendEnabled:true,now:at,startAtLatest:true,voiceRandomProbability:0,model});
  await Promise.all(groups.map((_,i)=>run(i,now,()=>assert.fail('history must not trigger a model'))));
  insert(groups[0],'肥鱼，这是甲群，三角洲好玩吗','new-a',now+1000);insert(groups[1],'肥鱼，这是乙群','new-b',now+1000);
  const interests=deriveMemberInterests({inboxPath,accountId,groupId:groups[0],maxMessages:1,now:now+2000});
  assert.ok(interests.get('same-person')?.some(item=>item.terms.includes('三角洲')),'other groups cannot crowd this group out of its own interest window');
  assert.ok(voiceSourceRevision(capture.db,accountId,groups[0])>voiceBaseline,'same group must invalidate old voice context');
  await Promise.all(groups.map((_,i)=>run(i,now+1000,()=>assert.fail('wait for normal debounce'))));
  const outputs=await Promise.all(groups.map((_,i)=>run(i,now+21000,async input=>{
    assert.equal(input.target.id,i===0?'new-a':'new-b');
    assert.ok(input.context.every(message=>i===0?!message.text.includes('乙群'):!message.text.includes('甲群')));
    assert.ok(!input.context.some(message=>message.id===(i===0?'new-b':'new-a')));
    return{isAddressed:true,isQuestion:false,isFollowup:false,answeredByHuman:false,shouldReply:true,reply:i===0?'甲群在呢':'乙群在呢',reason:'addressed'};
  })));
  assert.ok(outputs.every(result=>result.status==='sent'));assert.equal(deliveries.length,2);
  assert.deepEqual(deliveries.map(x=>[x.destination,x.text]).sort(),[[groups[0],'甲群在呢'],[groups[1],'乙群在呢']]);
  assert.equal(stores[0].db.prepare('SELECT count(*) n FROM participation_tasks WHERE group_id=?').get(groups[1]).n,0);
  assert.equal(stores[1].db.prepare('SELECT count(*) n FROM participation_tasks WHERE group_id=?').get(groups[0]).n,0);
  await Promise.all(groups.map((_,i)=>run(i,now+31000,()=>assert.fail('no duplicate model/reply'))));
  assert.equal(deliveries.length,2);
});
