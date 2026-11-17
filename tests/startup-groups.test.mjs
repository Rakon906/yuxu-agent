import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const startup = fileURLToPath(new URL('../tools/startup/start-agent.ps1', import.meta.url));
const literal = value => `'${value.replaceAll("'", "''")}'`;
function powershell(code) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(code, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  return JSON.parse(result.stdout.replace(/^\uFEFF/u, '').trim());
}

const loadFunctions = String.raw`
  $ErrorActionPreference = 'Stop'
  $errors = $null; $tokens = $null
  $tree = [System.Management.Automation.Language.Parser]::ParseFile(${literal(startup)}, [ref]$tokens, [ref]$errors)
  if ($errors.Count) { throw ($errors | Out-String) }
  foreach ($name in @('Test-NodeWorkerCommand', 'Start-NodeWorker', 'Ensure-WeChat')) {
    $definition = $tree.Find({ param($item)
      $item -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $item.Name -eq $name
    }, $true)
    if (-not $definition) { throw "Missing startup function: $name" }
    Invoke-Expression $definition.Extent.Text
  }
`;

test('Windows startup distinguishes exact script and group tokens without running startup', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(loadFunctions + String.raw`
    $root = 'E:\fixture with spaces'
    @(
      (Test-NodeWorkerCommand 'node.exe "E:\fixture with spaces\scripts\participation-worker.mjs"' 'participation-worker.mjs'),
      (Test-NodeWorkerCommand 'node.exe "E:\fixture with spaces\scripts\participation-worker.mjs.backup"' 'participation-worker.mjs'),
      (Test-NodeWorkerCommand 'node.exe "E:/fixture with spaces/scripts/group-participation-worker.mjs" --group "22222@chatroom"' 'group-participation-worker.mjs' '22222@chatroom'),
      (Test-NodeWorkerCommand 'node.exe "E:\fixture with spaces\scripts\group-participation-worker.mjs" --group 22222@chatroom' 'group-participation-worker.mjs' '33333@chatroom'),
      (Test-NodeWorkerCommand 'node.exe "E:\fixture with spaces\scripts\group-participation-worker.mjs" --group 22222@chatroom --once' 'group-participation-worker.mjs' '22222@chatroom')
    ) | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, [true, false, true, false, false]);
});

test('public startup accepts its own extended Windows path and rejects a different daemon', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(loadFunctions + String.raw`
    $wxData = 'E:\fixture\.runtime\agent-wechat'
    $script:actualDir = '\\?\' + $wxData
    function Get-WxStatus { [pscustomobject]@{ state='ready'; dataDir=$script:actualDir } }
    function Get-Account { [pscustomobject]@{ authenticated=$true; connection='online' } }
    Ensure-WeChat
    $script:actualDir = 'E:\another-installation\.runtime\agent-wechat'
    $rejected = $false
    try { Ensure-WeChat } catch { $rejected = $_.Exception.Message -match 'Another WeChat data directory' }
    [pscustomobject]@{ ownAccepted=$true; foreignRejected=$rejected } | ConvertTo-Json -Compress
  `);
  assert.equal(result.ownAccepted, true);
  assert.equal(result.foreignRejected, true);
});

test('Windows startup sends one capture and diary both groups and isolates each participation process', { skip: process.platform !== 'win32' }, () => {
  const result = powershell(loadFunctions + String.raw`
    $root = 'E:\fixture with spaces'; $node = 'E:\fixture with spaces\node.exe'; $logs = 'E:\fixture with spaces\logs'
    $group = '11111@chatroom'
    $groupConfig = [pscustomobject]@{ groupIds = @('11111@chatroom', '22222@chatroom'); groups = @(
      [pscustomobject]@{ groupId = '11111@chatroom'; participationDbPath = 'E:\fixture with spaces\.runtime\participation\participation.sqlite' },
      [pscustomobject]@{ groupId = '22222@chatroom'; participationDbPath = 'E:\fixture with spaces\.runtime\groups\second\participation.sqlite' }
    ) }
    $env:SOCIOMEM_WECHAT_GROUPS = 'inherited@chatroom'
    $script:started = @(); $script:owners = @()
    function Find-NodeWorker { param($scriptName, $groupId) @() }
    function Repair-StaleOwner { param($dbPath, $scriptName) $script:owners += $dbPath }
    function Write-Status { param($message) }
    function Start-Sleep { param($Milliseconds) }
    function Test-Path { param($LiteralPath) $true }
    function Get-Content { param($LiteralPath, $Tail, $ErrorAction) '{"kind":"ready"}' }
    function Start-Process {
      param($FilePath, $ArgumentList, $WorkingDirectory, $WindowStyle, $RedirectStandardOutput, $RedirectStandardError, [switch]$PassThru)
      $script:started += [pscustomobject]@{ arguments = @($ArgumentList); groups = $env:SOCIOMEM_WECHAT_GROUPS }
      [pscustomobject]@{ HasExited = $false; Id = 123 }
    }
    Start-NodeWorker 'watch-wechat-capture.mjs' 'capture' | Out-Null
    Start-NodeWorker 'participation-worker.mjs' 'primary' | Out-Null
    Start-NodeWorker 'group-participation-worker.mjs' 'additional' '22222@chatroom' | Out-Null
    Start-NodeWorker 'diary-worker.mjs' 'diary' | Out-Null
    Start-NodeWorker 'moments-worker.mjs' 'moments' | Out-Null
    [pscustomobject]@{ started = $script:started; owners = $script:owners; inherited = $env:SOCIOMEM_WECHAT_GROUPS } | ConvertTo-Json -Depth 6 -Compress
  `);
  assert.deepEqual(result.started.map(item => item.groups), [
    '11111@chatroom,22222@chatroom', '11111@chatroom', '22222@chatroom',
    '11111@chatroom,22222@chatroom', '11111@chatroom',
  ]);
  assert.deepEqual(result.started[2].arguments,
    ['"E:\\fixture with spaces\\scripts\\group-participation-worker.mjs"', '--group', '22222@chatroom']);
  assert.equal(result.owners[2], 'E:\\fixture with spaces\\.runtime\\groups\\second\\participation.sqlite');
  assert.equal(result.inherited, 'inherited@chatroom');
});
