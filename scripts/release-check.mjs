import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
if (resolve(git('rev-parse', '--show-toplevel').trim()) !== resolve(root)) {
  throw new Error('Run the check in the independent Yuxu repository.');
}
const files = [...new Set(git('ls-files', '--cached', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean))];
const forbidden = /(?:^|\/)(?:\.runtime|\.cache|\.tools|\.change-audit-backups|node_modules|target|research-sticker[^/]*)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]+)?$|\.(?:exe|dll|pdb|sqlite|sqlite-wal|sqlite-shm|gbf|pem|pfx|p12|key)$/iu;
const patterns = [
  ['api_key', /\b(?:sk-[A-Za-z0-9_-]{24,}|gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/gu],
  ['private_key', /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/gu],
  ['cookie_literal', /\b(?:BDUSS|z_c0|SUBP|SCF)\s*[:=]\s*["']?[A-Za-z0-9_%+./=-]{30,}/gu],
  ['personal_email', /[A-Za-z0-9._%+-]+@(?:qq|163|gmail|outlook)\.com/giu],
  ['wechat_identity', /\b(?:wxid_[a-z0-9]{12,}|account-\d{12,}|\d{10,}@chatroom)\b/gu],
  ['personal_windows_path', /C:[\\/]+Users[\\/]+(?!example\b|fixture\b|test\b|Public\b)[A-Za-z0-9_.-]+/giu],
];
const findings = [];
for (const path of files) {
  if (path !== '.env.example' && forbidden.test(path)) findings.push({ path, kind: 'excluded_path' });
  const bytes = readFileSync(new URL(path, new URL('../', import.meta.url)));
  if (bytes.length > 8 * 1024 * 1024) { findings.push({ path, kind: 'oversize_review_required' }); continue; }
  if (bytes.subarray(0, 8192).includes(0)) continue; // Upstream binary test fixtures require separate provenance review.
  const text = bytes.toString('utf8');
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) findings.push({ path, kind, line: text.slice(0, match.index).split('\n').length });
  }
}
console.log(JSON.stringify({ checkedFiles: files.length, findings, note: 'Locations only. Also review history, fixture provenance and release archives.' }, null, 2));
if (findings.length) process.exitCode = 1;
