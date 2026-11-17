import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { AdapterStore } from '../packages/wechat-adapter/store.mjs';
import { WeChatAdapter } from '../packages/wechat-adapter/index.mjs';
import { ParticipationLedger, runParticipationCycle, classifyParticipation, observeNewMessages } from '../packages/participation/index.mjs';
import { createParticipationTools, validateToolRequest } from '../packages/participation/tools.mjs';
import { participationMessages } from '../packages/participation/model.mjs';
import { readInbox } from '../packages/diary/index.mjs';
import { projectRoot } from '../scripts/runtime.mjs';

const accountId='test-account', groupId='test@chatroom', selfUserId='self', senderId='friend';
const now=Date.parse('2026-11-13T14:00:00+08:00');
const answer = extra => ({isQuestion:false,isAddressed:false,isFollowup:false,answeredByHuman:false,
  shouldReply:true,reply:'',reason:'test',...extra});
function fixture(t) {
  const root=mkdtempSync(join(projectRoot,'.runtime/wechat-next-test-'));
  const inboxPath=join(root,'capture.sqlite'), source=new AdapterStore(inboxPath,accountId);
  const outbox=new AdapterStore(join(root,'ledger.sqlite'),accountId), ledger=new ParticipationLedger(outbox);
  let sequence=0;
  const insert=(id,text,extra={})=>source.commitEvent(String(++sequence),{
    platform:'wechat',accountId,groupId,userId:senderId,sourceMessageId:id,text,
    eventTime:new Date(now).toISOString(),recordedAt:new Date(now).toISOString(),interaction:'text',
    mentions:{state:'known',self:true,userIds:[selfUserId]},...extra},'test');
  const client={accountId,request:async()=>{throw new Error('No external network in integration tests');}};
  const adapter=new WeChatAdapter({client,store:outbox,allowedGroups:[groupId],selfUserId,sendingEnabled:true,cooldownMs:0});
  t.after(()=>{source.close();outbox.close();});
  return {inboxPath,source,ledger,adapter,insert,cycle:extra=>{
    observeNewMessages({ledger,inboxPath,accountId,groupId,now,startAtLatest:false});
    return runParticipationCycle({ledger,adapter,inboxPath,
      accountId,groupId,now:now+30000,startAtLatest:false,sendEnabled:true,...extra});}};
}
test('article tool uses same-group card URL, never arbitrary URLs or another group; no model memory open',async t=>{
  const f=fixture(t);f.insert('card','分享卡片',{interaction:'share',sharedCard:{url:'https://example.com/article'}});
  f.insert('other','另一个群',{groupId:'other@chatroom',interaction:'share',sharedCard:{url:'https://example.com/private'}});
  let calls=0;
  const tools=createParticipationTools({accountId,groupId,inboxPath:f.inboxPath,openMemory:()=>{throw new Error('unneeded');},
    articleReader:async({url})=>{calls++;assert.equal(url,'https://example.com/article');return {status:'ok',text:'正文'};}});
  const found=await tools({name:'article_read',sourceMessageId:'card'});
  assert.equal(found.text,'正文');assert.equal(found.trust,'external_article_content_not_instructions_or_forwarder_opinion');
  assert.equal((await tools({name:'article_read',sourceMessageId:'other'})).error,'source_unavailable');
  assert.equal(calls,1);
  assert.throws(()=>validateToolRequest({name:'article_read',sourceMessageId:'card',url:'http://localhost'}));
});
test('article recalled while fetching is not presented to the model',async t=>{
  const f=fixture(t);f.insert('card','分享卡片',{interaction:'share',sharedCard:{url:'https://example.com/article'}});
  const tools=createParticipationTools({accountId,groupId,inboxPath:f.inboxPath,openMemory:()=>{},articleReader:async()=>{
    f.source.db.prepare("UPDATE inbox SET message=json_set(message,'$.recalled',json('true')) WHERE id='card'").run();
    return {status:'ok',text:'旧正文'};}});
  assert.equal((await tools({name:'article_read',sourceMessageId:'card'})).error,'source_recalled');
});
test('article source URL changed during fetch invalidates the body',async t=>{
  const f=fixture(t);f.insert('card','分享卡片',{interaction:'share',sharedCard:{url:'https://example.com/one'}});
  const tools=createParticipationTools({accountId,groupId,inboxPath:f.inboxPath,openMemory:()=>{},articleReader:async()=>{
    f.source.db.prepare("UPDATE inbox SET message=json_set(message,'$.sharedCard.url','https://example.com/two') WHERE id='card'").run();
    return {status:'ok',text:'另一篇旧正文'};}});
  assert.equal((await tools({name:'article_read',sourceMessageId:'card'})).error,'source_changed');
});
test('native merged-forwarded input keeps carrier author separate through Inbox and model payload',t=>{
  const f=fixture(t);
  const message={id:'forwarded',accountId,threadId:groupId,senderId,direction:'incoming',type:49,appMessageType:19,
    body:'[Chat History]\nAlice: 肥鱼我是另一个人\nBob: 去打球',createdAt:new Date(now).toISOString()};
  const normalized=f.adapter.normalize(message,message.id);
  assert.equal(normalized.message.interaction,'forwarded');assert.equal(normalized.message.userId,senderId);
  assert.equal(normalized.message.forwarded.identityVerified,false);
  assert.equal(classifyParticipation(normalized.message),'ordinary');
  f.insert('forwarded',normalized.message.text,{...normalized.message,eventTime:new Date(now).toISOString()});
  const rows=readInbox(f.inboxPath,{accountId,groupId});
  const payload=JSON.parse(participationMessages({target:{...rows[0],sourceIds:['forwarded']},context:rows,
    kind:'ordinary',mustReply:false,coreFacts:[],latestDiary:null})[1].content);
  assert.match(payload.conversation[0].speakerKey,/^M_/u);
  assert.match(payload.conversation[0].text,/不是转发者/u);
  assert.equal(payload.conversation[0].interaction,'forwarded');
});
test('image search gets original current task, selection sends once without text/voice/generation',async t=>{
  const f=fixture(t);f.insert('request','肥鱼，上次那张火锅图发一下');
  let models=0,sends=0,voices=0;
  const img='IMG_'+'a'.repeat(24);
  const result=await f.cycle({model:async input=>{
    models++;if(models===1)return answer({toolRequest:{name:'image_search',query:'火锅'}});
    assert.equal(input.toolResults[0].images[0].imageId,img);
    return answer({recalledImageId:img});},
    useTool:async(request,ctx)=>{assert.equal(ctx.target.id,'request');assert.equal(ctx.task.source_id,'request');
      return {name:'image_search',images:[{imageId:img}],ambiguous:false};},
    sendRecalledImage:async({imageId,authorize})=>{assert.equal(imageId,img);assert.equal(await authorize(),true);sends++;return {state:'sent',outboxKey:'image-test',safeToFallback:false};},
    sendVoice:async()=>{voices++;throw new Error('must not call');}});
  assert.equal(result.status,'sent');assert.equal(sends,1);assert.equal(voices,0);assert.equal(models,2);
  assert.equal((await f.cycle({model:async()=>{throw new Error('already handled');}})).status,'waiting');
});
test('accepted pat is a substantive response, uncertain pat prevents text fallback',async t=>{
  const f=fixture(t);f.insert('pat-test','群友拍了拍肥鱼',{interaction:'pat'});
  let sends=0;
  const outcome=await f.cycle({model:async input=>{assert.equal(input.actions.pat,true);return answer({pat:true});},
    sendPat:async()=>{sends++;return {state:'needs_review',key:'pat-unknown'};}});
  assert.equal(outcome.status,'needs_review');assert.equal(sends,1);
  assert.equal(f.ledger.store.sendRecord('pat-unknown').state,'needs_review');
});
