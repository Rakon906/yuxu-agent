$ErrorActionPreference = 'Stop'
$taskName = 'SocioMem Worker Supervisor'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$ensureScript = Join-Path $root 'tools\startup\ensure-supervisor.ps1'
$arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ensureScript`""

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments -WorkingDirectory $root
$logon = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$repeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($logon, $repeat) `
    -Settings $settings -Principal $principal -Force `
    -Description 'Starts SocioMem-Start at logon and checks every 5 minutes that the worker supervisor is alive.' |
    Select-Object TaskName, State
