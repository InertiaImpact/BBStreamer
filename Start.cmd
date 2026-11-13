@echo off
setlocal
cd /d "%~dp0"
where.exe node >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 for Windows and run Start.cmd again.
  pause
  exit /b 1
)
node -e "process.exit(process.versions.node.split('.')[0] === '24' ? 0 : 1)"
if errorlevel 1 (
  echo BBStreamer requires Node.js 24 for Windows.
  pause
  exit /b 1
)
if not exist "node_modules\mqtt\package.json" (
  call npm.cmd ci --ignore-scripts --no-audit --no-fund
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
node "%~dp0src\main.mjs" --open %*
if errorlevel 1 pause
