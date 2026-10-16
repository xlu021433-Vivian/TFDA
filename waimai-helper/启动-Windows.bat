@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 外卖助手（关闭此窗口=停止软件和定时）

if not exist .venv\Scripts\python.exe goto bootstrap
.venv\Scripts\python --version >nul 2>&1
if not errorlevel 1 goto dependencies

:bootstrap
set "WAIMAI_PYTHON=python"
for /d %%P in (".runtime\cpython-*") do if exist "%%~P\python.exe" set "WAIMAI_PYTHON=%%~P\python.exe"
"%WAIMAI_PYTHON%" --version >nul 2>&1
if errorlevel 1 (
  echo.
  echo  [!] 没有找到 Python。
  echo      请到 https://www.python.org/downloads/ 下载安装，
  echo      安装第一页务必勾选 "Add python.exe to PATH"，装完重新双击本文件。
  echo.
  pause
  exit /b
)

echo 正在创建运行环境...
"%WAIMAI_PYTHON%" -m venv .venv
if errorlevel 1 goto failed

:dependencies
.venv\Scripts\python -c "import flask, yaml, requests, uiautomator2, qrcode; from importlib.metadata import version; assert int(version('flask').split('.')[0]) >= 3; assert int(version('uiautomator2').split('.')[0]) >= 3; assert 8 <= int(version('qrcode').split('.')[0]) < 9" >nul 2>&1
if not errorlevel 1 goto start
echo 正在安装或修复依赖，请稍候...
.venv\Scripts\python -m ensurepip --upgrade
if errorlevel 1 goto failed
.venv\Scripts\python -m pip install -r requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple --disable-pip-version-check
if errorlevel 1 goto failed

:start
set "PYTHONUTF8=1"
.venv\Scripts\python app.py
pause
exit /b

:failed
echo 安装失败，请检查上方错误信息和网络连接，修复后重新双击启动。
pause
exit /b 1
