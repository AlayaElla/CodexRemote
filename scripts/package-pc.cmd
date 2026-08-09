@echo off
setlocal
title Codex Remote - Package PC

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0package-pc.ps1"
set "SCRIPT_EXIT_CODE=%ERRORLEVEL%"

echo.
if "%SCRIPT_EXIT_CODE%"=="0" (
    echo PC packaging completed successfully.
) else (
    echo PC packaging failed with exit code %SCRIPT_EXIT_CODE%.
)
echo Press any key to close this window.
pause >nul
exit /b %SCRIPT_EXIT_CODE%
