$Root = Split-Path -Parent $PSScriptRoot
& (Join-Path $Root '.venv\Scripts\python.exe') (Join-Path $PSScriptRoot 'platform_local.py') stop
exit $LASTEXITCODE
