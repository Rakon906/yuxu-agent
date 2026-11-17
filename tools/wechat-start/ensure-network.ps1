param([ValidateSet('Check', 'Plan', 'Apply', 'Revert')][string]$Mode = 'Check')
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$runtime = Join-Path $root '.runtime\wechat-start'
$recordPath = Join-Path $runtime 'network-routes.json'
$resultPath = Join-Path $runtime 'network-last-result.json'
$hostsPath = Join-Path $env:WINDIR 'System32\drivers\etc\hosts'
$domains = @('long.weixin.qq.com', 'short.weixin.qq.com', 'szlong.weixin.qq.com',
    'szshort.weixin.qq.com', 'login.weixin.qq.com')
$known = @('43.129.254.147', '43.129.255.26', '43.129.255.38',
    '43.155.124.238', '43.159.234.18')
$begin = '# SocioMem temporary WeChat DNS begin'
$end = '# SocioMem temporary WeChat DNS end'

function Get-PhysicalPath {
    $choices = @()
    foreach ($adapter in (Get-NetAdapter -Physical | Where-Object Status -eq 'Up')) {
        $config = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex
        $address = @($config.IPv4Address | Select-Object -ExpandProperty IPAddress -ErrorAction SilentlyContinue | Select-Object -First 1)
        $gateway = @($config.IPv4DefaultGateway | Select-Object -ExpandProperty NextHop -ErrorAction SilentlyContinue | Select-Object -First 1)
        if ($address.Count -and $gateway.Count -and $address[0] -and $gateway[0]) {
            $priority = if ($adapter.InterfaceDescription -match 'Realtek') { 0 } else { 1 }
            $choices += [pscustomobject]@{ priority = $priority; index = [int]$adapter.ifIndex;
                source = [string]$address[0]; gateway = [string]$gateway[0]; name = $adapter.Name }
        }
    }
    $choice = $choices | Sort-Object priority, index | Select-Object -First 1
    if (-not $choice) { throw '没有找到已连接、带 IPv4 网关的物理网卡。' }
    return $choice
}

function Get-ManagedMapping {
    $raw = [System.IO.File]::ReadAllBytes($hostsPath)
    $text = [System.Text.Encoding]::GetEncoding(28591).GetString($raw)
    $start = $text.IndexOf($begin, [StringComparison]::Ordinal)
    $finish = $text.IndexOf($end, [StringComparison]::Ordinal)
    if (($start -lt 0) -ne ($finish -lt 0)) { throw 'hosts 中 SocioMem 标记不完整。' }
    if ($start -lt 0) { return $null }
    if ($finish -le $start -or
        $text.IndexOf($begin, $start + $begin.Length, [StringComparison]::Ordinal) -ge 0 -or
        $text.IndexOf($end, $finish + $end.Length, [StringComparison]::Ordinal) -ge 0) {
        throw 'hosts 中 SocioMem 标记重复或乱序。'
    }
    $block = $text.Substring($start, $finish + $end.Length - $start)
    $mapping = @{}
    foreach ($line in ($block -split '\r?\n')) {
        if ($line -match '^\s*(\d{1,3}(?:\.\d{1,3}){3})\s+([a-z0-9.-]+)\s*$' -and
            $domains -contains $matches[2]) {
            $ip = $null
            if (-not [Net.IPAddress]::TryParse($matches[1], [ref]$ip) -or
                $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) {
                throw 'hosts 中有无效微信地址。'
            }
            $mapping[$matches[2]] = $ip.ToString()
        }
    }
    if ($mapping.Count -ne $domains.Count) { return $null }
    return $mapping
}

function Test-PhysicalTcp([string]$source, [string]$target) {
    $client = [Net.Sockets.TcpClient]::new([Net.Sockets.AddressFamily]::InterNetwork)
    try {
        $client.Client.Bind([Net.IPEndPoint]::new([Net.IPAddress]::Parse($source), 0))
        $pending = $client.BeginConnect($target, 80, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(2200)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch { return $false } finally { $client.Dispose() }
}

function Test-Candidate($path, [string]$target, [bool]$temporaryRoute) {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$target/32" -ErrorAction SilentlyContinue)
    if (@($routes | Where-Object { $_.InterfaceIndex -ne $path.index -or
                $_.NextHop -ne $path.gateway }).Count) {
        throw "候选地址已有冲突路由：$target"
    }
    $created = $false
    try {
        if (-not $routes.Count -and $temporaryRoute) {
            New-NetRoute -DestinationPrefix "$target/32" -InterfaceIndex $path.index `
                -NextHop $path.gateway -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
            $created = $true
        }
        if (-not $routes.Count -and -not $temporaryRoute) { return $null }
        return (Test-PhysicalTcp $path.source $target)
    } finally {
        if ($created) {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$target/32" -ErrorAction SilentlyContinue |
                Where-Object { $_.InterfaceIndex -eq $path.index -and $_.NextHop -eq $path.gateway } |
                Remove-NetRoute -Confirm:$false -ErrorAction Stop
        }
    }
}

function Get-PublicAddresses([string]$domain) {
    $found = @()
    foreach ($base in @('https://cloudflare-dns.com/dns-query?name=', 'https://dns.google/resolve?name=')) {
        try {
            $reply = Invoke-RestMethod -Uri ($base + [uri]::EscapeDataString($domain) + '&type=A') `
                -Headers @{ Accept = 'application/dns-json' } -TimeoutSec 7
            $found += @($reply.Answer | Where-Object { $_.type -eq 1 } | Select-Object -ExpandProperty data)
            if ($found.Count) { break }
        } catch { }
    }
    return @($found | Select-Object -Unique)
}

function Choose-Mapping($path, [bool]$temporaryRoute) {
    $old = Get-ManagedMapping
    if ($old) {
        $allWork = $true
        foreach ($domain in $domains) {
            $probe = Test-Candidate $path $old[$domain] $temporaryRoute
            if ($null -eq $probe -and -not $temporaryRoute) { continue }
            if (-not $probe) { $allWork = $false; break }
        }
        if ($allWork) { return $old }
    }
    $mapping = @{}
    for ($index = 0; $index -lt $domains.Count; $index++) {
        $candidates = @(Get-PublicAddresses $domains[$index]) + @($known[$index])
        $selected = $null
        foreach ($candidate in ($candidates | Select-Object -Unique)) {
            $ip = $null
            if ([Net.IPAddress]::TryParse($candidate, [ref]$ip) -and
                $ip.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
                $probe = Test-Candidate $path $ip.ToString() $temporaryRoute
                if ($probe -or ($null -eq $probe -and -not $temporaryRoute)) {
                    $selected = $ip.ToString(); break
                }
            }
        }
        if (-not $selected) { throw "物理网卡无法连接 $($domains[$index]) 的候选地址。" }
        $mapping[$domains[$index]] = $selected
    }
    return $mapping
}

function Get-RouteCoverage($path, $mapping) {
    $missing = @()
    $conflict = @()
    foreach ($ip in @($mapping.Values | Select-Object -Unique)) {
        $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue)
        if (-not $routes.Count) { $missing += $ip; continue }
        $matching = @($routes | Where-Object { $_.InterfaceIndex -eq $path.index -and
                    $_.NextHop -eq $path.gateway })
        if ($matching.Count -ne $routes.Count) { $conflict += $ip }
    }
    return [pscustomobject]@{ missing = @($missing); conflict = @($conflict) }
}

function Set-ManagedHosts($mapping) {
    $before = [IO.File]::ReadAllBytes($hostsPath)
    $latin = [Text.Encoding]::GetEncoding(28591)
    $text = $latin.GetString($before)
    $pattern = '(?m)^# SocioMem temporary WeChat DNS begin[^\r\n]*\r?\n[\s\S]*?^# SocioMem temporary WeChat DNS end\r?\n?'
    $matches = [regex]::Matches($text, $pattern)
    if ($matches.Count -gt 1) { throw 'hosts 中有重复的 SocioMem 区块。' }
    if (($text.Contains($begin) -or $text.Contains($end)) -and $matches.Count -ne 1) {
        throw 'hosts 中 SocioMem 区块不完整。'
    }
    $clean = [regex]::Replace($text, $pattern, '')
    $block = [Text.StringBuilder]::new()
    [void]$block.Append("`r`n`r`n$begin managed`r`n")
    foreach ($domain in $domains) { [void]$block.Append("$($mapping[$domain]) $domain`r`n") }
    [void]$block.Append("$end`r`n")
    $proposed = $latin.GetBytes($clean.TrimEnd("`r", "`n") + $block.ToString())
    if ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String($proposed)) { return $null }
    $backup = Join-Path $runtime ('backups\network-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    [IO.File]::WriteAllBytes((Join-Path $backup 'hosts.before'), $before)
    [IO.File]::WriteAllBytes((Join-Path $backup 'hosts.proposed'), $proposed)
    $again = [IO.File]::ReadAllBytes($hostsPath)
    if ([Convert]::ToBase64String($before) -ne [Convert]::ToBase64String($again)) {
        throw 'hosts 在准备期间被修改，拒绝覆盖。'
    }
    [IO.File]::WriteAllBytes($hostsPath, $proposed)
    return $backup
}

function Write-Result($body, [switch]$NoFile) {
    if (-not $NoFile) {
        New-Item -ItemType Directory -Path $runtime -Force | Out-Null
        $body | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $resultPath -Encoding utf8
    }
    $body | ConvertTo-Json -Depth 6
}

try {
    if ($Mode -eq 'Revert') {
        if (-not (Test-Path -LiteralPath $recordPath)) {
            Write-Result ([pscustomobject]@{ ok = $true; action = 'revert'; removed = @() })
            exit 0
        }
        $record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
        $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
        if ($record.bootTime -ne $bootTime) {
            Remove-Item -LiteralPath $recordPath -ErrorAction Stop
            Write-Result ([pscustomobject]@{ ok = $true; action = 'revert'; removed = @(); staleRecord = $true })
            exit 0
        }
        $removed = @()
        foreach ($ip in $record.created) {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue |
                Where-Object { $_.InterfaceIndex -eq $record.interfaceIndex -and
                    $_.NextHop -eq $record.gateway } |
                Remove-NetRoute -Confirm:$false -ErrorAction Stop
            $removed += $ip
        }
        Remove-Item -LiteralPath $recordPath -ErrorAction Stop
        Write-Result ([pscustomobject]@{ ok = $true; action = 'revert'; removed = $removed })
        exit 0
    }

    $path = Get-PhysicalPath
    $managed = Get-ManagedMapping
    $coverage = if ($managed) { Get-RouteCoverage $path $managed } else { $null }
    $ready = [bool]($managed -and $coverage.missing.Count -eq 0 -and $coverage.conflict.Count -eq 0)
    if ($Mode -eq 'Check') {
        Write-Result ([pscustomobject]@{ ok = $true; action = 'check'; ready = $ready;
            interfaceIndex = $path.index; gateway = $path.gateway; source = $path.source;
            missing = if ($coverage) { $coverage.missing } else { @('hosts_mapping') };
            conflict = if ($coverage) { $coverage.conflict } else { @() } }) -NoFile
        exit 0
    }

    if ($Mode -eq 'Plan') {
        $planned = Choose-Mapping $path $false
        $plannedCoverage = Get-RouteCoverage $path $planned
        Write-Result ([pscustomobject]@{ ok = $true; action = 'plan';
            interfaceIndex = $path.index; gateway = $path.gateway; source = $path.source;
            mapping = $planned; missing = $plannedCoverage.missing;
            conflict = $plannedCoverage.conflict }) -NoFile
        exit 0
    }

    $mapping = Choose-Mapping $path $true
    $bootTime = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToString('o')
    $coverage = Get-RouteCoverage $path $mapping
    if ($coverage.conflict.Count) { throw ('冲突的微信专用路由：' + ($coverage.conflict -join ',')) }
    $created = @()
    $hostsBackup = $null
    try {
        $hostsBackup = Set-ManagedHosts $mapping
        foreach ($ip in $coverage.missing) {
            New-NetRoute -DestinationPrefix "$ip/32" -InterfaceIndex $path.index `
                -NextHop $path.gateway -RouteMetric 1 -PolicyStore ActiveStore -ErrorAction Stop | Out-Null
            $created += $ip
        }
        $priorCreated = @()
        if (Test-Path -LiteralPath $recordPath) {
            $prior = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
            if ($prior.bootTime -eq $bootTime -and $prior.interfaceIndex -eq $path.index -and
                $prior.gateway -eq $path.gateway) {
                $priorCreated = @($prior.created | Where-Object { $mapping.Values -contains $_ })
            }
        }
        $record = [pscustomobject]@{ createdAt = (Get-Date).ToString('o'); bootTime = $bootTime;
            interfaceIndex = $path.index;
            gateway = $path.gateway; source = $path.source; created = @(($priorCreated + $created) | Select-Object -Unique);
            mapping = $mapping; hostsBackup = $hostsBackup }
        $record | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $recordPath -Encoding utf8
        Write-Result ([pscustomobject]@{ ok = $true; action = 'apply'; ready = $true;
            created = @($created); existing = @($mapping.Count - $created.Count);
            interfaceIndex = $path.index; gateway = $path.gateway; hostsBackup = $hostsBackup })
        exit 0
    } catch {
        foreach ($ip in $created) {
            Get-NetRoute -AddressFamily IPv4 -DestinationPrefix "$ip/32" -ErrorAction SilentlyContinue |
                Where-Object { $_.InterfaceIndex -eq $path.index -and $_.NextHop -eq $path.gateway } |
                Remove-NetRoute -Confirm:$false -ErrorAction SilentlyContinue
        }
        if ($hostsBackup) {
            $proposed = [IO.File]::ReadAllBytes((Join-Path $hostsBackup 'hosts.proposed'))
            $actual = [IO.File]::ReadAllBytes($hostsPath)
            if ([Convert]::ToBase64String($actual) -eq [Convert]::ToBase64String($proposed)) {
                [IO.File]::WriteAllBytes($hostsPath,
                    [IO.File]::ReadAllBytes((Join-Path $hostsBackup 'hosts.before')))
            }
        }
        throw
    }
} catch {
    Write-Result ([pscustomobject]@{ ok = $false; action = $Mode.ToLowerInvariant();
        error = $_.Exception.Message })
    exit 1
}
