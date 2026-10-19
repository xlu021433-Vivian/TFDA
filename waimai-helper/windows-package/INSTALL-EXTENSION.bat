@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 浏览器页面打开后：开启开发者模式，点击“加载已解压的扩展程序”。
echo 选择下面这个文件夹（不要选择整个软件目录）：
echo %~dp0browser-extension
start "" explorer.exe "%~dp0browser-extension"
if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" "edge://extensions/"
) else if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
  start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" "edge://extensions/"
) else if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" "chrome://extensions/"
) else (
  echo 请自行在 Chrome 打开 chrome://extensions/ 或在 Edge 打开 edge://extensions/
)
pause
