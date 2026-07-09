@echo off
setlocal
cd /d "%~dp0"
title Whisper Server
python scripts\whisper_server.py
if errorlevel 1 (
  echo.
  echo Whisper server failed to start.
  pause
)
endlocal
