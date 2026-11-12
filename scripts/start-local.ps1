$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Python = Join-Path $Root '.venv\Scripts\python.exe'
if (!(Test-Path $Python)) {
    & py -3.12 -m venv (Join-Path $Root '.venv')
    if ($LASTEXITCODE -ne 0) { throw 'Install Python 3.12 and retry.' }
    & $Python -m pip install -r (Join-Path $Root 'config\experience-baseline-requirements.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
}
& $Python (Join-Path $PSScriptRoot 'platform_local.py') start --open
exit $LASTEXITCODE
