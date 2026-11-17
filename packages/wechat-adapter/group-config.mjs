import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const groupIdentity = value => typeof value === 'string' && /^\d{5,30}@chatroom$/u.test(value);
const accountIdentity = value => typeof value === 'string' && /^account-[A-Za-z0-9_-]{1,100}$/u.test(value);
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''));

/** One account, explicitly authorized groups. Paths cannot be supplied by chat/config. */
export function loadWechatGroups(projectRoot) {
  const root = resolve(projectRoot);
  const configPath = join(root, '.runtime', 'wechat-groups.json');
  const legacyPeoplePath = join(root, '.runtime', 'people', 'group-people.json');
  const data = existsSync(configPath) ? readJson(configPath) : (() => {
    const legacy = readJson(legacyPeoplePath);
    return { schemaVersion: 1, accountId: legacy.accountId, primaryGroupId: legacy.groupId,
      groups: [{ groupId: legacy.groupId, label: '主群' }] };
  })();
  if (!data || data.schemaVersion !== 1 || !accountIdentity(data.accountId) ||
      !groupIdentity(data.primaryGroupId) || !Array.isArray(data.groups) ||
      data.groups.length < 1 || data.groups.length > 10) throw new Error('Invalid authorized group configuration');
  const seen = new Set();
  const groups = data.groups.map(entry => {
    if (!entry || !groupIdentity(entry.groupId) || seen.has(entry.groupId) ||
        Object.keys(entry).some(key => !['groupId', 'label'].includes(key)) ||
        (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80 || /[\u0000-\u001f]/u.test(entry.label)))) {
      throw new Error('Invalid or duplicate authorized group');
    }
    seen.add(entry.groupId);
    const primary = entry.groupId === data.primaryGroupId;
    const instanceKey = createHash('sha256').update(entry.groupId).digest('hex').slice(0, 16);
    const directory = join(root, '.runtime', 'groups', instanceKey);
    return { groupId: entry.groupId, label: entry.label?.trim() ?? entry.groupId,
      participationDbPath: primary ? join(root, '.runtime', 'participation', 'participation.sqlite') : join(directory, 'participation.sqlite'),
      peopleConfigPath: primary ? legacyPeoplePath : join(directory, 'people.json') };
  });
  if (!seen.has(data.primaryGroupId)) throw new Error('Primary group is not authorized');
  // Existing primary state cannot silently become another account/group's data.
  if (existsSync(legacyPeoplePath)) {
    const legacy = readJson(legacyPeoplePath);
    if (legacy.accountId !== data.accountId || legacy.groupId !== data.primaryGroupId) throw new Error('Primary group identity mismatch');
  }
  return { accountId: data.accountId, primaryGroupId: data.primaryGroupId,
    groupIds: groups.map(entry => entry.groupId), groups, configPath };
}

export function additionalParticipationEnvironment(config, groupId, environment = {}) {
  if (groupId === config.primaryGroupId) throw new Error('Primary group uses its existing worker');
  const entry = config.groups.find(item => item.groupId === groupId);
  if (!entry) throw new Error('Group has not been authorized');
  return { ...environment, SOCIOMEM_WECHAT_ACCOUNT_ID: config.accountId,
    SOCIOMEM_WECHAT_GROUPS: groupId, SOCIOMEM_PARTICIPATION_DB: entry.participationDbPath,
    SOCIOMEM_PEOPLE_CONFIG: entry.peopleConfigPath };
}

export function ensureAdditionalPeopleConfig(config, groupId) {
  additionalParticipationEnvironment(config, groupId);
  const path = config.groups.find(item => item.groupId === groupId).peopleConfigPath;
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    try { writeFileSync(path, JSON.stringify({ schemaVersion: 1, accountId: config.accountId, groupId,
      namesByUserId: {}, identitySnapshots: {} }, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const existing = readJson(path);
  if (existing.schemaVersion !== 1 || existing.accountId !== config.accountId || existing.groupId !== groupId) {
    throw new Error('Additional group people identity mismatch');
  }
  return path;
}

export function parseGroupWorkerArgs(args) {
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '--group' || !groupIdentity(args[1])) {
    throw new Error('Use --group with one authorized WeChat group ID');
  }
  return args[1];
}
