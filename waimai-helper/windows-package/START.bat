@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 神器外卖助手 - 关闭此窗口会停止本地通知服务
if not exist "runtime\python.exe" (
  echo 请先把整个 ZIP 解压到普通文件夹，再双击 START.bat。
  pause
  exit /b 1
)
echo 正在启动本地助手，无需安装 Python。窗口运行期间请勿关闭。
"runtime\python.exe" -E -s -B -X utf8 "app\app.py"
if errorlevel 1 (
  echo 启动失败。请保留上方错误信息；如果旧版助手仍在运行，请先关闭旧窗口。
  pause
)
