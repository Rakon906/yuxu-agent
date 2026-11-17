import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadWechatGroups, additionalParticipationEnvironment, ensureAdditionalPeopleConfig,
  parseGroupWorkerArgs } from '../packages/wechat-adapter/group-config.mjs';
import { loadPeopleConfig } from '../packages/people/index.mjs';

const primary='111111@chatroom', extra='222222@chatroom', accountId='account-fixture';
function fixture() {
  const base=fileURLToPath(new URL('../.runtime/test-tmp/',import.meta.url));mkdirSync(base,{recursive:true});
  const root=mkdtempSync(join(base,'groups-'));mkdirSync(join(root,'.runtime/people'),{recursive:true});
  writeFileSync(join(root,'.runtime/people/group-people.json'),JSON.stringify({schemaVersion:1,accountId,groupId:primary,namesByUserId:{},identitySnapshots:{}}));
  const data={schemaVersion:1,accountId,primaryGroupId:primary,groups:[{groupId:primary},{groupId:extra,label:'测试群'}]};
  const save=(value=data)=>writeFileSync(join(root,'.runtime/wechat-groups.json'),JSON.stringify(value));
  return {root,data,save};
}
test('legacy configuration retains original primary DB and one group',()=>{
  const f=fixture(),config=loadWechatGroups(f.root);
  assert.deepEqual(config.groupIds,[primary]);
  assert.equal(config.groups[0].participationDbPath,join(f.root,'.runtime/participation/participation.sqlite'));
});
test('additional groups have deterministic distinct ledger and empty scoped people data',()=>{
  const f=fixture();f.save();const c=loadWechatGroups(f.root),base={SOCIOMEM_WECHAT_GROUPS:primary,UNCHANGED:'yes'};
  const e=additionalParticipationEnvironment(c,extra,base);
  assert.equal(e.SOCIOMEM_WECHAT_GROUPS,extra);assert.equal(base.SOCIOMEM_WECHAT_GROUPS,primary);
  assert.equal(e.UNCHANGED,'yes');assert.notEqual(e.SOCIOMEM_PARTICIPATION_DB,c.groups[0].participationDbPath);
  const path=ensureAdditionalPeopleConfig(c,extra);const profile=loadPeopleConfig(path,accountId,extra);
  assert.equal(profile.names.size,0);assert.throws(()=>loadPeopleConfig(path,accountId,primary),/outside/);
  const text=readFileSync(path,'utf8');ensureAdditionalPeopleConfig(c,extra);assert.equal(readFileSync(path,'utf8'),text);
  assert.deepEqual(loadWechatGroups(f.root),c);
});
test('unknown groups, duplicate IDs, paths, account switches and primary switches are rejected',()=>{
  const f=fixture();f.save();const c=loadWechatGroups(f.root);
  assert.throws(()=>additionalParticipationEnvironment(c,'333333@chatroom'),/not been authorized/);
  assert.throws(()=>additionalParticipationEnvironment(c,primary),/existing worker/);
  for(const change of [x=>x.groups.push({groupId:extra}),x=>x.groups[1].groupId='../evil',
    x=>x.groups[1].participationDb='C:/elsewhere.sqlite',x=>x.accountId='account-other',x=>x.primaryGroupId=extra,
    x=>x.groups[1].groupId='friend-wxid']) {
    const value=structuredClone(f.data);change(value);f.save(value);assert.throws(()=>loadWechatGroups(f.root));
  }
});
test('wrapper parser never accepts extra arguments or primary fallback',()=>{
  assert.equal(parseGroupWorkerArgs(['--group',extra]),extra);
  for(const args of [[],['--group'],['--group',extra,'--once'],['--group','friend'],['--eval','evil']])assert.throws(()=>parseGroupWorkerArgs(args));
});
test('existing extra people data cannot be silently overwritten across scopes',()=>{
  const f=fixture();f.save();const c=loadWechatGroups(f.root);const p=ensureAdditionalPeopleConfig(c,extra);
  const wrong={schemaVersion:1,accountId,groupId:primary,namesByUserId:{},identitySnapshots:{}};
  writeFileSync(p,JSON.stringify(wrong));assert.throws(()=>ensureAdditionalPeopleConfig(c,extra),/mismatch/);
  assert.deepEqual(JSON.parse(readFileSync(p,'utf8')),wrong);
});
