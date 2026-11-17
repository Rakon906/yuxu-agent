param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$manifest = Join-Path $root 'native\wechat\packages\native-client-rust\Cargo.toml'
$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if (-not $cargo) { throw 'Install Rust 1.93.1, a C/C++ toolchain and Perl first; see docs/native-build.md.' }
if (-not $env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR = Join-Path $root '.cache\native-target' }
$targetDir = $env:CARGO_TARGET_DIR
Push-Location (Join-Path $root 'native\wechat')
try {
    if ($CheckOnly) { & $cargo.Source check --locked --manifest-path $manifest --bin wx }
    else { & $cargo.Source build --release --locked --manifest-path $manifest --bin wx }
    if ($LASTEXITCODE -ne 0) { throw "Native build failed: $LASTEXITCODE" }
} finally { Pop-Location }
if ($CheckOnly) { exit 0 }
$built = Join-Path $targetDir 'release\wx.exe'
if (-not (Test-Path -LiteralPath $built)) { throw 'Expected native binary was not produced.' }
$destination = Join-Path $root '.tools\agent-wechat\v1.3.2\wx.exe'
$running = @(Get-CimInstance Win32_Process -Filter "Name='wx.exe'" | Where-Object { $_.ExecutablePath -eq $destination })
if ($running.Count) { throw 'This installation is running. Stop its daemon before replacing its executable.' }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
Copy-Item -LiteralPath $built -Destination $destination -Force
$hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
[pscustomobject]@{ engine = 'Yuxu customized native engine'; sha256 = $hash; builtAt = (Get-Date).ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath (Join-Path (Split-Path -Parent $destination) 'build-info.json') -Encoding UTF8
Write-Host "Built local engine: $destination"
Write-Host "SHA-256: $hash"
