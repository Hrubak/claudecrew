@echo off
rem Runs Crew in the background (used by the "Claude Crew" scheduled task, the tray, and setup).
rem Output goes to data\crew.log. If Crew exits, it restarts with backoff. No visible window.
cd /d "%~dp0"
rem Tells Crew this script restarts it, so an in-app update can restart itself.
set CREW_SUPERVISED=1
if not exist data mkdir data
rem Node: NODE_EXE if set, else a private copy next to Crew, else the first node.exe on PATH, else the default install folder.
if not defined NODE_EXE if exist "%~dp0runtime\node\node.exe" set "NODE_EXE=%~dp0runtime\node\node.exe"
if not defined NODE_EXE for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
if not defined NODE_EXE set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"

rem An uninstall writes crew.stop (and data\crew.stop). Exit instead of restarting.
if exist "%~dp0crew.stop" goto :stopflag
if exist "%~dp0data\crew.stop" goto :stopflag

rem Only one run-crew.cmd loop per install. A second copy exits rather than crash-looping.
"%NODE_EXE%" "%~dp0scripts\crew-launcher-lock.js" --acquire > data\crew.lock.tmp 2>> data\crew.log
if errorlevel 2 (
  type data\crew.lock.tmp >> data\crew.log
  echo.>> data\crew.log
  del data\crew.lock.tmp >nul 2>&1
  exit /b 0
)
del data\crew.lock.tmp >nul 2>&1

:loop
if exist "%~dp0crew.stop" goto :stopflag
if exist "%~dp0data\crew.stop" goto :stopflag
for %%F in (data\crew.log) do if %%~zF GTR 5000000 move /y data\crew.log data\crew.old.log >nul

rem If Crew is already answering on its port, do not start a second copy (and do not crash-loop).
"%NODE_EXE%" "%~dp0scripts\crew-port-check.js" > data\crew.port.tmp 2>> data\crew.log
if not errorlevel 1 (
  type data\crew.port.tmp >> data\crew.log
  echo.>> data\crew.log
  del data\crew.port.tmp >nul 2>&1
  exit /b 0
)
del data\crew.port.tmp >nul 2>&1

echo.>> data\crew.log
echo ===== Crew starting %date% %time% =====>> data\crew.log
for /f %%T in ('"%NODE_EXE%" -e "process.stdout.write(String(Date.now()))"') do set "START_MS=%%T"

"%NODE_EXE%" server.js >> data\crew.log 2>&1
set "EXIT=%errorlevel%"
echo ===== Crew exited with code %EXIT% at %date% %time% =====>> data\crew.log

if exist "%~dp0crew.stop" goto :stopflag
if exist "%~dp0data\crew.stop" goto :stopflag

set "WAIT=10"
for /f %%W in ('"%NODE_EXE%" "%~dp0scripts\crew-backoff.js" --started-at %START_MS% --code %EXIT% 2^>^> data\crew.log') do set "WAIT=%%W"
if not defined WAIT set "WAIT=10"
echo ===== restarting in %WAIT% seconds =====>> data\crew.log

rem Wait in this process. Do not use `timeout` — it pops a visible console titled "timeout /t …".
set /a PINGS=%WAIT%+1
ping -n %PINGS% 127.0.0.1 >nul
goto loop

:stopflag
echo ===== stop flag present, not starting =====>> data\crew.log
exit /b 0
