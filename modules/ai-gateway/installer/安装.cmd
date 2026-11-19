@echo off
rem AI Gateway installer launcher (keep ASCII only: cmd + UTF-8 Chinese breaks parsing)
cd /d "%~dp0"
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0install.mjs"
) else (
  node "%~dp0install.mjs"
)
if errorlevel 1 pause
