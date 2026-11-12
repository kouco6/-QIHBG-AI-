<#
.SYNOPSIS
    体验工作台（UEI Experience Workbench）一键启动。

.DESCRIPTION
    按顺序完成：环境检查 → 后端虚拟环境与依赖 → 数据库迁移 → 种子初始化 →
    前端依赖 → 并行启动后端(uvicorn)与前端(vite)。

    兼容 Windows PowerShell 5.1 与 PowerShell 7+。
    本文件必须保存为 UTF-8 with BOM，否则 5.1 会以 ANSI 解析导致中文乱码。

.PARAMETER SkipInstall
    跳过依赖安装（依赖已就绪时加速启动）。

.PARAMETER BackendOnly
    仅启动后端。

.PARAMETER FrontendOnly
    仅启动前端。

.PARAMETER NoLaunch
    只做初始化与迁移，不启动服务（用于 CI / 自检）。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\start.ps1
    powershell -ExecutionPolicy Bypass -File .\start.ps1 -SkipInstall
#>
[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$BackendOnly,
    [switch]$FrontendOnly,
    [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 统一 UTF-8 输出，避免中文在 GBK 控制台下乱码
try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
    $OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch { }
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUTF8 = '1'

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Join-Path $Root 'backend'
$FrontendDir = Join-Path $Root 'frontend'
$DataDir = Join-Path $Root 'data'
$LogDir = Join-Path $Root 'logs'
$VenvDir = Join-Path $BackendDir '.venv'
$VenvPython = Join-Path $VenvDir 'Scripts\python.exe'
$PipIndex = 'https://mirrors.aliyun.com/pypi/simple/'
$NpmRegistry = 'https://registry.npmmirror.com'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host ('=' * 64) -ForegroundColor DarkCyan
    Write-Host ('  ' + $Text) -ForegroundColor Cyan
    Write-Host ('=' * 64) -ForegroundColor DarkCyan
}
function Write-Ok([string]$Text) { Write-Host ('  [OK]   ' + $Text) -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host ('  [提示] ' + $Text) -ForegroundColor Yellow }
function Fail([string]$Text, [string]$Hint) {
    Write-Host ''
    Write-Host ('  [失败] ' + $Text) -ForegroundColor Red
    if ($Hint) { Write-Host ('  处理建议：' + $Hint) -ForegroundColor Yellow }
    exit 1
}
# 运行原生命令并把 stderr 合并到 stdout，避免 PS 5.1 将正常日志判为错误
function Invoke-Native([string]$Exe, [string[]]$ArgList, [string]$WorkDir) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        if ($WorkDir) { Push-Location $WorkDir }
        try {
            & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host ('    ' + $_) }
        } finally {
            if ($WorkDir) { Pop-Location }
        }
    } finally {
        $ErrorActionPreference = $prev
    }
}

# 环境块中同名不同大小写的变量（典型：HTTPS_PROXY 与 https_proxy 并存，多为代理工具注入）
# 会让 Windows PowerShell 5.1 的 Start-Process 构建环境字典时抛出“已添加项”异常
function Repair-DuplicateEnv {
    $maxRounds = 5
    for ($round = 0; $round -lt $maxRounds; $round++) {
        $keys = @([System.Environment]::GetEnvironmentVariables().Keys | ForEach-Object { [string]$_ })
        $dups = @($keys | Group-Object { $_.ToUpperInvariant() } | Where-Object { $_.Count -gt 1 })
        if ($dups.Count -eq 0) { return }
        foreach ($g in $dups) {
            $keep = $g.Group[0]
            foreach ($k in $g.Group) {
                if ($k -cne $keep) {
                    [System.Environment]::SetEnvironmentVariable($k, $null) | Out-Null
                    Write-Warn2 ('环境变量大小写重复已合并：' + $k + ' -> ' + $keep)
                }
            }
        }
    }
}

New-Item -ItemType Directory -Force -Path $DataDir, $LogDir | Out-Null

# ---------------------------------------------------------------- 1. 环境检查
Write-Step '1/6 环境检查'

$pyExe = $null
foreach ($cand in @('python', 'py')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $pyExe = $cmd.Source; break }
}
if (-not $pyExe) {
    Fail '未检测到 Python。' '请安装 Python 3.11 及以上版本，并确保 python 在 PATH 中；安装后重开终端再试。'
}
# 注意：不要用 ... | Select-Object -First 1 截断原生命令管道，
# 那会提前终止子进程使 $LASTEXITCODE 变成 -1，导致误判为“Python 无法执行”。
$pyVersionOut = @(& $pyExe -c "import sys;print(str(sys.version_info[0])+'.'+str(sys.version_info[1]))" 2>$null)
$pyVersionExit = $LASTEXITCODE
$pyVersionRaw = if ($pyVersionOut.Length -gt 0) { $pyVersionOut[0].ToString().Trim() } else { '' }
if ($pyVersionExit -ne 0 -or -not $pyVersionRaw) { Fail 'Python 无法执行。' '请确认 Python 安装完整（可运行 python --version）。' }
$pyParts = ([string]$pyVersionRaw).Trim().Split('.')
if ([int]$pyParts[0] -lt 3 -or ([int]$pyParts[0] -eq 3 -and [int]$pyParts[1] -lt 11)) {
    Fail ('Python 版本过低：' + $pyVersionRaw) '请升级到 Python 3.11 及以上。'
}
Write-Ok ('Python ' + $pyVersionRaw)

$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $FrontendOnly -and -not $nodeCmd) {
    Fail '未检测到 Node.js。' '请安装 Node.js 18 及以上版本（建议 LTS），并确保 node 在 PATH 中。'
}
if ($nodeCmd) {
    $nodeVersion = ((& node --version) -replace '^v', '').Trim()
    $nodeMajor = [int]($nodeVersion.Split('.')[0])
    if ($nodeMajor -lt 18) { Fail ('Node.js 版本过低：v' + $nodeVersion) '请升级到 Node.js 18 及以上版本。' }
    Write-Ok ('Node.js v' + $nodeVersion)
}

Write-Ok ('工作目录：' + $Root)

# ------------------------------------------------------- 2. 后端依赖
if (-not $FrontendOnly) {
    Write-Step '2/6 后端依赖'
    if (-not (Test-Path $VenvPython)) {
        Write-Host '  创建虚拟环境 backend\.venv ...'
        Invoke-Native $pyExe @('-m', 'venv', $VenvDir) $null
        if (-not (Test-Path $VenvPython)) {
            Fail '创建虚拟环境失败。' '请确认对项目目录有写权限，或手动执行：python -m venv backend\.venv'
        }
    }
    Write-Ok '虚拟环境就绪'

    if (-not $SkipInstall) {
        Write-Host '  安装后端依赖（首次约需 1-2 分钟）...'
        Invoke-Native $VenvPython @('-m', 'pip', 'install', '--disable-pip-version-check', '-q', '-i', $PipIndex, '-e', ($BackendDir + '[dev]')) $null
        if ($LASTEXITCODE -ne 0) {
            Fail '后端依赖安装失败。' '请检查网络或代理；也可手动执行：backend\.venv\Scripts\python -m pip install -e backend[dev]'
        }
        Write-Ok '后端依赖安装完成'
    } else {
        Write-Ok '已跳过后端依赖安装（-SkipInstall）'
    }

    # --------------------------------------------------- 3. 数据库迁移
    Write-Step '3/6 数据库迁移'
    Invoke-Native $VenvPython @('-m', 'alembic', 'upgrade', 'head') $BackendDir
    if ($LASTEXITCODE -ne 0) {
        Fail '数据库迁移失败。' '请查看上方 Alembic 输出；常见原因：data 目录无写权限，或数据库文件被占用（先执行 scripts\stop.ps1）。'
    }
    Write-Ok '迁移完成（SQLite WAL 已启用）'

    # --------------------------------------------------- 4. 种子初始化
    Write-Step '4/6 种子初始化'
    Invoke-Native $VenvPython @((Join-Path $Root 'scripts\verify_seed_counts.py'), '--root', $Root) $null
    if ($LASTEXITCODE -ne 0) { Write-Warn2 '种子校验未通过（字典在 T06 交付后才会完整，此处不阻塞启动）。' }
    else { Write-Ok '种子校验通过' }
}

# ------------------------------------------------------- 5. 前端依赖
if (-not $BackendOnly) {
    Write-Step '5/6 前端依赖'
    $nodeModules = Join-Path $FrontendDir 'node_modules'
    if (-not (Test-Path $nodeModules)) {
        if ($SkipInstall) {
            Write-Warn2 '未安装前端依赖且指定了 -SkipInstall，前端可能无法启动。'
        } else {
            Write-Host '  安装前端依赖（首次约需 1-2 分钟）...'
            Invoke-Native 'npm' @('install', ('--registry=' + $NpmRegistry), '--no-audit', '--no-fund') $FrontendDir
            if ($LASTEXITCODE -ne 0) {
                Fail '前端依赖安装失败。' '请检查网络；也可手动执行：cd frontend; npm install --registry=https://registry.npmmirror.com'
            }
        }
    }
    Write-Ok '前端依赖就绪'
}

if ($NoLaunch) {
    Write-Step '完成（-NoLaunch：未启动服务）'
    Write-Ok '初始化成功。启动服务请运行：powershell -ExecutionPolicy Bypass -File .\start.ps1 -SkipInstall'
    exit 0
}

# ------------------------------------------------------- 6. 启动服务
Write-Step '6/6 启动服务'

Repair-DuplicateEnv

$apiPort = if ($env:API_PORT) { [int]$env:API_PORT } else { 8000 }
$webPort = if ($env:WEB_PORT) { [int]$env:WEB_PORT } else { 5173 }
$backendLog = Join-Path $LogDir 'backend.out.log'
$frontendLog = Join-Path $LogDir 'frontend.out.log'

if (-not $FrontendOnly) {
    Start-Process -FilePath $VenvPython `
        -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', "$apiPort") `
        -WorkingDirectory $BackendDir `
        -RedirectStandardOutput $backendLog `
        -RedirectStandardError (Join-Path $LogDir 'backend.err.log') `
        -WindowStyle Hidden
    Write-Ok ('后端已启动：http://127.0.0.1:' + $apiPort + '/api/docs   （日志：logs\backend.out.log）')
}

if (-not $BackendOnly) {
    Start-Process -FilePath $env:ComSpec `
        -ArgumentList @('/c', "npm run dev -- --port $webPort") `
        -WorkingDirectory $FrontendDir `
        -RedirectStandardOutput $frontendLog `
        -RedirectStandardError (Join-Path $LogDir 'frontend.err.log') `
        -WindowStyle Hidden
    Write-Ok ('前端已启动：http://127.0.0.1:' + $webPort + '   （日志：logs\frontend.out.log）')
}

if (-not $FrontendOnly) {
    Write-Host ''
    Write-Host '  等待后端健康检查 ' -NoNewline
    $ok = $false
    for ($i = 0; $i -lt 30; $i++) {
        Start-Sleep -Milliseconds 500
        try {
            $resp = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $apiPort + '/api/health') -TimeoutSec 2
            if ($resp.status -eq 'ok') { $ok = $true; break }
        } catch { }
        Write-Host '.' -NoNewline
    }
    Write-Host ''
    if ($ok) { Write-Ok '后端健康检查通过' }
    else { Write-Warn2 '后端健康检查未在 15 秒内通过，请查看 logs\backend.err.log' }
}

Write-Host ''
Write-Host '  体验工作台已就绪：' -ForegroundColor Green
Write-Host ('    前端  http://127.0.0.1:' + $webPort) -ForegroundColor Green
Write-Host ('    后端  http://127.0.0.1:' + $apiPort + '/api/docs') -ForegroundColor Green
Write-Host '  停止服务：powershell -ExecutionPolicy Bypass -File .\scripts\stop.ps1' -ForegroundColor DarkGray
Write-Host ''
