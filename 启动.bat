@echo off
setlocal
cd /d "%~dp0"

if not exist "servermonitor.exe" (
    echo [错误] 未找到 servermonitor.exe。
    echo        请确认已完整解压绿色包，不要单独移动本文件。
    pause
    exit /b 1
)

echo 正在启动 服务器轮询监测工具...
start "" "servermonitor.exe"
echo 已发起启动，主窗口稍后出现；关闭窗口会最小化到系统托盘。
endlocal
