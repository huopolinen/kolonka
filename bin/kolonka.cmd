@echo off
rem kolonka CLI: uses node if available, otherwise Kolonka.exe in node mode
rem setlocal: ELECTRON_RUN_AS_NODE and the helper variables must not leak into the calling cmd
setlocal
where node >nul 2>nul || goto nonode
node "%~dp0kolonka.js" %*
exit /b %ERRORLEVEL%
:nonode
if not exist "%~dp0..\..\Kolonka.exe" (
  echo kolonka: node.js or Kolonka.exe is required 1>&2
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
rem stream and events run until Ctrl+C, which ends this script before it could restore the code page:
rem leave the console alone for them
if /i "%~1"=="stream" goto run
if /i "%~1"=="events" goto run
rem Kolonka.exe writes UTF-8 bytes to the console, which shows them in its own code page
rem (437, 866 ...) as mojibake. Switch the console to UTF-8 for the call and restore it after.
set "KOLONKA_CP="
for /f "tokens=2 delims=:." %%c in ('chcp') do set "KOLONKA_CP=%%c"
if defined KOLONKA_CP chcp 65001 >nul
"%~dp0..\..\Kolonka.exe" "%~dp0kolonka.js" %*
set "KOLONKA_RC=%ERRORLEVEL%"
if defined KOLONKA_CP chcp %KOLONKA_CP% >nul
exit /b %KOLONKA_RC%
:run
"%~dp0..\..\Kolonka.exe" "%~dp0kolonka.js" %*
exit /b %ERRORLEVEL%
