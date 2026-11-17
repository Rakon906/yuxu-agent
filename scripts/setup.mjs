import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.includes('--help') || !args.length) {
  console.log('node scripts/setup.mjs --account <your-account-id> --group <your-group-id> [--group <another-id>]');
} else {
  let accountId; const ids = [];
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--account' && !accountId) accountId = args[i + 1];
    else if (args[i] === '--group') ids.push(args[i + 1]);
    else throw new Error('Use --account once and --group for each authorized group');
  }
  if (!/^account-[A-Za-z0-9_-]{1,100}$/u.test(accountId ?? '') || !ids.length || ids.length > 10 ||
      !ids.every(id => /^\d{5,30}@chatroom$/u.test(id)) || new Set(ids).size !== ids.length) throw new Error('Invalid account/group IDs');
  const runtime = join(root, '.runtime'), people = join(runtime, 'people');
  const groupsPath = join(runtime, 'wechat-groups.json'), peoplePath = join(people, 'group-people.json');
  if (existsSync(groupsPath) || existsSync(peoplePath)) throw new Error('Local configuration already exists; inspect it before making changes');
  mkdirSync(people, { recursive: true });
  writeFileSync(peoplePath, JSON.stringify({schemaVersion:1,accountId,groupId:ids[0],namesByUserId:{},identitySnapshots:{}},null,2)+'\n', {flag:'wx'});
  writeFileSync(groupsPath, JSON.stringify({schemaVersion:1,accountId,primaryGroupId:ids[0],groups:ids.map((groupId,i)=>({groupId,label:`Group ${i+1}`}))},null,2)+'\n', {flag:'wx'});
  console.log('Created private local configuration. No login or messages were sent.');
}
