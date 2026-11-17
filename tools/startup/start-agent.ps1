param([switch]$Check)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location -LiteralPath $root
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $nodeCommand) { throw 'Install Node.js 24 and open a new terminal first.' }
$node = $nodeCommand.Source
# The .env file is data, never executed as PowerShell. Use simple single-line values.
$envPath = Join-Path $root '.env'
if (Test-Path -LiteralPath $envPath) {
    foreach ($line in Get-Content -LiteralPath $envPath -Encoding UTF8) {
        if ($line -match '^\s*(?:#|$)') { continue }
        if ($line -notmatch '^\s*((?:SOCIOMEM_|YUXU_|DEEPSEEK_)[A-Z0-9_]+)\s*=\s*(.*?)\s*$') {
            throw 'Unsupported .env line; use KEY=value and one value per line.'
        }
        $key = $matches[1]; $value = $matches[2]
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        [Environment]::SetEnvironmentVariable($key, $value, 'Process')
    }
}
$wx = Join-Path $root '.tools\agent-wechat\v1.3.2\wx.exe'
$wxData = Join-Path $root '.runtime\agent-wechat'
$wxLauncher = Join-Path $root 'Yuxu-WeChat.exe'
$voiceModelDir = if ($env:SOCIOMEM_VOICE_MODEL_DIR) { $env:SOCIOMEM_VOICE_MODEL_DIR } else { Join-Path $root '.cache\voice-models\sensevoice' }
$logs = Join-Path $root '.runtime\process-logs'
$startupLog = Join-Path $logs 'startup.log'
$groupConfig = $null
$group = $null

function Write-Status([string]$message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $message"
    Write-Host $line
    if (-not $Check) {
        New-Item -ItemType Directory -Path $logs -Force | Out-Null
        Add-Content -LiteralPath $startupLog -Value $line -Encoding UTF8
    }
}

function Get-WxStatus {
    try {
        $raw = & $wx --json --data-dir $wxData status 2>$null
        if ($LASTEXITCODE -eq 0) { return ($raw | ConvertFrom-Json) }
    } catch { }
    return $null
}

function Test-Embedding {
    try {
        $reply = Invoke-RestMethod -Uri 'http://127.0.0.1:11435/health' -TimeoutSec 4
        return ($reply.status -eq 'ok' -and $reply.dimensions -eq 384)
    } catch { return $false }
}

function Test-KeyFile([string]$path) {
    return (Test-Path -LiteralPath $path) -and ((Get-Item -LiteralPath $path).Length -gt 0)
}

function Test-VoiceModel {
    return (Test-Path -LiteralPath (Join-Path $voiceModelDir 'model.int8.onnx')) -and
        (Test-Path -LiteralPath (Join-Path $voiceModelDir 'tokens.txt'))
}

function Test-NodeWorkerCommand([string]$commandLine, [string]$scriptName, [string]$groupId = '') {
    if (-not $commandLine) { return $false }
    $script = (Join-Path $root "scripts\$scriptName").Replace('/', '\').ToLowerInvariant()
    $tokens = @([regex]::Matches($commandLine, '"([^"]*)"|(\S+)') | ForEach-Object {
        if ($_.Groups[1].Success) { $_.Groups[1].Value } else { $_.Groups[2].Value }
    })
    $normalized = @($tokens | ForEach-Object { $_.Replace('/', '\').ToLowerInvariant() })
    $scriptIndex = [Array]::IndexOf($normalized, $script)
    if ($scriptIndex -lt 0) { return $false }
    if (-not $groupId) { return $true }
    return $tokens.Count -eq ($scriptIndex + 3) -and
        $tokens[$scriptIndex + 1] -ceq '--group' -and $tokens[$scriptIndex + 2] -ceq $groupId
}

function Find-NodeWorker([string]$scriptName, [string]$groupId = '') {
    return @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { Test-NodeWorkerCommand $_.CommandLine $scriptName $groupId })
}

function Repair-StaleOwner([string]$dbPath, [string]$scriptName) {
    $lock = "$dbPath.owner"
    if (-not (Test-Path -LiteralPath $lock)) { return }
    $value = (Get-Content -LiteralPath $lock -Raw).Trim()
    $ownerPid = 0
    if (-not [int]::TryParse($value, [ref]$ownerPid)) { throw "owner 锁格式异常：$lock" }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$ownerPid"
    if ($owner -and $owner.Name -eq 'node.exe' -and
        (Test-NodeWorkerCommand $owner.CommandLine $scriptName)) {
        throw "owner 锁仍由 $scriptName 进程 $ownerPid 持有，拒绝删除：$lock"
    }
    $backup = Join-Path $logs ("stale-owner-" + (Get-Date -Format 'yyyyMMdd-HHmmssfff') + '-' + [guid]::NewGuid().ToString('N') + '.txt')
    Copy-Item -LiteralPath $lock -Destination $backup -ErrorAction Stop
    Remove-Item -LiteralPath $lock -ErrorAction Stop
    Write-Status "已保存并移除不属于当前 Worker 的遗留 owner 锁（记录 PID $ownerPid）。"
}

function Start-NodeWorker([string]$scriptName, [string]$label, [string]$groupId = '') {
    $existing = @(Find-NodeWorker $scriptName $groupId)
    if ($existing.Count) {
        Write-Status "$label 已运行（PID $($existing[0].ProcessId)）。"
        return $null
    }
    $db = if ($scriptName -eq 'watch-wechat-capture.mjs') {
        Join-Path $root '.runtime\wechat-adapter\sociomem.sqlite'
    } elseif ($scriptName -eq 'participation-worker.mjs') {
        Join-Path $root '.runtime\participation\participation.sqlite'
    } elseif ($scriptName -eq 'moments-publish-worker.mjs') {
        Join-Path $root '.runtime\moments\publishing.sqlite'
    } elseif ($scriptName -eq 'diary-worker.mjs') {
        Join-Path $root '.runtime\diary\diary.sqlite'
    } elseif ($scriptName -eq 'group-participation-worker.mjs') {
        $entry = @($groupConfig.groups | Where-Object groupId -CEQ $groupId)[0]
        if (-not $entry -or $groupId -ceq $group) { throw '附加对话 Worker 必须属于配置中的附加授权群。' }
        $entry.participationDbPath
    } else { $null }
    if ($db) { Repair-StaleOwner $db $scriptName }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    $slug = [IO.Path]::GetFileNameWithoutExtension($scriptName)
    if ($groupId) { $slug += '-' + ($groupId -replace '[^a-zA-Z0-9_-]', '-') }
    $out = Join-Path $logs "$slug-$stamp.out.log"
    $err = Join-Path $logs "$slug-$stamp.err.log"
    $workerArguments = @('"' + (Join-Path $root "scripts\$scriptName") + '"')
    if ($groupId) { $workerArguments += @('--group', $groupId) }
    $previousGroups = $env:SOCIOMEM_WECHAT_GROUPS
    $env:SOCIOMEM_WECHAT_GROUPS = if ($scriptName -in @('watch-wechat-capture.mjs', 'diary-worker.mjs')) {
        $groupConfig.groupIds -join ','
    } elseif ($groupId) { $groupId } else { $group }
    try {
        $process = Start-Process -FilePath $node -ArgumentList $workerArguments `
            -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out `
            -RedirectStandardError $err -PassThru
    } finally { $env:SOCIOMEM_WECHAT_GROUPS = $previousGroups }
    for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Milliseconds 500
        if ($process.HasExited) {
            $detail = (Get-Content -LiteralPath $err -Tail 8 -ErrorAction SilentlyContinue) -join ' '
            throw "$label 启动后退出（$($process.ExitCode)）：$detail"
        }
        if (Test-Path -LiteralPath $out) {
            $last = Get-Content -LiteralPath $out -Tail 8 -ErrorAction SilentlyContinue
            if ($last | Where-Object { $_ -match '"kind":"ready"' }) {
                Write-Status "$label 已就绪（PID $($process.Id)；日志 $out）。"
                return $process
            }
        }
    }
    throw "$label 未在 60 秒内报告 ready；日志 $out"
}

function Write-WorkerManifest([object[]]$workers) {
    $dir = Join-Path $root '.runtime\supervisor'
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $manifest = [pscustomobject]@{
        workers = @($workers)
        updatedAt = (Get-Date).ToString('o')
    }
    $manifest | ConvertTo-Json -Depth 5 |
        Set-Content -LiteralPath (Join-Path $dir 'workers.json') -Encoding ASCII
}

function Start-WorkerSupervisor {
    $env:SOCIOMEM_SUPERVISOR_INTERVAL_MS = '1800000'
    $env:SOCIOMEM_ONLINE_CHECK_MS = '1800000'
    $existing = @(Find-NodeWorker 'worker-supervisor.mjs')
    foreach ($item in $existing) {
        Write-Status "重启 Worker 守护（旧 PID $($item.ProcessId)）。"
        Stop-Process -Id $item.ProcessId -Force -ErrorAction SilentlyContinue
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if (-not (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue)) { break }
            Start-Sleep -Milliseconds 250
        }
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    $out = Join-Path $logs "worker-supervisor-$stamp.out.log"
    $err = Join-Path $logs "worker-supervisor-$stamp.err.log"
    $process = Start-Process -FilePath $node -ArgumentList (Join-Path $root 'scripts\worker-supervisor.mjs') `
        -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out `
        -RedirectStandardError $err -PassThru
    Start-Sleep -Milliseconds 800
    if ($process.HasExited) {
        $detail = (Get-Content -LiteralPath $err -Tail 8 -ErrorAction SilentlyContinue) -join ' '
        Write-Status "Worker 守护启动后退出（$($process.ExitCode)）：$detail"
        return
    }
    Write-Status "Worker 守护 已就绪（PID $($process.Id)；日志 $out）。"
}

function Test-DiaryValidationBlocked {
    $latest = Get-ChildItem -LiteralPath $logs -Filter 'diary-worker-*.out.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    if (-not $latest) { return $false }
    $tail = (Get-Content -LiteralPath $latest.FullName -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
    if ($tail -notmatch 'DIARY_VALIDATION_FAILED') { return $false }
    $codePaths = @('packages\diary\index.mjs', 'packages\diary\model.mjs',
        'packages\diary\worker.mjs', 'scripts\diary-worker.mjs', 'skills\rolling-memory\SKILL.md')
    $newestCode = @($codePaths | ForEach-Object { (Get-Item -LiteralPath (Join-Path $root $_)).LastWriteTimeUtc } |
        Sort-Object -Descending | Select-Object -First 1)[0]
    return ($latest.LastWriteTimeUtc -gt $newestCode)
}

function Ensure-Embedding {
    if (Test-Embedding) { Write-Status '本地向量服务已就绪。'; return }
    if (Get-NetTCPConnection -State Listen -LocalPort 11435 -ErrorAction SilentlyContinue) {
        throw '11435 端口被其他服务占用，向量服务不可用。'
    }
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmssfff'
    $out = Join-Path $logs "embedding-$stamp.out.log"
    $err = Join-Path $logs "embedding-$stamp.err.log"
    $process = Start-Process -FilePath $node -ArgumentList (Join-Path $root 'scripts\embedding-server.mjs') `
        -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput $out `
        -RedirectStandardError $err -PassThru
    for ($attempt = 0; $attempt -lt 180; $attempt++) {
        Start-Sleep -Milliseconds 500
        if (Test-Embedding) { Write-Status "本地向量服务已就绪（PID $($process.Id)）。"; return }
        if ($process.HasExited) {
            $detail = (Get-Content -LiteralPath $err -Tail 8 -ErrorAction SilentlyContinue) -join ' '
            throw "向量服务启动失败：$detail"
        }
    }
    throw "向量服务 90 秒内未就绪；日志 $err"
}

function Get-Account {
    try {
        $raw = & $wx --json --data-dir $wxData accounts list 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        return @(($raw | ConvertFrom-Json).items | Where-Object id -CEQ $groupConfig.accountId)[0]
    } catch { return $null }
}

function Ensure-WeChat {
    $status = Get-WxStatus
    $actualDir = [string]$status.dataDir
    if ($actualDir.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $actualDir = '\\' + $actualDir.Substring(8) }
    elseif ($actualDir.StartsWith('\\?\')) { $actualDir = $actualDir.Substring(4) }
    if ($status -and $status.state -eq 'ready' -and ($actualDir.TrimEnd('\') -ne $wxData.TrimEnd('\'))) {
        throw 'Another WeChat data directory is already using the daemon port. Keep one daemon per installation.'
    }
    $account = Get-Account
    if ($account -and $account.authenticated -and $account.connection -eq 'online') { return }
    if (-not (Test-Path -LiteralPath $wxLauncher)) { throw 'Build and run Yuxu-WeChat.exe to sign in first.' }
    & $wxLauncher --no-pause
    if ($LASTEXITCODE -ne 0) { throw 'WeChat sign-in did not finish.' }
    $account = Get-Account
    if (-not $account -or -not $account.authenticated -or $account.connection -ne 'online') {
        throw 'The configured account is not online. Check the account ID in your local group configuration.'
    }
}

try {
    if (-not (Test-Path -LiteralPath $wx)) { throw 'Build the bundled native engine with npm run wechat:build first.' }
    $configuration = & $node (Join-Path $root 'scripts\wechat-groups-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Run npm run setup with your own account and group IDs first.' }
    $groupConfig = ($configuration -join "`n") | ConvertFrom-Json
    $group = $groupConfig.primaryGroupId
    if ($Check) {
        $account = Get-Account
        [pscustomobject]@{
            wechat = if ($account -and $account.authenticated -and $account.connection -eq 'online') { 'online' } else { 'offline' }
            embedding = Test-Embedding
            capture = [bool]@(Find-NodeWorker 'watch-wechat-capture.mjs').Count
            participationGroups = @($groupConfig.groups | ForEach-Object {
                $scriptName = if ($_.groupId -ceq $group) { 'participation-worker.mjs' } else { 'group-participation-worker.mjs' }
                $instanceGroup = if ($_.groupId -ceq $group) { '' } else { $_.groupId }
                [pscustomobject]@{ groupId = $_.groupId; running = [bool]@(Find-NodeWorker $scriptName $instanceGroup).Count }
            })
            supervisor = [bool]@(Find-NodeWorker 'worker-supervisor.mjs').Count
        } | ConvertTo-Json -Depth 5
        exit 0
    }
    $provider = if ($env:SOCIOMEM_PARTICIPATION_PROVIDER) { $env:SOCIOMEM_PARTICIPATION_PROVIDER } else { 'deepseek' }
    if ($provider -notin @('deepseek','ollama','anthropic')) { throw 'Choose deepseek, ollama or anthropic as the model provider.' }
    if ($provider -eq 'deepseek' -and -not $env:DEEPSEEK_API_KEY) {
        $keyFile = Join-Path $root '.runtime\secrets\deepseek-api-key'
        if (Test-KeyFile $keyFile) { $env:DEEPSEEK_API_KEY = (Get-Content -LiteralPath $keyFile -Raw).Trim() }
        if (-not $env:DEEPSEEK_API_KEY) { throw 'Configure your own DeepSeek API key in .env or the private key file.' }
    }
    $env:SOCIOMEM_PARTICIPATION_PROVIDER = $provider
    $env:SOCIOMEM_WECHAT_GROUPS = $group
    $env:SOCIOMEM_WECHAT_ACCOUNT_ID = $groupConfig.accountId
    # New installations start in preview mode. Enabling sends is a local configuration decision.
    foreach ($name in @('SOCIOMEM_PARTICIPATION_SEND','SOCIOMEM_STICKER_SEND','SOCIOMEM_SELFIE_SEND','SOCIOMEM_VOICE_SEND','SOCIOMEM_PAT_SEND','SOCIOMEM_MOMENTS_SEND','SOCIOMEM_MOMENTS_LIKE_SEND','SOCIOMEM_MOMENTS_COMMENT_SEND')) {
        if (-not [Environment]::GetEnvironmentVariable($name, 'Process')) { [Environment]::SetEnvironmentVariable($name, '0', 'Process') }
    }
    if (-not $env:SOCIOMEM_MODEL_FALLBACK) { $env:SOCIOMEM_MODEL_FALLBACK = 'none' }
    Ensure-WeChat
    Ensure-Embedding
    Start-NodeWorker 'watch-wechat-capture.mjs' 'Message capture' | Out-Null
    Start-NodeWorker 'participation-worker.mjs' 'Primary group' | Out-Null
    $supervised = @('watch-wechat-capture.mjs','participation-worker.mjs')
    foreach ($entry in $groupConfig.groups) {
        if ($entry.groupId -ceq $group) { continue }
        Start-NodeWorker 'group-participation-worker.mjs' 'Additional group' $entry.groupId | Out-Null
        $supervised += [pscustomobject]@{ script='group-participation-worker.mjs'; groupId=$entry.groupId }
    }
    if ($env:SOCIOMEM_DIARY_ENABLED -ne '0') {
        if (-not $env:SOCIOMEM_DIARY_PROVIDER) { $env:SOCIOMEM_DIARY_PROVIDER = $provider }
        Start-NodeWorker 'diary-worker.mjs' 'Rolling memory' | Out-Null
        $supervised += 'diary-worker.mjs'
    }
    if ($env:SOCIOMEM_TRENDS_ENABLED -eq '1') {
        Start-NodeWorker 'trends-worker.mjs' 'Trends' | Out-Null
        $supervised += 'trends-worker.mjs'
    }
    if ($env:SOCIOMEM_MOMENTS_ENABLED -eq '1') {
        if (-not $env:SOCIOMEM_MOMENTS_PROVIDER) { $env:SOCIOMEM_MOMENTS_PROVIDER = $provider }
        Start-NodeWorker 'moments-worker.mjs' 'Moments' | Out-Null
        $supervised += 'moments-worker.mjs'
    }
    $publishingPath = Join-Path $root '.runtime\moments\publishing-config.json'
    if (Test-Path -LiteralPath $publishingPath) {
        $publishing = Get-Content -LiteralPath $publishingPath -Raw | ConvertFrom-Json
        if ($publishing.enabled -eq $true) {
            if (-not $env:SOCIOMEM_MOMENTS_PUBLISH_PROVIDER) { $env:SOCIOMEM_MOMENTS_PUBLISH_PROVIDER = $provider }
            Start-NodeWorker 'moments-publish-worker.mjs' 'Moments publishing' | Out-Null
            $supervised += 'moments-publish-worker.mjs'
        }
    }
    Write-WorkerManifest $supervised
    Start-WorkerSupervisor
    Write-Status ('Yuxu started. Group sending: ' + $env:SOCIOMEM_PARTICIPATION_SEND + '; online checks: 30 minutes.')
    exit 0
} catch {
    Write-Status ('Startup stopped: ' + $_.Exception.Message)
    exit 1
}
