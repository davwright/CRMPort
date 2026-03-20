@echo off
setlocal

set APP=CRMPort
set INSTALL_DIR=%LOCALAPPDATA%\%APP%
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo Uninstalling %APP%...

:: Kill running process
taskkill /f /im node.exe /fi "WINDOWTITLE eq %APP%*" >nul 2>nul
powershell -Command "Get-Process node -ErrorAction SilentlyContinue | Where-Object {$_.MainModule.FileName -like '*%APP%*'} | Stop-Process -Force" 2>nul

:: Remove startup shortcut
del "%STARTUP_DIR%\%APP%.lnk" 2>nul

:: Remove install directory (defer if locked)
echo Removing %INSTALL_DIR%...
rd /s /q "%INSTALL_DIR%" 2>nul
if exist "%INSTALL_DIR%" (
    echo Some files are locked. They will be removed on next reboot.
    echo rd /s /q "%INSTALL_DIR%" > "%TEMP%\%APP%-cleanup.bat"
    reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce" /v "%APP%Cleanup" /d "%TEMP%\%APP%-cleanup.bat" /f >nul
)

echo.
echo %APP% uninstalled.
pause
