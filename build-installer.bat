@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==============================================
echo   正在打包演出播放器安装包（release + NSIS）
echo   首次或改动较多时需要几分钟，请耐心等待...
echo ==============================================
call npm run build
if errorlevel 1 (
  echo.
  echo 打包失败，请把上面的报错截图发给我。
  pause
  exit /b 1
)
echo.
echo 打包完成！安装包所在文件夹已打开：
echo   src-tauri\target\release\bundle\nsis
explorer "%~dp0src-tauri\target\release\bundle\nsis"
pause
