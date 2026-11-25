@echo off
rem kolonka CLI: uses node if available, otherwise Kolonka.exe in node mode
where node >nul 2>nul || goto nonode
node "%~dp0kolonka.js" %*
exit /b %ERRORLEVEL%
:nonode
if not exist "%~dp0..\..\Kolonka.exe" (
  echo kolonka: node.js or Kolonka.exe is required 1>&2
  exit /b 1
)
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\Kolonka.exe" "%~dp0kolonka.js" %*
exit /b %ERRORLEVEL%
