import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

function hasMomentsCapability(version) {
  const capabilities = Array.isArray(version?.capabilities) ? version.capabilities : [];
  return capabilities.some(value => /moment|sns|timeline/iu.test(String(value)));
}

function inspectProfileFiles(inspect) {
  const databases = Array.isArray(inspect?.databases) ? inspect.databases : [];
  const matches = databases.filter(item => /sns|moment|timeline|circle/iu.test(String(item.relativePath ?? '')));
  return { databaseCount: databases.length, momentDatabaseCandidates: matches };
}

async function scanProfileRoot(root, depth = 0, files = []) {
  if (!root || depth > 8 || files.length > 4096) return files;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch { return files; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) await scanProfileRoot(path, depth + 1, files);
    else if (entry.isFile() && /\.db(?:-wal|-shm)?$/iu.test(entry.name)) files.push(path);
  }
  return files;
}

export async function probeNativeMoments({ wxPath, dataDir, localProfile = null, profileRoot = null, timeoutMs = 10000, runner = execFileAsync }) {
  if (typeof wxPath !== 'string' || !wxPath) throw new Error('wxPath is required');
  if (typeof dataDir !== 'string' || !dataDir) throw new Error('dataDir is required');
  const base = ['--json', '--data-dir', dataDir];
  const versionResult = await runner(wxPath, [...base, 'version'], { timeout: timeoutMs, windowsHide: true });
  const version = parseJson(versionResult.stdout, 'wx version');
  let profileList;
  try {
    const result = await runner(wxPath, [...base, 'profile', 'list'], { timeout: timeoutMs, windowsHide: true });
    profileList = parseJson(result.stdout, 'wx profile list');
  } catch (error) {
    profileList = { state: 'unavailable', error: error.message };
  }
  let profileInspect = null;
  if (localProfile) {
    try {
      const result = await runner(wxPath, [...base, '--local-profile', localProfile, 'profile', 'inspect'], { timeout: timeoutMs, windowsHide: true });
      profileInspect = parseJson(result.stdout, 'wx profile inspect');
    } catch (error) {
      profileInspect = { state: 'unavailable', error: error.message };
    }
  }
  const capability = hasMomentsCapability(version);
  const profileEvidence = profileInspect ? inspectProfileFiles(profileInspect) : null;
  const profileFiles = profileRoot ? await scanProfileRoot(profileRoot) : [];
  const localMomentCandidates = profileFiles.filter(path => /sns|moment|timeline|circle/iu.test(path));
  return {
    state: capability ? 'capability_declared' : profileEvidence?.momentDatabaseCandidates?.length || localMomentCandidates.length ? 'profile_only' : 'unsupported',
    read: capability || Boolean(profileEvidence?.momentDatabaseCandidates?.length) || localMomentCandidates.length > 0,
    publish: capability,
    evidence: {
      product: version.product ?? null,
      version: version.version ?? null,
      capabilities: version.capabilities ?? [],
      profileList,
      profileInspect,
      profileDatabaseSummary: profileEvidence,
      localProfileFiles: profileRoot ? profileFiles.map(path => relative(profileRoot, path)) : null,
      localMomentDatabaseCandidates: profileRoot ? localMomentCandidates.map(path => relative(profileRoot, path)) : null,
    },
  };
}
