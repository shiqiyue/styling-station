@echo off
rem ============================================================
rem  搭配台 - Web 构建脚本
rem  产物：app\build\web（服务器检测到它后自动用它提供网页）
rem  回滚旧界面：把 app\build\web 改名或删除后重启服务即可
rem ============================================================
setlocal
set "ROOT=%~dp0"

rem ---------- 本机工具链路径（换机器需改这里） ----------
set "PATH=D:\flutter\bin;%PATH%"

rem ---------- 国内镜像 ----------
set "PUB_HOSTED_URL=https://pub.flutter-io.cn"
set "FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn"

cd /d "%ROOT%app"
echo [1/2] 拉取依赖 ...
call flutter pub get
if errorlevel 1 (
  echo [错误] 依赖拉取失败
  pause
  exit /b 1
)

echo [2/2] 构建 Web（CanvasKit 本地化，不依赖外网 CDN）...
call flutter build web --release --no-web-resources-cdn
if errorlevel 1 (
  echo [错误] 构建失败，请把上面的报错发给开发者
  pause
  exit /b 1
)

echo.
echo ============================================================
echo  完成！产物在 app\build\web
echo  重启服务（start.bat）后，浏览器访问即用新界面
echo ============================================================
pause
