import { execFileSync, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  chooseWorkerAction,
  parseManifest,
  repairStaleOwner,
  workerCommandMatches,
  workerDatabasePath,
  workerEnvironment,
  workerKey,
  workerName,
  workerScriptPath,
} from '../packages/supervisor/index.mjs';
import { loadWechatGroups } from '../packages/wechat-adapter/group-config.mjs';
import { projectRoot } from './runtime.mjs';
import { onlineCheckInterval } from '../packages/supervisor/online-check.mjs';

const intervalMs = onlineCheckInterval(process.env.SOCIOMEM_SUPERVISOR_INTERVAL_MS);
const baseDelayMs = Number(process.env.SOCIOMEM_SUPERVISOR_BASE_DELAY_MS ?? 15000);
const maxDelayMs = Number(process.env.SOCIOMEM_SUPERVISOR_MAX_DELAY_MS ?? 300000);
const runtimeDir = join(projectRoot, '.runtime', 'supervisor');
const manifestPath = join(runtimeDir, 'workers.json');
const stopPath = join(runtimeDir, 'stop');
const lockPath = join(runtimeDir, 'supervisor.lock');
const logsDir = join(projectRoot, '.runtime', 'process-logs');
const supervisorScript = join(projectRoot, 'scripts', 'worker-supervisor.mjs');

function log(kind, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), kind, ...details }));
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function listNodeProcesses() {
  const command = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';
  const output = execFileSync('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
  const text = output.replace(/^﻿/u, '').trim();
  const parsed = text ? JSON.parse(text) : [];
  const items = Array.isArray(parsed) ? parsed : [parsed];
  const processes = new Map();
  for (const item of items) {
    if (Number.isInteger(item?.ProcessId) && typeof item.CommandLine === 'string') {
      processes.set(item.ProcessId, item.CommandLine);
    }
  }
  return processes;
}

function readManifest() {
  const text = readFileSync(manifestPath, 'utf8').replace(/^﻿/u, '');
  return parseManifest(JSON.parse(text));
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function acquireLock() {
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(logsDir, { recursive: true });
  if (existsSync(lockPath)) {
    const pid = Number(readFileSync(lockPath, 'utf8').trim());
    if (Number.isSafeInteger(pid) && isPidAlive(pid)) {
      let commandLine = null;
      try { commandLine = listNodeProcesses().get(pid) ?? null; }
      catch { /* unknown: do not risk a second supervisor */ }
      if (commandLine === null || workerCommandMatches(commandLine, supervisorScript)) {
        log('already_running', { pid });
        return false;
      }
    }
    unlinkSync(lockPath);
  }
  const fd = openSync(lockPath, 'wx');
  writeSync(fd, `${process.pid}\n`);
  closeSync(fd);
  return true;
}

function releaseLock() {
  try {
    if (existsSync(lockPath) && readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
      unlinkSync(lockPath);
    }
  } catch { /* best effort */ }
}

function repairOwner(worker, processes, now, config) {
  const db = workerDatabasePath(projectRoot, worker, config);
  if (!db) return;
  const result = repairStaleOwner({
    lockPath: `${db}.owner`,
    scriptPath: workerScriptPath(projectRoot, worker),
    processes,
    backupDir: logsDir,
    now,
  });
  if (result.removed) log('owner.repaired', { worker: workerKey(worker), reason: result.reason, pid: result.pid ?? null });
  if (result.reason === 'live') throw new Error(`Worker database still has a live owner: ${workerKey(worker)}`);
}

function spawnWorker(worker, config) {
  const scriptPath = workerScriptPath(projectRoot, worker);
  if (!existsSync(scriptPath)) throw new Error(`Worker script missing: ${workerName(worker)}`);
  const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
  const slug = workerName(worker).replace(/\.mjs$/u, '') +
    (typeof worker === 'string' ? '' : `-${worker.groupId.replace(/[^a-zA-Z0-9_-]/gu, '-')}`);
  const out = join(logsDir, `${slug}-${stamp}.out.log`);
  const err = join(logsDir, `${slug}-${stamp}.err.log`);
  const outFd = openSync(out, 'a');
  const errFd = openSync(err, 'a');
  try {
    const arguments_ = typeof worker === 'string' ? [scriptPath] : [scriptPath, '--group', worker.groupId];
    const child = spawn(process.execPath, arguments_, {
      cwd: projectRoot,
      env: workerEnvironment(worker, config),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
    child.unref();
    return { pid: child.pid, out };
  } finally {
    closeSync(outFd);
    closeSync(errFd);
  }
}

async function main() {
  if (!acquireLock()) return;
  let stopping = false;
  const stop = () => { stopping = true; };
  const waitForNextCheck = async () => {
    const until = Date.now() + intervalMs;
    while (!stopping && !existsSync(stopPath) && Date.now() < until) {
      await sleep(Math.min(5000, until - Date.now()));
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const state = new Map();
  let lastHeartbeat = Date.now();
  try {
    log('ready', { pid: process.pid, intervalMs, manifestPath });
    while (!stopping) {
      if (existsSync(stopPath)) {
        log('stopped', { reason: 'stop_file' });
        break;
      }
      let manifest, config;
      try {
        manifest = readManifest();
        config = loadWechatGroups(projectRoot);
        // Validate all configured instances before repairing any lock or starting a worker.
        for (const worker of manifest) workerEnvironment(worker, config);
      }
      catch (error) {
        log('manifest_error', { errorType: error.name, message: error.message });
        await waitForNextCheck();
        continue;
      }
      let processes;
      try { processes = listNodeProcesses(); }
      catch (error) {
        log('scan_error', { errorType: error.name, message: error.message });
        await waitForNextCheck();
        continue;
      }
      const running = new Set();
      for (const worker of manifest) {
        const scriptPath = workerScriptPath(projectRoot, worker);
        for (const commandLine of processes.values()) {
          if (workerCommandMatches(commandLine, scriptPath, worker.groupId)) { running.add(workerKey(worker)); break; }
        }
      }
      const now = Date.now();
      for (const worker of manifest) {
        const key = workerKey(worker);
        const current = state.get(key) ?? { attempts: 0, nextAttemptAt: 0 };
        const decision = chooseWorkerAction({ running: running.has(key), ...current, now, baseDelayMs, maxDelayMs });
        state.set(key, decision.nextState);
        if (decision.action !== 'restart') continue;
        try {
          repairOwner(worker, processes, now, config);
          const started = spawnWorker(worker, config);
          log('worker.restart', { worker: key, pid: started.pid, log: started.out });
        } catch (error) {
          log('worker.restart_failed', { worker: key, errorType: error.name, message: error.message });
        }
      }
      if (now - lastHeartbeat >= intervalMs) {
        lastHeartbeat = now;
        log('alive', { workers: manifest, running: [...running] });
      }
      await waitForNextCheck();
    }
  } finally {
    log('stopped', { reason: stopping ? 'signal' : 'exit' });
    releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
