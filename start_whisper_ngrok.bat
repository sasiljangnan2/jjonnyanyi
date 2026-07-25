@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title Whisper + ngrok launcher

set "PORT="
for /f "tokens=1,* delims==" %%A in (.env) do (
  if /I "%%~A"=="WHISPER_PORT" set "PORT=%%~B"
)
if not defined PORT set "PORT=8787"

where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  pause
  exit /b 1
)

where ngrok >nul 2>nul
if errorlevel 1 (
  echo [ERROR] ngrok not found in PATH.
  echo Install ngrok and run: ngrok config add-authtoken ^<YOUR_TOKEN^>
  pause
  exit /b 1
)

where ollama >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Ollama not found in PATH.
  echo Install Ollama, then run: ollama pull qwen3:4b
  pause
  exit /b 1
)

ollama list | findstr /I /C:"qwen3:4b" >nul
if errorlevel 1 (
  echo [ERROR] Ollama model qwen3:4b is not installed.
  echo Run this first: ollama pull qwen3:4b
  pause
  exit /b 1
)

echo Starting Whisper server on port %PORT%...
start "Whisper Server" cmd /k "cd /d %~dp0 && python scripts\whisper_server.py"

echo Starting ngrok tunnel on port %PORT%...
start "ngrok Tunnel" cmd /k "ngrok http %PORT%"

echo.
echo Whisper + ngrok started.
echo - Local Whisper API: http://127.0.0.1:%PORT%/transcribe
echo - ngrok dashboard: http://127.0.0.1:4040
echo.
echo After tunnel is ready, set WHISPER_API_URL to:
echo https://YOUR-NGROK-DOMAIN/transcribe
echo.
pause
endlocal
