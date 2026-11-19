@echo off
rem AI Gateway uninstaller launcher (keep ASCII only)
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0uninstall.mjs"
) else (
  node "%~dp0uninstall.mjs"
)
