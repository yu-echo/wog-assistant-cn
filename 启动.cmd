@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 山猪 WoG 助手 - 关掉这个窗口即停止服务

echo ==============================================
echo    山猪 WoG 助手
echo    1. 先启动游戏 War of Genesis: Idle Loot
echo    2. 本窗口开着 = 服务在跑
echo    3. 关掉本窗口 = 停止服务
echo ==============================================
echo.

python "%~dp0start.py"
if errorlevel 9009 py -3 "%~dp0start.py"

echo.
echo 服务已停止。
pause
