@echo off
setlocal

tasklist | findstr /I "servermonitor.exe" >nul
if errorlevel 1 (
    echo 未检测到正在运行的 servermonitor.exe，无需停止。
) else (
    echo 正在停止服务器轮询监测程序...
    taskkill /IM servermonitor.exe /F
    echo 已停止。
)

pause
endlocal
