@echo off
title Setup Claude Gateway Auto-Start with Windows
echo ====================================================
echo  Configure Claude Gateway Windows Startup
echo ====================================================
echo.
echo [1] Enable Auto-Start on Windows Boot (runs silently in background)
echo [2] Disable Auto-Start on Windows Boot
echo.
set /p choice="Select option (1 or 2): "

set "STARTUP_FOLDER=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "SHORTCUT_PATH=%STARTUP_FOLDER%\ClaudeGateway.lnk"
set "SCRIPT_PATH=%~dp0start-silent.vbs"

if "%choice%"=="1" (
    powershell -NoProfile -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT_PATH%'); $s.TargetPath = '%SCRIPT_PATH%'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Save()"
    echo.
    echo [SUCCESS] Claude Gateway will now start silently in the background whenever Windows starts!
) else if "%choice%"=="2" (
    if exist "%SHORTCUT_PATH%" (
        del "%SHORTCUT_PATH%"
        echo.
        echo [SUCCESS] Auto-start removed.
    ) else (
        echo.
        echo [INFO] Auto-start shortcut was not present.
    )
) else (
    echo Invalid choice.
)

echo.
pause
