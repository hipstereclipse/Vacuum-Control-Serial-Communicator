@echo off
title Gauge Serial Communicator
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js was not found on this computer.
  echo   Install the LTS version from https://nodejs.org/ and run this again.
  echo.
  pause
  exit /b 1
)

node "scripts\launch.mjs"

echo.
echo   The Gauge Serial Communicator server has stopped.
echo   You can close this window.
pause >nul
