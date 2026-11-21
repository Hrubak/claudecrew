@echo off
rem Claude Crew setup wizard. Double-click this file.
title Claude Crew setup
cd /d "%~dp0"
if not exist "%~dp0setup-wizard.js" (
  echo.
  echo The setup wizard can't see its files. If you downloaded a zip, extract it first,
  echo or clone the repo with git, then double-click setup.cmd inside that folder.
  echo.
  pause
  exit /b 1
)
set "NODE_EXE="
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo Checking for Node.js...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-bootstrap.ps1"
  if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
  if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
  if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE_EXE (
  echo Node.js 20 or newer is required. Install it from https://nodejs.org then run setup.cmd again.
  pause
  exit /b 1
)
"%NODE_EXE%" "%~dp0setup-wizard.js" --dir "%~dp0" %*
echo.
echo ^(You can close this window now.^)
pause >nul
