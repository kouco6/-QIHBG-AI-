<#
.SYNOPSIS
    停止体验工作台本地服务（按端口定位进程）。
.EXAMPLE
    pwsh -File .\scripts\stop.ps1
#>
[CmdletBinding()]
param(
    [int]$ApiPort = $(if ($env:API_PORT) { [int]$env:API_PORT } else { 8000 }),
    [int]$WebPort = $(if ($env:WEB_PORT) { [int]$env:WEB_PORT } else { 5173 })
)

$ErrorActionPreference = 'Continue'
$stopped = 0

foreach ($port in @($ApiPort, $WebPort)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if (-not $conns) {
        Write-Host ("端口 {0} 未在监听。" -f $port) -ForegroundColor DarkGray
        continue
    }
    foreach ($pid in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
        try {
            $proc = Get-Process -Id $pid -ErrorAction Stop
            Stop-Process -Id $pid -Force
            Write-Host ("已停止端口 {0} 上的进程 {1}（{2}）" -f $port, $pid, $proc.ProcessName) -ForegroundColor Green
            $stopped++
        } catch {
            Write-Host ("端口 {0} 上的进程 {1} 停止失败：{2}" -f $port, $pid, $_.Exception.Message) -ForegroundColor Yellow
        }
    }
}

if ($stopped -eq 0) { Write-Host '没有需要停止的服务。' -ForegroundColor DarkGray }
