@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动演出播放器（tauri dev）...
npm run dev
pause
