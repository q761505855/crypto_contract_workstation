@echo off
setlocal

cd /d "%~dp0"

where node.exe >nul 2>&1
if errorlevel 1 goto :node_missing

where npm.cmd >nul 2>&1
if errorlevel 1 goto :npm_missing

if not exist "node_modules\" (
  echo [1/2] Installing dependencies...
  call npm.cmd ci
  if errorlevel 1 goto :install_failed
) else (
  echo [1/2] Dependencies already installed. Skipping npm ci.
)

echo [2/2] Starting the development server...
echo Press Ctrl+C to stop it.
echo.

call npm.cmd run dev
set "exit_code=%errorlevel%"

if not "%exit_code%"=="0" (
  echo.
  echo Development server exited with code %exit_code%.
  pause
)

exit /b %exit_code%

:node_missing
echo Node.js was not found.
echo Install Node.js 24 or later, then run this file again.
pause
exit /b 1

:npm_missing
echo npm.cmd was not found.
echo Reinstall Node.js with npm, then run this file again.
pause
exit /b 1

:install_failed
echo.
echo Dependency installation failed.
pause
exit /b 1
