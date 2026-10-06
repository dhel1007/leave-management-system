@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Install Node.js 24 or later before starting Agency Leave.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dependencies are missing. Run npm install once with internet access.
  pause
  exit /b 1
)
if not exist dist\index.html (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo.
echo Agency Leave - local offline workspace
echo Open http://127.0.0.1:3001 in your browser.
echo Keep this window open. Press Ctrl+C to stop.
echo.
call npm start
pause
