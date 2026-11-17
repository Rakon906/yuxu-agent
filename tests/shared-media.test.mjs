import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { normalizeSharedMedia, createSharedMediaEnricher, createFfmpegVideoExtractor, runFfmpeg } from '../packages/shared-media/index.mjs';

const video = Buffer.concat([Buffer.from('000000186674797069736f6d0000020069736f6d69736f32','hex'),Buffer.alloc(32)]);
const sha = createHash('sha256').update(video).digest('hex');
const png = Buffer.from('89504e470d0a1a0a','hex');
const native = { id:'v1', accountId:'a', threadId:'g@chatroom', senderId:'person', direction:'incoming', type:43 };
const message = { accountId:'a', groupId:'g@chatroom', userId:'person', sourceMessageId:'v1', ...normalizeSharedMedia(native) };
const asset = { id:'asset1', accountId:'a', messageId:'v1', kind:'video', variant:'normal', state:'available', byteLength:video.length, sha256:sha };
const description = { summary:'左到右都是游戏界面。', visibleText:'回合结束', safety:'safe', model:'fixture' };
function fixture(t, overrides={}) {
  const cacheDir=mkdtempSync(join(tmpdir(),'shared-media-'));
  t.after(()=>rmSync(cacheDir,{recursive:true,force:true}));
  const calls={vision:0,extract:0,download:0,source:0,requests:[]};
  const client={accountId:'a',message:async id=>{calls.source++;return {...native,id};},
    messageMedia:async()=>({items:[{...asset}]}),
    requestBytes:async(path,options)=>{calls.download++;assert.equal(path,'/media/asset1/content');assert.equal(options.limit,24*1024*1024);return {bytes:video,contentType:'video/mp4'};},
    request:async(path,options)=>{calls.requests.push({path,options});throw Error('unexpected request');},...overrides.client};
  const extract=async()=>{calls.extract++;return {bytes:png,durationMs:2000,frameTimes:[0,1000,1850],audioPath:null};};
  const vision=async()=>{calls.vision++;return description;};
  const config={client,cacheDir,vision,extract,waitAttempts:2,waitDelayMs:0,...overrides};
  config.client=client;
  return {config,calls,client,cacheDir,enrich:createSharedMediaEnricher(config)};
}

test('native link card is untrusted metadata, not fetched article or sender speech',()=>{
  const value=normalizeSharedMedia({type:49,appMessageType:5,link:{title:'官方更新',description:'版本公告摘要',url:'https://example.com/article?a=1',sourceName:'游戏官方'}});
  assert.equal(value.interaction,'share');assert.equal(value.sharedMediaState,'done');
  assert.equal(value.sharedCard.contentFetched,false);assert.match(value.text,/未读取网页全文，不是本人原话/);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:57,link:{title:'嵌入引用'}}),null);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:5,quote:{},link:{title:'引用'}}),null);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:19,link:{title:'转发聊天'}}),null);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:5,recall:true,link:{title:'撤回'}}),null);
});

test('bounded XML compatibility rejects entities, ambiguous subtypes, nesting and executable URLs',()=>{
  const xml='<msg><appmsg><title><![CDATA[更新 & 公告]]></title><des>比赛 &amp; 游戏</des><type>5</type><url>https://example.com/a</url></appmsg></msg>';
  const result=normalizeSharedMedia({type:49,body:xml});assert.equal(result.sharedCard.title,'更新 & 公告');
  assert.equal(result.sharedCard.description,'比赛 & 游戏');
  for(const body of ['<!DOCTYPE msg>'+xml,xml.replace('<type>5</type>','<type>5</type><type>57</type>'),xml.repeat(2),xml.replace('<des>比赛 &amp; 游戏</des>','<des><script>坏</script></des>'),'x'.repeat(65536)+xml])assert.equal(normalizeSharedMedia({type:49,body}),null);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:57,body:xml}),null);
  assert.equal(normalizeSharedMedia({type:49,appMessageType:5,link:{title:'网址',url:'javascript:alert(1)'}}).sharedCard.url,null);
});

test('video analysis persists by scoped content hash and survives restart without another model call',async t=>{
  const f=fixture(t);const first=await f.enrich(message);const restarted=createSharedMediaEnricher(f.config);
  const second=await restarted({...message,sourceMessageId:'v2'}).catch(error=>error);
  assert.match(second.message,/identity mismatch/); // old asset must not be adopted for a new message
  const again=await restarted(message);
  assert.equal(first.videoAnalysis.cached,false);assert.equal(again.videoAnalysis.cached,true);
  assert.equal(f.calls.vision,1);assert.equal(f.calls.extract,1);assert.equal(first.videoSha256,sha);
  assert.match(first.text,/三帧观察与机器转写，不是群友原话/);assert.deepEqual(first.media,[]);
});

test('same video forwarded as a new message reuses meaning but keeps new source binding',async t=>{
  let current='v1';const f=fixture(t,{client:{message:async id=>({...native,id}),messageMedia:async()=>({items:[{...asset,messageId:current}]})}});
  await f.enrich(message);current='v2';const result=await f.enrich({...message,sourceMessageId:'v2'});
  assert.equal(result.sourceMessageId,'v2');assert.equal(result.videoAnalysis.cached,true);assert.equal(f.calls.vision,1);
});

test('source account/group/sender/type and media identity are checked before download',async t=>{
  for(const change of [{accountId:'b'},{threadId:'other@chatroom'},{senderId:'other'},{type:3},{recall:true}]){
    const f=fixture(t,{client:{message:async()=>({...native,...change})}});await assert.rejects(f.enrich(message),/source mismatch/);assert.equal(f.calls.download,0);
  }
  for(const change of [{accountId:'b'},{messageId:'v2'},{byteLength:25*1024*1024}]){
    const f=fixture(t,{client:{messageMedia:async()=>({items:[{...asset,...change}]})}});await assert.rejects(f.enrich(message),/identity mismatch|byte limit/);assert.equal(f.calls.download,0);
  }
  const f=fixture(t);await assert.rejects(f.enrich({...message,groupId:'private'}),/scope mismatch/);
});

test('pending native asset starts bounded same-account download and validates job ownership',async t=>{
  let state='pending';const f=fixture(t,{client:{messageMedia:async()=>({items:[{...asset,state}]}),request:async(path,options)=>{
    if(options.method==='POST'){assert.equal(path,'/messages/v1/media-transfers');assert.deepEqual(options.body,{messageId:'v1',assetId:'asset1',quality:'normal'});return {id:'job1',accountId:'a',threadId:'g@chatroom'};}
    assert.equal(path,'/jobs/job1');state='available';return {id:'job1',accountId:'a',assetId:'asset1',state:'completed'};
  }}});
  assert.equal((await f.enrich(message)).sharedMediaState,'done');
  const bad=fixture(t,{client:{messageMedia:async()=>({items:[{...asset,state:'pending'}]}),request:async()=>({id:'job1',accountId:'other'})}});
  await assert.rejects(bad.enrich(message),/transfer identity mismatch/);assert.equal(bad.calls.vision,0);
});

test('oversized unused original does not block a valid normal variant, but foreign assets still fail',async t=>{
  const original={...asset,id:'original',variant:'original',byteLength:40*1024*1024};
  const f=fixture(t,{client:{messageMedia:async()=>({items:[original,{...asset}]})}});
  assert.equal((await f.enrich(message)).videoAssetId,'asset1');assert.equal(f.calls.vision,1);
  const bad=fixture(t,{client:{messageMedia:async()=>({items:[{...original,accountId:'foreign'},{...asset}]})}});
  await assert.rejects(bad.enrich(message),/identity mismatch/);assert.equal(bad.calls.download,0);
});

test('download quality matches a selected original instead of hard-coding normal',async t=>{
  let state='pending';const original={...asset,variant:'original'};
  const f=fixture(t,{client:{messageMedia:async()=>({items:[{...original,state}]}),request:async(path,options)=>{
    if(options.method==='POST'){assert.equal(options.body.quality,'original');return {id:'job1',accountId:'a'};}
    state='available';return {id:'job1',accountId:'a',assetId:'asset1',state:'completed'};
  }}});
  assert.equal((await f.enrich(message)).sharedMediaState,'done');
});

test('corrupt content and cache never reach the vision model',async t=>{
  const corrupt=fixture(t,{client:{requestBytes:async()=>({bytes:Buffer.alloc(video.length),contentType:'video/mp4'})}});
  await assert.rejects(corrupt.enrich(message),/downloaded video/);assert.equal(corrupt.calls.vision,0);
  const mismatch=fixture(t,{client:{messageMedia:async()=>({items:[{...asset,sha256:'0'.repeat(64)}]})}});
  await assert.rejects(mismatch.enrich(message),/checksum mismatch/);
  const f=fixture(t);await f.enrich(message);const folder=join(f.cacheDir,readdirSync(f.cacheDir)[0]);
  const file=join(folder,`${sha}.json`), record=JSON.parse(readFileSync(file));record.scope='wrong';writeFileSync(file,JSON.stringify(record));
  await assert.rejects(f.enrich(message),/cache mismatch/);assert.equal(f.calls.vision,1);
});

test('concurrent duplicate content is serialized and failed extraction leaves no cached fiction',async t=>{
  const f=fixture(t);await Promise.all([f.enrich(message),f.enrich(message)]);assert.equal(f.calls.vision,1);
  const bad=fixture(t,{extract:async()=>{throw Error('unavailable');}});await assert.rejects(bad.enrich(message),/unavailable/);
  assert.equal(bad.calls.vision,0);assert.deepEqual(readdirSync(join(bad.cacheDir,readdirSync(bad.cacheDir)[0])),[]);
});

test('video transcript is derived evidence and source recall during analysis invalidates the result',async t=>{
  const f=fixture(t,{extract:async()=>({bytes:png,durationMs:2000,frameTimes:[0,1000,1850],audioPath:'fixture.wav'}),transcriber:async()=>({text:'听见了',model:'fixture'})});
  const value=await f.enrich(message);assert.equal(value.videoAnalysis.audioState,'done');assert.match(value.text,/片段声音转写（可能有误）：听见了/);
  let count=0;const recalled=fixture(t,{client:{message:async()=>({...native,recall:++count>1})}});
  await assert.rejects(recalled.enrich(message),/source mismatch/);
  const signal=AbortSignal.abort();await assert.rejects(f.enrich(message,signal));
});

test('ffmpeg bounds argv, timeout/cancellation and stderr without a shell',async()=>{
  let killed=false;
  const spawnProcess=(exe,args,options)=>{assert.equal(exe,'ffmpeg.exe');assert.equal(options.shell,false);assert.equal(options.windowsHide,true);const child=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{killed=true;queueMicrotask(()=>child.emit('close',1));};return child;};
  await assert.rejects(runFfmpeg('ffmpeg.exe',[],{timeoutMs:5,spawnProcess}),/timed out/);assert.equal(killed,true);
  const abort=new AbortController();const pending=runFfmpeg('ffmpeg.exe',[],{signal:abort.signal,spawnProcess});abort.abort();await assert.rejects(pending,/aborted/);
});

test('cancelled vision cannot commit cache or keep the serial queue stuck',async t=>{
  const f=fixture(t,{vision:async()=>new Promise(()=>{})});
  const cancel=new AbortController();
  const first=f.enrich(message,cancel.signal);
  setTimeout(()=>cancel.abort(new Error('cancel fixture')),10);
  await assert.rejects(first,/cancel fixture/);
  const later=AbortSignal.abort();await assert.rejects(f.enrich(message,later));
  const folder=join(f.cacheDir,readdirSync(f.cacheDir)[0]);assert.deepEqual(readdirSync(folder),[]);
});

test('cancelled asynchronous transcription does not commit partial analysis or trap the queue',async t=>{
  const f=fixture(t,{extract:async()=>({bytes:png,durationMs:2000,frameTimes:[0,1000,1850],audioPath:'fixture.wav'}),
    transcriber:async()=>new Promise(()=>{})});
  const cancel=new AbortController();const pending=f.enrich(message,cancel.signal);
  setTimeout(()=>cancel.abort(new Error('cancel asr')),10);await assert.rejects(pending,/cancel asr/);
  const folder=join(f.cacheDir,readdirSync(f.cacheDir)[0]);assert.deepEqual(readdirSync(folder),[]);
});

test('actual project ffmpeg decodes a generated MP4 into three ordered frames and mono audio',async t=>{
  const executable=process.env.SOCIOMEM_FFMPEG_PATH??'';
  if(!existsSync(executable)){t.skip('isolated ffmpeg runtime not installed');return;}
  const dir=mkdtempSync(join(tmpdir(),'shared-media-real-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=join(dir,'fixture.mp4');
  await runFfmpeg(executable,['-hide_banner','-nostdin','-loglevel','error','-f','lavfi','-i','testsrc=size=640x360:rate=12:duration=2','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',file]);
  const result=await createFfmpegVideoExtractor({ffmpegPath:executable})({path:file,directory:dir});
  assert.equal(result.durationMs,2000);assert.deepEqual(result.frameTimes,[0,1000,1850]);assert.ok(result.bytes.length>1000);
  assert.equal(result.bytes.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  const wav=readFileSync(result.audioPath);assert.equal(wav.toString('ascii',0,4),'RIFF');assert.equal(wav.toString('ascii',8,12),'WAVE');assert.ok(wav.length>64000);
});
