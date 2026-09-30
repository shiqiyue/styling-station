@echo off
rem ============================================================
rem  搭配台 - Android APK 构建脚本
rem  产物：dist\搭配台.apk（发到安卓手机直接安装）
rem  改服务器地址：编辑 app\.env 的 SERVER_URL 后重新运行本脚本
rem ============================================================
setlocal
set "ROOT=%~dp0"
set "APP=%ROOT%app"

rem ---------- 本机工具链路径（换机器需改这里） ----------
set "PATH=D:\flutter\bin;%PATH%"
set "JAVA_HOME=D:\java\jdk\corretto-17.0.9"
set "ANDROID_HOME=C:\Users\wuwenyao\AppData\Local\Android\Sdk"

rem ---------- 国内镜像 ----------
set "PUB_HOSTED_URL=https://pub.flutter-io.cn"
set "FLUTTER_STORAGE_BASE_URL=https://storage.flutter-io.cn"

rem ---------- 配置检查 ----------
if not exist "%APP%\.env" (
  echo [错误] 缺少配置文件 app\.env
  echo        请把 app\.env.example 复制为 app\.env，
  echo        并把 SERVER_URL 填成这台机器的内网地址
  pause
  exit /b 1
)

cd /d "%APP%"
echo [1/3] 拉取依赖 ...
call flutter pub get
if errorlevel 1 (
  echo [错误] 依赖拉取失败
  pause
  exit /b 1
)

echo [2/3] 构建 release APK（首次较慢，需下载 Gradle 与安卓依赖）...
call flutter build apk --release --dart-define-from-file=.env
if errorlevel 1 (
  echo [错误] 构建失败，请把上面的报错发给开发者
  pause
  exit /b 1
)

echo [3/3] 拷贝产物 ...
if not exist "%ROOT%dist" mkdir "%ROOT%dist"
copy /y "%APP%\build\app\outputs\flutter-apk\app-release.apk" "%ROOT%dist\搭配台.apk" >nul

echo.
echo ============================================================
echo  完成！APK 在 dist\搭配台.apk
echo  发到安卓手机安装（首次需允许「安装未知应用」）
echo ============================================================
pause
