@echo off
title Claude Code Gateway (Claude Pro Subscription)
cd /d "%~dp0"

:: If port 8000 is already in use by another instance, terminate it first
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting Claude Code Gateway...
node server.js
pause
