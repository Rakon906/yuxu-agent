# Dot-source from an installed Node.js 24 environment.
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { throw 'Install Node.js 24 and reopen your terminal.' }
$env:Path = "$(Join-Path $projectRoot 'node_modules\.bin');$env:Path"
$env:npm_config_cache = Join-Path $projectRoot '.cache\npm'
$env:PNPM_HOME = Join-Path $projectRoot '.tools\pnpm'
$env:PNPM_STORE_DIR = Join-Path $projectRoot '.cache\pnpm-store'
$env:COREPACK_HOME = Join-Path $projectRoot '.cache\corepack'
$env:DSH_HOME = Join-Path $projectRoot '.runtime\harness'
$env:TEMP = Join-Path $projectRoot 'work\tmp'
$env:TMP = $env:TEMP
[void][System.IO.Directory]::CreateDirectory($env:TEMP)
Write-Host "Yuxu environment: $projectRoot"
node --version
npm.cmd --version
