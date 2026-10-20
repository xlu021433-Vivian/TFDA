@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1
if not exist "browser-extension\manifest.json" goto missing
set "browser_path="
set "browser_url="
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" goto edge32
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" goto edge64
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" goto chrome64
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" goto chromeuser
goto open
:edge32
set "browser_path=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
set "browser_url=edge://extensions/"
goto open
:edge64
set "browser_path=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
set "browser_url=edge://extensions/"
goto open
:chrome64
set "browser_path=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
set "browser_url=chrome://extensions/"
goto open
:chromeuser
set "browser_path=%LocalAppData%\Google\Chrome\Application\chrome.exe"
set "browser_url=chrome://extensions/"
:open
if /i "%~1"=="--check" goto check
if exist "INSTALL-HELP.txt" type "INSTALL-HELP.txt"
echo.
echo Extension folder:
echo "%~dp0browser-extension"
start "" "%SystemRoot%\explorer.exe" "%~dp0browser-extension"
if defined browser_path start "" "%browser_path%" "%browser_url%"
if not defined browser_path echo Open chrome://extensions/ or edge://extensions/ in Chrome or Edge.
pause
exit /b 0
:check
echo SHENQI_EXTENSION_OK
echo "%~dp0browser-extension"
echo "%browser_path%"
echo "%browser_url%"
exit /b 0
:missing
echo The extension folder is missing. Please reinstall the complete package.
pause
exit /b 1
