$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$supervisorScript = Join-Path $root 'scripts\worker-supervisor.mjs'

$running = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -match [regex]::Escape($supervisorScript) })
if ($running.Count -gt 0) { exit 0 }

$stateDir = Join-Path $root '.runtime\supervisor'
$lock = Join-Path $stateDir 'ensure-supervisor.lock'
if (Test-Path $lock) {
    $age = (Get-Date) - (Get-Item -LiteralPath $lock).LastWriteTime
    if ($age.TotalMinutes -lt 3) { exit 0 }
}
New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
Set-Content -LiteralPath $lock -Value (Get-Date).ToString('o') -Encoding ASCII
$startScript = Join-Path $root 'tools\startup\start-agent.ps1'
Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', $startScript) -WorkingDirectory $root -WindowStyle Hidden
