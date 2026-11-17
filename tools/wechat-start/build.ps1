$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$jsonAssembly = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\System.Web.Extensions.dll'
if (-not (Test-Path -LiteralPath $compiler)) { throw "找不到 .NET Framework C# 编译器：$compiler" }
if (-not (Test-Path -LiteralPath $jsonAssembly)) { throw "找不到 JSON 程序集：$jsonAssembly" }
$output = Join-Path $projectRoot 'Yuxu-WeChat.exe'
$source = Join-Path $PSScriptRoot 'Program.cs'
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/r:$jsonAssembly" "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "编译失败，退出码：$LASTEXITCODE" }
& $output --self-test
if ($LASTEXITCODE -ne 0) { throw '启动器自检失败' }
Write-Host "已生成：$output"
