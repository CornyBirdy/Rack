@echo off
title Rack
cd /d "%~dp0"
set RACK_SUPERVISOR=1
echo Starting Rack...

:loop
node server.js %*
if %errorlevel%==42 (
  echo.
  echo [Rack] Update applied - restarting...
  echo.
  goto loop
)
if %errorlevel% neq 0 (
  echo.
  echo Rack exited with code %errorlevel%.
  pause
)
