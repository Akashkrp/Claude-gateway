@echo off
title Stop Claude Gateway
echo Stopping Claude Gateway on port 8000...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :8000 ^| findstr LISTENING') do (
    echo Terminating PID %%a...
    taskkill /F /PID %%a >nul 2>&1
)
echo Claude Gateway stopped.
timeout /t 2 >nul
