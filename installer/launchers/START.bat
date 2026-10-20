@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 exit /b 1
title Shenqi Waimai - Keep this window open
if not exist "runtime\python.exe" goto missing
if /i "%~1"=="--check" goto check
echo Starting Shenqi Waimai. Keep this window open for local notifications.
"runtime\python.exe" -E -s -B -X utf8 "app\app.py"
if errorlevel 1 goto failed
exit /b 0
:check
"runtime\python.exe" -E -s -B -X utf8 -c "import os,sys;sys.path.insert(0,os.path.join(os.getcwd(),'app'));import app;client=app.app.test_client();assert client.get('/api/health').status_code==200;assert client.get('/').status_code==200;assert client.get('/api/browser-extension.zip').status_code==200;print('SHENQI_START_OK')"
exit /b %errorlevel%
:missing
echo The bundled runtime is missing. Please reinstall the complete package.
pause
exit /b 1
:failed
echo Startup failed. Close any older Shenqi window and try again.
echo Local panel: http://127.0.0.1:8765/
pause
exit /b 1
