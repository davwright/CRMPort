@echo off
setlocal

set APP=CRMPort
set INSTALL_DIR=%LOCALAPPDATA%\%APP%
set STARTUP_DIR=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup

echo Installing %APP%...

:: Kill existing CRMPort
echo Stopping existing %APP%...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7700.*LISTENING"') do (
    taskkill /f /pid %%a >nul 2>nul
)

:: Copy files
if not exist "%INSTALL_DIR%" mkdir "%INSTALL_DIR%"
xcopy /s /y /q "%~dp0*" "%INSTALL_DIR%\" >nul
del "%INSTALL_DIR%\install.bat" 2>nul
del "%INSTALL_DIR%\uninstall.bat" 2>nul
copy "%~dp0uninstall.bat" "%INSTALL_DIR%\uninstall.bat" >nul

:: Check Node.js
where node >nul 2>nul
if errorlevel 1 (
    echo ERROR: Node.js not found. Install from https://nodejs.org
    pause
    exit /b 1
)

:: Create startup shortcut
powershell -Command "$ws=New-Object -ComObject WScript.Shell;$s=$ws.CreateShortcut('%STARTUP_DIR%\%APP%.lnk');$s.TargetPath=(Get-Command node).Source;$s.Arguments='\"$env:LOCALAPPDATA\%APP%\main.js\"';$s.WorkingDirectory='%INSTALL_DIR%';$s.WindowStyle=7;$s.Save()"

:: Start now
echo Starting %APP%...
start "" /min node "%INSTALL_DIR%\main.js"

echo.
echo Installed to %INSTALL_DIR%
echo %APP% is running and will start automatically on login.
echo To uninstall, run %INSTALL_DIR%\uninstall.bat
pause
