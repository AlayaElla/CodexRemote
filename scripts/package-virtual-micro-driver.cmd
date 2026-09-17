@echo off
setlocal
title Codex Remote - Package Driver
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-virtual-micro-driver.ps1"
set "SCRIPT_EXIT_CODE=%ERRORLEVEL%"
echo.
if "%SCRIPT_EXIT_CODE%"=="0" (
    echo Driver packaging completed successfully.
) else (
    echo Driver packaging failed with exit code %SCRIPT_EXIT_CODE%.
)
echo Press any key to close this window.
pause >nul
exit /b %SCRIPT_EXIT_CODE%
