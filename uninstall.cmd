@echo off
rem Uninstall Claude Crew. Double-click this, or use Settings > General > Uninstall.
rem Read-only scan (changes nothing):  uninstall.cmd --scan --json
title Claude Crew uninstall
cd /d "%~dp0"
set "NODE_EXE="
if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE (
  echo Node.js is required to run the uninstaller. Type a path, or install Node from https://nodejs.org
  pause
  exit /b 1
)
echo %* | findstr /i /c:"--scan" >nul
if not errorlevel 1 (
  "%NODE_EXE%" "%~dp0scripts\crew-scan.js" %*
  exit /b %ERRORLEVEL%
)
"%NODE_EXE%" "%~dp0setup-wizard.js" --uninstall --dir "%~dp0." %*
echo.
echo ^(You can close this window now.^)
pause >nul
