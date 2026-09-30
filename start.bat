@echo off
chcp 936 >nul
title styling-station 搭配台
cd /d "%~dp0"
node "%~dp0server\server.mjs"
echo.
echo 服务已退出。按任意键关闭窗口...
pause >nul
