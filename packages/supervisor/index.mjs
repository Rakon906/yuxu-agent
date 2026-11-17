import { createHash, randomUUID } from 'node:crypto';
import { constants, copyFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

export const SUPERVISED_WORKERS = new Set([
  'watch-wechat-capture.mjs',
  'participation-worker.mjs',
  'group-participation-worker.mjs',
  'diary-worker.mjs',
  'moments-worker.mjs',
  'moments-publish-worker.mjs',
  'trends-worker.mjs',
]);

const WORKER_NAME = /^[a-z0-9-]+\.mjs$/u;
const GROUP_ID = /^\d{5,30}@chatroom$/u;
const GROUP_WORKER = 'group-participation-worker.mjs';

export function workerName(worker) {
  return typeof worker === 'string' ? worker : worker?.script;
}

export function workerKey(worker) {
  return typeof worker === 'string' ? worker : `${worker.script}:${worker.groupId}`;
}

export function parseManifest(value) {
  const workers = value?.workers;
  if (!Array.isArray(workers) || workers.length === 0 || workers.length > 256) {
    throw new Error('Invalid supervisor manifest');
  }
  const result = [];
  const keys = new Set();
  for (const worker of workers) {
    const name = workerName(worker);
    if (typeof name !== 'string' || !WORKER_NAME.test(name) || !SUPERVISED_WORKERS.has(name)) {
      throw new Error(`Unknown supervised worker: ${String(name)}`);
    }
    if (typeof worker !== 'string') {
      if (!worker || Array.isArray(worker) || name !== GROUP_WORKER ||
          Object.keys(worker).some(key => !['script', 'groupId'].includes(key)) ||
          typeof worker.groupId !== 'string' || !GROUP_ID.test(worker.groupId)) {
        throw new Error('Invalid group worker instance');
      }
    } else if (name === GROUP_WORKER) {
      throw new Error('Group worker requires an authorized group instance');
    }
    const key = workerKey(worker);
    if (!keys.has(key)) {
      result.push(typeof worker === 'string' ? worker : { script: name, groupId: worker.groupId });
      keys.add(key);
    }
  }
  return result;
}

export function workerScriptPath(projectRoot, worker) {
  const name = workerName(worker);
  if (!WORKER_NAME.test(name) || !SUPERVISED_WORKERS.has(name)) throw new Error('Unknown supervised worker');
  return join(projectRoot, 'scripts', name);
}

export function workerCommandMatches(commandLine, scriptPath, groupId) {
  if (typeof commandLine !== 'string') return false;
  const normalize = value => value.replaceAll('/', '\\').toLowerCase();
  const tokens = [...commandLine.matchAll(/"([^"]*)"|(\S+)/gu)].map(match => match[1] ?? match[2]);
  const scriptIndex = tokens.findIndex(token => normalize(token) === normalize(scriptPath));
  if (scriptIndex < 0) return false;
  if (groupId === undefined) return true;
  const arguments_ = tokens.slice(scriptIndex + 1);
  return arguments_.length === 2 && arguments_[0] === '--group' && arguments_[1] === groupId;
}

export function workerEnvironment(worker, config, baseEnv = process.env) {
  const name = workerName(worker);
  let groupIds = [config.primaryGroupId];
  if (name === 'watch-wechat-capture.mjs' || name === 'diary-worker.mjs') groupIds = config.groupIds;
  if (name === GROUP_WORKER) {
    if (!config.groups.some(group => group.groupId === worker.groupId) || worker.groupId === config.primaryGroupId) {
      throw new Error('Group worker is not an authorized additional group');
    }
    groupIds = [worker.groupId];
  }
  return { ...baseEnv, SOCIOMEM_WECHAT_ACCOUNT_ID: config.accountId,
    SOCIOMEM_WECHAT_GROUPS: groupIds.join(',') };
}

export function workerDatabasePath(projectRoot, worker, config) {
  const name = workerName(worker);
  if (name === GROUP_WORKER) {
    const group = config.groups.find(item => item.groupId === worker.groupId);
    if (!group || group.groupId === config.primaryGroupId) throw new Error('Group worker is not an authorized additional group');
    return group.participationDbPath;
  }
  const paths = {
    'moments-publish-worker.mjs': ['moments', 'publishing.sqlite'],
    'watch-wechat-capture.mjs': ['wechat-adapter', 'sociomem.sqlite'],
    'participation-worker.mjs': ['participation', 'participation.sqlite'],
    'diary-worker.mjs': ['diary', 'diary.sqlite'],
  };
  return paths[name] ? join(projectRoot, '.runtime', ...paths[name]) : null;
}

function retryDelay(attempts, baseDelayMs, maxDelayMs) {
  return Math.min(baseDelayMs * 2 ** Math.min(Math.max(attempts - 1, 0), 5), maxDelayMs);
}

/**
 * State: attempts counts consecutive starts that have not yet been observed
 * running; nextAttemptAt is a unix-ms timestamp.
 */
export function chooseWorkerAction({ running = false, attempts = 0, nextAttemptAt = 0,
  now = Date.now(), baseDelayMs = 15000, maxDelayMs = 300000 } = {}) {
  if (running) return { action: 'none', nextState: { attempts: 0, nextAttemptAt: 0 } };
  if (nextAttemptAt > now) return { action: 'wait', nextState: { attempts, nextAttemptAt } };
  const nextAttempts = attempts + 1;
  return {
    action: 'restart',
    nextState: { attempts: nextAttempts,
      nextAttemptAt: now + retryDelay(nextAttempts, baseDelayMs, maxDelayMs) },
  };
}

export function repairStaleOwner({ lockPath, scriptPath, processes, backupDir, now = Date.now() }) {
  if (!existsSync(lockPath)) return { removed: false, reason: 'missing' };
  const raw = readFileSync(lockPath, 'utf8').trim();
  const pid = Number(raw);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    backupAndRemove(lockPath, backupDir, now);
    return { removed: true, reason: 'invalid' };
  }
  const commandLine = processes?.get(pid);
  if (commandLine && workerCommandMatches(commandLine, scriptPath)) {
    return { removed: false, reason: 'live' };
  }
  backupAndRemove(lockPath, backupDir, now);
  return { removed: true, reason: 'stale', pid };
}

function backupAndRemove(lockPath, backupDir, now) {
  const stamp = new Date(now).toISOString().replace(/[:.]/gu, '-');
  const instance = createHash('sha256').update(lockPath).digest('hex').slice(0, 16);
  copyFileSync(lockPath, join(backupDir, `stale-owner-${stamp}-${instance}-${randomUUID().slice(0, 8)}-${basename(lockPath)}.txt`), constants.COPYFILE_EXCL);
  unlinkSync(lockPath);
}
