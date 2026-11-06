@echo off
setlocal
cd /d "%~dp0"

if not exist "servermonitor.exe" (
    echo [错误] 未找到 servermonitor.exe。
    echo         请在绿色包目录（dist\servermonitor）中运行本脚本。
    pause
    exit /b 1
)

if not exist "config\config.yaml" (
    echo [错误] 未找到 config\config.yaml。
    echo         请将 config\config.yaml.example 复制为 config\config.yaml 并填写。
    pause
    exit /b 1
)

echo 正在启动服务器轮询监测看板...
set "DOTENV_ARG="
if exist "config\.env" set "DOTENV_ARG=--dotenv config\.env"
start "" /min servermonitor.exe --config "config\config.yaml" %DOTENV_ARG%
echo 已启动。请稍候用浏览器访问 http://127.0.0.1:8080
endlocal
