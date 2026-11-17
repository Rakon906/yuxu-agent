import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.platform !== 'win32') throw new Error('The complete Yuxu launcher currently targets Windows; see docs/native-build.md.');
if (process.argv.length !== 2) throw new Error('This release builds its customized engine from source.');
const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(new URL('../tools/build-native.ps1', import.meta.url));
const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
