$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw "找不到 .NET Framework 编译器：$compiler" }
$source = Join-Path $PSScriptRoot 'Program.cs'
$output = Join-Path $root 'Yuxu-Start.exe'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "编译失败：$LASTEXITCODE" }
Write-Host "已生成：$output"
