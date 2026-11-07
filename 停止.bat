@echo off
setlocal

set "FOUND="
tasklist /FI "IMAGENAME eq servermonitor.exe" 2>nul | findstr /I "servermonitor.exe" >nul
if not errorlevel 1 set "FOUND=1"
tasklist /FI "IMAGENAME eq servermonitor-backend.exe" 2>nul | findstr /I "servermonitor-backend.exe" >nul
if not errorlevel 1 set "FOUND=1"

if not defined FOUND (
    echo 未检测到正在运行的服务器轮询监测工具，无需停止。
    pause
    exit /b 0
)

echo 正在停止服务器轮询监测工具...
taskkill /IM servermonitor.exe /F >nul 2>&1
taskkill /IM servermonitor-backend.exe /F >nul 2>&1
echo 已停止服务器轮询监测工具。
pause
endlocal
