$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
& (Join-Path $root 'tools\wechat-start\build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'WeChat launcher build failed.' }
& (Join-Path $root 'tools\startup\build.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Agent launcher build failed.' }
