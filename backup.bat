@echo off
chcp 936 >nul
title styling-station 备份
cd /d "%~dp0"
setlocal

if not exist "server\data" (
  echo [备份] 未找到 server\data 目录：还没有任何数据，无需备份。
  pause
  exit /b 1
)

for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set TS=%%i
if not exist "backups" mkdir "backups"
set OUT=backups\styling-station-%TS%.zip

where tar >nul 2>nul
if %errorlevel%==0 (
  tar -a -c -f "%OUT%" -C "server\data" .
) else (
  powershell -NoProfile -Command "Compress-Archive -Path 'server\data\*' -DestinationPath '%OUT%' -Force"
)

if exist "%OUT%" (
  echo [备份] 完成：%OUT%
  echo [备份] 该压缩包包含素材、样板、预设、记录与全部图片；还原时解压回 server\data 即可。
) else (
  echo [备份] 失败：请手动复制 server\data 目录。
)
pause
