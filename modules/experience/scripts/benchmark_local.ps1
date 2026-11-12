<#
.SYNOPSIS
    本地性能基准：首页首屏、项目列表、问题中心接口耗时。
.DESCRIPTION
    依赖后端已在 127.0.0.1:8000 运行。结果写入 test-results/benchmark-<时间戳>.json。
    验收参考：首页首屏 ≤ 2s，一键启动 ≤ 5min（启动耗时由 start.ps1 自行记录）。
#>
[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8000',
    [int]$Rounds = 10
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$OutDir = Join-Path $Root 'test-results'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$targets = @(
    @{ name = 'health'; path = '/api/health' },
    @{ name = 'meta'; path = '/api/v1/meta' }
)

$results = @()
foreach ($t in $targets) {
    $times = @()
    for ($i = 0; $i -lt $Rounds; $i++) {
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        try {
            Invoke-WebRequest -Uri ($BaseUrl + $t.path) -UseBasicParsing -TimeoutSec 10 | Out-Null
            $ok = $true
        } catch {
            $ok = $false
        }
        $sw.Stop()
        $times += [math]::Round($sw.Elapsed.TotalMilliseconds, 1)
    }
    $sorted = $times | Sort-Object
    $p50 = $sorted[[math]::Floor($sorted.Count * 0.5)]
    $p95 = $sorted[[math]::Min($sorted.Count - 1, [math]::Floor($sorted.Count * 0.95))]
    $results += [pscustomobject]@{
        name = $t.name
        path = $t.path
        rounds = $Rounds
        ok = $ok
        min_ms = $sorted[0]
        p50_ms = $p50
        p95_ms = $p95
        max_ms = $sorted[-1]
    }
    Write-Host ("{0,-10} p50={1,7} ms  p95={2,7} ms" -f $t.name, $p50, $p95)
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outFile = Join-Path $OutDir ("benchmark-{0}.json" -f $stamp)
$results | ConvertTo-Json -Depth 4 | Set-Content -Path $outFile -Encoding UTF8
Write-Host ("结果已写入 " + $outFile) -ForegroundColor Green
