@echo off
title Switch Claude Subscription Account
cd /d "%~dp0"
echo ========================================================
echo   Claude Code Gateway - Switch Claude Account
echo ========================================================
echo.
echo 1. Logging out of current Claude account...
claude auth logout
echo.
echo 2. Opening browser to log in with your new Claude Pro account...
echo    (Select 'Claude subscription' when prompted)
echo.
claude auth login
echo.
echo ========================================================
echo 3. Checking new authentication status:
echo ========================================================
claude auth status
echo.
echo ========================================================
echo Account switched successfully!
echo Please restart start.bat to use the new account.
echo ========================================================
pause
