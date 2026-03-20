CRMPort — Local Plugin Server
=============================

Requirements:
  Node.js 20+ (https://nodejs.org)

Install:
  1. Extract this zip to any folder
  2. Run install.bat
  3. Done — CRMPort is running and starts automatically on login

What install.bat does:
  - Copies files to %LOCALAPPDATA%\CRMPort
  - Creates a startup shortcut (no admin needed)
  - Starts CRMPort immediately

Config UI:
  http://localhost:7700/config/

Uninstall:
  Run %LOCALAPPDATA%\CRMPort\uninstall.bat

Logs:
  Open http://localhost:7700/config/ and click the Logs tab

Troubleshooting:
  If CRMPort doesn't start, open a terminal and run:
    node "%LOCALAPPDATA%\CRMPort\main.js"
  to see error output.
